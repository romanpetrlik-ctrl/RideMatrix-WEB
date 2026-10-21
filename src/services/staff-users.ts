import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../database/connection";
import { isValidStaffAccountId, normalizeStaffDisplayName, STAFF_MANAGEMENT_ROLES } from "./staff";
import {
  appendStaffRoleAuditEvent,
  STAFF_ROLE_UPDATE_APPLIED,
  STAFF_ROLE_UPDATE_BLOCKED
} from "./staff-role-audit";

/**
 * Internal staff-user administration on top of the existing authentication
 * tables (`users`, `roles`, `user_roles`, `role_permissions`, `permissions`).
 *
 * This module never creates, migrates, or alters auth tables; it only reads the
 * role catalogue that the authentication service owns and inserts new internal
 * accounts plus their role assignments.
 */

type Queryable = Pool | PoolClient;

/** Roles that belong to the internal staff-management flow, in display order. */
export const INTERNAL_ROLE_ORDER = [
  "superuser",
  "admin",
  "staff",
  "tech_support",
  "driver"
] as const;

/**
 * Roles that are deliberately excluded from the internal invite flow. Customer
 * and partner accounts are onboarded through their own domain flows, not
 * through internal staff administration.
 */
export const EXCLUDED_ROLE_NAMES = ["customer", "partner"] as const;

/** Permission that allows creating/inviting internal accounts. */
export const MANAGE_USERS_PERMISSION = "manage_users";

/** Permission that allows changing/delegating role assignments. */
export const MANAGE_USER_ROLES_PERMISSION = "manage_user_roles";

/** Role that may always manage internal accounts and delegate any role. */
export const SUPERUSER_ROLE = "superuser";
const EXTERNAL_ROLE_NAMES = ["customer", "partner"] as const;
const PRIVILEGED_ROLE_NAMES = ["admin", "superuser"] as const;
const STAFF_ROLE_AUDIT_LIMIT = 100;

function envFlag(name: string): boolean {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

const STAFF_ROLE_POLICY = {
  allowMixedExternalInternal: envFlag("STAFF_ROLE_POLICY_ALLOW_MIXED_INTERNAL_EXTERNAL"),
  allowGenericOpsDriver: envFlag("STAFF_ROLE_POLICY_ALLOW_GENERIC_OPS_DRIVER")
};

/**
 * Initial status for an invited account when `users.status` is a free-form
 * text column (the schema this application ships in `src/database/*`).
 */
export const INVITED_USER_STATUS = "Pending";

/**
 * Status labels that describe an invited, not-yet-active account, in
 * preference order. Production deployments own the auth schema and may model
 * `users.status` as a PostgreSQL enum (`user_status`) whose labels differ from
 * the application default, so the invite flow resolves the label that actually
 * exists instead of assuming `Pending`.
 */
export const INVITED_USER_STATUS_CANDIDATES = [
  "Pending",
  "Invited",
  "Invitation Pending",
  "Pending Invite",
  "Pending Invitation",
  "Pending Activation",
  "Awaiting Activation",
  "Pending Verification",
  "Pending Approval",
  "Registered",
  "New"
] as const;

/** Description of the `users.status` column in the connected database. */
export type UserStatusColumn =
  | { kind: "absent" }
  | { kind: "text" }
  | { kind: "enum"; typeName: string; labels: string[] };

/** Minimal query surface shared with the read-only readiness audit runner. */
export type StatusColumnRunner = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: Record<string, unknown>[] }>;

function normalizeStatusLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Picks the enum label that represents an invited account, or `null` when the
 * enum has no such label. An active/suspended/deleted label is never chosen:
 * an invited account must not silently become an active one.
 */
export function selectInvitedStatusLabel(labels: string[]): string | null {
  const normalized = labels.map((label) => ({ label, key: normalizeStatusLabel(label) }));

  for (const candidate of INVITED_USER_STATUS_CANDIDATES) {
    const key = normalizeStatusLabel(candidate);
    const match = normalized.find((entry) => entry.key === key);

    if (match) {
      return match.label;
    }
  }

  const heuristic = normalized.find(
    (entry) => entry.key.includes("pending") || entry.key.includes("invit")
  );

  return heuristic ? heuristic.label : null;
}

/**
 * Reads the type of `users.status` from the catalogue: absent, a plain text
 * column, or an enum together with its labels.
 */
export async function describeUserStatusColumn(run: StatusColumnRunner): Promise<UserStatusColumn> {
  const result = await run(
    `SELECT t.typtype::text AS typtype,
            t.typname::text AS typname,
            COALESCE(
              ARRAY(
                SELECT e.enumlabel::text
                  FROM pg_enum e
                 WHERE e.enumtypid = t.oid
                 ORDER BY e.enumsortorder
              ),
              ARRAY[]::text[]
            ) AS labels
       FROM pg_attribute a
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = to_regclass('users')
        AND a.attname = 'status'
        AND a.attnum > 0
        AND NOT a.attisdropped`
  );

  const row = result.rows[0];

  if (!row) {
    return { kind: "absent" };
  }

  if (String(row.typtype) !== "e") {
    return { kind: "text" };
  }

  return {
    kind: "enum",
    typeName: String(row.typname),
    labels: (row.labels as string[] | null) ?? []
  };
}

/**
 * Resolves the status value to insert for a newly invited account, or `null`
 * when the account must be inserted without an explicit status (no status
 * column, or an enum without any invited-style label — in which case the
 * column default defined by the auth service applies).
 */
export function resolveInvitedUserStatus(column: UserStatusColumn): string | null {
  if (column.kind === "absent") {
    return null;
  }

  if (column.kind === "text") {
    return INVITED_USER_STATUS;
  }

  return selectInvitedStatusLabel(column.labels);
}

export type AssignableRole = {
  id: number;
  name: string;
  label: string;
  description: string;
};

export type StaffUserActor = {
  userId?: string;
  email: string;
  roles: string[];
  permissions: string[];
};

export type CreatedStaffUser = {
  id: string;
  email: string;
  status: string | null;
  roles: string[];
};

type PgError = Error & {
  code?: string;
  constraint?: string;
};

export class DuplicateStaffUserEmailError extends Error {
  constructor(readonly email: string) {
    super(`An account with email ${email} already exists.`);
    this.name = "DuplicateStaffUserEmailError";
  }
}

export class UnauthorizedRoleDelegationError extends Error {
  constructor(readonly role: string) {
    super(`Role ${role} cannot be delegated by this administrator.`);
    this.name = "UnauthorizedRoleDelegationError";
  }
}

export class UnknownRoleError extends Error {
  constructor(readonly role: string) {
    super(`Role ${role} is not available for internal staff accounts.`);
    this.name = "UnknownRoleError";
  }
}

export class ImmutableRoleError extends Error {
  constructor(readonly role: string) {
    super(`Role ${role} is managed by installation and cannot be changed here.`);
    this.name = "ImmutableRoleError";
  }
}

export class RolePolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RolePolicyViolationError";
  }
}

export function getInternalRoleLabel(role: string): string {
  switch (role) {
    case "superuser":
      return "System Control";
    case "admin":
      return "Administration";
    case "staff":
      return "Staff";
    case "tech_support":
      return "Technical Support";
    case "dispatcher":
      return "Dispatch";
    case "driver":
      return "Driver";
    default:
      return role;
  }
}

function getInternalRoleDescription(role: string): string {
  switch (role) {
    case "superuser":
      return "Full system access, including role delegation and platform controls.";
    case "admin":
      return "Manage operations, staff, drivers, and platform settings.";
    case "staff":
      return "Daily operational tasks in the staff workspace.";
    case "tech_support":
      return "Technical support tools and system monitoring.";
    case "dispatcher":
      return "Dispatch coordination and live operations.";
    case "driver":
      return "Driver workspace and current assignments.";
    default:
      return "Internal workspace access.";
  }
}

/** Normalizes an email the same way the rest of the auth-facing code does. */
export function normalizeUserEmail(email: string | null | undefined): string {
  return String(email || "").trim().toLowerCase();
}

/** Conservative email validation, matching the existing form-level checks. */
export function isValidUserEmail(email: string): boolean {
  if (email.length > 254) {
    return false;
  }

  const parts = email.split("@");

  if (parts.length !== 2) {
    return false;
  }

  const [local, domain] = parts;

  return (
    local.length > 0 &&
    !/\s/.test(local) &&
    domain.length > 0 &&
    !/\s/.test(domain) &&
    domain.includes(".") &&
    !domain.startsWith(".") &&
    !domain.endsWith(".")
  );
}

function isUniqueViolation(error: unknown): error is PgError {
  return (error as PgError)?.code === "23505";
}

/**
 * Returns the internal roles that exist in the current database, excluding
 * customer/partner roles. Ordering follows `INTERNAL_ROLE_ORDER`.
 */
export async function listAssignableRoles(runner?: Queryable): Promise<AssignableRole[]> {
  const result = await query<{ id: number; name: string }>(
    `SELECT id, key AS name FROM roles WHERE key = ANY($1::text[])`,
    [[...INTERNAL_ROLE_ORDER]],
    runner
  );

  return result.rows
    .filter((row) => !EXCLUDED_ROLE_NAMES.includes(row.name as (typeof EXCLUDED_ROLE_NAMES)[number]))
    .sort(
      (a, b) =>
        INTERNAL_ROLE_ORDER.indexOf(a.name as (typeof INTERNAL_ROLE_ORDER)[number]) -
        INTERNAL_ROLE_ORDER.indexOf(b.name as (typeof INTERNAL_ROLE_ORDER)[number])
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      label: getInternalRoleLabel(row.name),
      description: getInternalRoleDescription(row.name)
    }));
}

export async function listUserRolesForAccount(
  accountId: string,
  runner?: Queryable
): Promise<string[] | null> {
  if (!isValidStaffAccountId(accountId)) {
    return null;
  }

  const result = await query<{ role: string }>(
    `SELECT r.key AS role
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.id::text = $1`,
    [accountId],
    runner
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows.map((row) => row.role).filter(Boolean).sort();
}

/** Reads the effective permission names granted by the given role names. */
export async function getPermissionsForRoles(
  roles: string[],
  runner?: Queryable
): Promise<string[]> {
  if (roles.length === 0) {
    return [];
  }

  const result = await query<{ name: string }>(
    `SELECT DISTINCT p.key AS name
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN roles r ON r.id = rp.role_id
      WHERE r.key = ANY($1::text[])`,
    [roles],
    runner
  );

  return result.rows.map((row) => row.name);
}

/** True when the actor may open and use the internal create/invite flow. */
export function canManageStaffUsers(actor: StaffUserActor): boolean {
  return (
    actor.roles.includes(SUPERUSER_ROLE) ||
    actor.permissions.includes(MANAGE_USERS_PERMISSION) ||
    actor.permissions.includes(MANAGE_USER_ROLES_PERMISSION)
  );
}

/**
 * True when the actor may delegate the given role.
 *
 * `superuser` requires either the `superuser` role itself or the explicit
 * `manage_user_roles` permission; every other internal role only requires
 * general staff-user management rights.
 */
export function canDelegateRole(actor: StaffUserActor, role: string): boolean {
  if (!canManageStaffUsers(actor)) {
    return false;
  }

  if (role === SUPERUSER_ROLE) {
    return (
      actor.roles.includes(SUPERUSER_ROLE) ||
      actor.permissions.includes(MANAGE_USER_ROLES_PERMISSION)
    );
  }

  return true;
}

export async function findUserByEmail(
  email: string,
  runner?: Queryable
): Promise<{ id: string; email: string } | undefined> {
  const result = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE lower(email) = $1 LIMIT 1`,
    [normalizeUserEmail(email)],
    runner
  );

  return result.rows[0];
}

export type CreateStaffUserInput = {
  email: string;
  displayName?: string | null;
  roles: string[];
  actor: StaffUserActor;
};

/**
 * Creates an internal account and its role assignments in a single
 * transaction. Role names are validated against the database catalogue and
 * against the actor's delegation rights, so a tampered POST body can never
 * grant a role the administrator is not allowed to delegate.
 */
export async function createStaffUser(input: CreateStaffUserInput): Promise<CreatedStaffUser> {
  const email = normalizeUserEmail(input.email);
  const displayName = normalizeStaffDisplayName(input.displayName);

  if (!isValidUserEmail(email)) {
    throw new Error("A valid email address is required.");
  }

  const requestedRoles = Array.from(new Set(input.roles.map((role) => String(role).trim())));

  if (requestedRoles.length === 0) {
    throw new Error("At least one role must be selected.");
  }

  const assignableRoles = await listAssignableRoles();

  const resolvedRoles = requestedRoles.map((role) => {
    const match = assignableRoles.find((candidate) => candidate.name === role);

    if (!match) {
      throw new UnknownRoleError(role);
    }

    if (!canDelegateRole(input.actor, match.name)) {
      throw new UnauthorizedRoleDelegationError(match.name);
    }

    return match;
  });

  const existing = await findUserByEmail(email);

  if (existing) {
    throw new DuplicateStaffUserEmailError(email);
  }

  const statusColumn = await describeUserStatusColumn((sql, params) =>
    query(sql, params as unknown[])
  );
  const invitedStatus = resolveInvitedUserStatus(statusColumn);
  const returnsStatus = statusColumn.kind !== "absent";

  try {
    return await withTransaction(async (client) => {
      const inserted = await query<{ id: string; email: string; status: string | null }>(
        invitedStatus === null
          ? `INSERT INTO users (email) VALUES ($1) RETURNING id, email, ${
              returnsStatus ? "status" : "NULL::text AS status"
            }`
          : `INSERT INTO users (email, status) VALUES ($1, $2) RETURNING id, email, status`,
        invitedStatus === null ? [email] : [email, invitedStatus],
        client
      );

      const user = inserted.rows[0];

      for (const role of resolvedRoles) {
        await query(
          `INSERT INTO user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [user.id, role.id],
          client
        );
      }

      if (displayName) {
        await query(
          `INSERT INTO staff_profiles (account_id, display_name) VALUES ($1, $2)`,
          [String(user.id), displayName],
          client
        );
      }

      return {
        id: user.id,
        email: user.email,
        status: user.status ?? null,
        roles: resolvedRoles.map((role) => role.name)
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DuplicateStaffUserEmailError(email);
    }

    throw error;
  }
}

export type UpdateStaffUserRolesInput = {
  accountId: string;
  roles: string[];
  actor: StaffUserActor;
  expectedSuperuserMembership?: "present" | "absent";
};

export type UpdatedStaffUserRoles = {
  accountId: string;
  email: string;
  beforeRoles: string[];
  afterRoles: string[];
};

function uniqueRoleList(roles: string[]): string[] {
  return Array.from(new Set(roles.map((role) => String(role).trim()).filter(Boolean))).sort();
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function hasExternalRole(roles: string[]): boolean {
  return roles.some((role) => EXTERNAL_ROLE_NAMES.includes(role as (typeof EXTERNAL_ROLE_NAMES)[number]));
}

function hasInternalManagementRole(roles: string[]): boolean {
  return roles.some((role) => INTERNAL_ROLE_ORDER.includes(role as (typeof INTERNAL_ROLE_ORDER)[number]));
}

function isMixedInternalExternal(roles: string[]): boolean {
  return hasExternalRole(roles) && hasInternalManagementRole(roles);
}

function countIntersection(roles: string[], candidates: readonly string[]): number {
  return roles.filter((role) => candidates.includes(role)).length;
}

function isGenericOpsIdentity(email: string, displayName: string | null): boolean {
  const identity = `${email} ${displayName || ""}`.toLowerCase();
  return /(ops|operations|dispatch|bookings|office|team|shared|generic)/.test(identity);
}

function ensureStaffRolePolicy(beforeRoles: string[], afterRoles: string[], email: string, displayName: string | null) {
  if (!STAFF_ROLE_POLICY.allowGenericOpsDriver && afterRoles.includes("driver") && isGenericOpsIdentity(email, displayName)) {
    throw new RolePolicyViolationError(
      "Driver role assignment is blocked for generic operations accounts by current policy."
    );
  }

  if (!STAFF_ROLE_POLICY.allowMixedExternalInternal && isMixedInternalExternal(afterRoles)) {
    const beforeInternal = countIntersection(beforeRoles, INTERNAL_ROLE_ORDER);
    const beforeExternal = countIntersection(beforeRoles, EXTERNAL_ROLE_NAMES);
    const afterInternal = countIntersection(afterRoles, INTERNAL_ROLE_ORDER);
    const afterExternal = countIntersection(afterRoles, EXTERNAL_ROLE_NAMES);
    const sameAsBefore = arraysEqual(beforeRoles, afterRoles);
    const reducesMixedState = afterInternal < beforeInternal || afterExternal < beforeExternal;
    if (!(sameAsBefore || reducesMixedState)) {
      throw new RolePolicyViolationError(
        "Customer/partner roles cannot be combined with internal staff roles unless policy explicitly allows it."
      );
    }
  }
}

function assertActorCanStillManage(updatedRoles: string[], permissions: string[]): void {
  if (
    updatedRoles.some((role) => PRIVILEGED_ROLE_NAMES.includes(role as (typeof PRIVILEGED_ROLE_NAMES)[number])) ||
    permissions.includes(MANAGE_USERS_PERMISSION) ||
    permissions.includes(MANAGE_USER_ROLES_PERMISSION)
  ) {
    return;
  }

  throw new RolePolicyViolationError(
    "You cannot remove your own last privileged role because this would lock out staff administration."
  );
}

async function appendRoleAudit(
  event: Parameters<typeof appendStaffRoleAuditEvent>[0],
  runner?: Queryable
): Promise<void> {
  try {
    await appendStaffRoleAuditEvent(event, runner);
  } catch (error) {
    console.error("[staff-roles] Failed to persist role audit event:", error);
  }
}

export async function updateStaffUserRoles(input: UpdateStaffUserRolesInput): Promise<UpdatedStaffUserRoles> {
  if (!canManageStaffUsers(input.actor)) {
    await appendRoleAudit({
      eventName: STAFF_ROLE_UPDATE_BLOCKED,
      actorAccountId: input.actor.userId ?? null,
      actorEmail: input.actor.email,
      targetAccountId: input.accountId,
      success: false,
      reason: "unauthorized_actor",
      beforeRoles: [],
      afterRoles: []
    });
    throw new UnauthorizedRoleDelegationError("all");
  }
  if (!isValidStaffAccountId(input.accountId)) {
    throw new Error("Unknown staff account.");
  }

  const requestedRoles = uniqueRoleList(input.roles);
  if (requestedRoles.includes(SUPERUSER_ROLE)) {
    await appendRoleAudit({
      eventName: STAFF_ROLE_UPDATE_BLOCKED,
      actorAccountId: input.actor.userId ?? null,
      actorEmail: input.actor.email,
      targetAccountId: input.accountId,
      success: false,
      reason: "immutable_superuser",
      beforeRoles: [],
      afterRoles: requestedRoles
    });
    throw new ImmutableRoleError(SUPERUSER_ROLE);
  }

  return withTransaction(async (client) => {
    const targetResult = await query<{ id: string; email: string; display_name: string | null }>(
      `SELECT u.id::text AS id, u.email, p.display_name
         FROM users u
         LEFT JOIN staff_profiles p ON p.account_id = u.id::text
        WHERE u.id::text = $1
        FOR UPDATE`,
      [input.accountId],
      client
    );

    const target = targetResult.rows[0];
    if (!target) {
      throw new Error("Unknown staff account.");
    }

    const beforeRoles = uniqueRoleList((await listUserRolesForAccount(input.accountId, client)) ?? []);
    const beforeHasSuperuser = beforeRoles.includes(SUPERUSER_ROLE);
    const expectedMembership =
      input.expectedSuperuserMembership ?? (beforeHasSuperuser ? "present" : "absent");
    if ((expectedMembership === "present") !== beforeHasSuperuser) {
      await appendRoleAudit(
        {
          eventName: STAFF_ROLE_UPDATE_BLOCKED,
          actorAccountId: input.actor.userId ?? null,
          actorEmail: input.actor.email,
          targetAccountId: input.accountId,
          targetEmail: target.email,
          success: false,
          reason: "immutable_superuser",
          beforeRoles,
          afterRoles: requestedRoles
        },
        client
      );
      throw new ImmutableRoleError(SUPERUSER_ROLE);
    }

    const assignableRoles = await listAssignableRoles(client);
    const editableRoles = assignableRoles.filter((role) => role.name !== SUPERUSER_ROLE);
    const editableNames = new Set(editableRoles.map((role) => role.name));
    let afterRoles: string[] = beforeRoles;
    try {
      for (const role of requestedRoles) {
        if (!editableNames.has(role)) {
          throw new UnknownRoleError(role);
        }
        if (!canDelegateRole(input.actor, role)) {
          throw new UnauthorizedRoleDelegationError(role);
        }
      }

      const unmanagedRoles = beforeRoles.filter((role) => !editableNames.has(role));
      afterRoles = uniqueRoleList([...unmanagedRoles, ...requestedRoles]);
      ensureStaffRolePolicy(beforeRoles, afterRoles, target.email, target.display_name);

      if (input.actor.userId && input.actor.userId === input.accountId) {
        const permissions = await getPermissionsForRoles(afterRoles, client);
        assertActorCanStillManage(afterRoles, permissions);
      }
    } catch (error) {
      if (
        error instanceof UnknownRoleError ||
        error instanceof UnauthorizedRoleDelegationError ||
        error instanceof RolePolicyViolationError
      ) {
        await appendRoleAudit(
          {
            eventName: STAFF_ROLE_UPDATE_BLOCKED,
            actorAccountId: input.actor.userId ?? null,
            actorEmail: input.actor.email,
            targetAccountId: input.accountId,
            targetEmail: target.email,
            success: false,
            reason: error.name,
            beforeRoles,
            afterRoles: requestedRoles
          },
          client
        );
      }
      throw error;
    }

    const editableRoleIds = editableRoles.map((role) => role.id);
    if (editableRoleIds.length > 0) {
      await query(
        `DELETE FROM user_roles
          WHERE user_id::text = $1
            AND role_id = ANY($2::int[])`,
        [input.accountId, editableRoleIds],
        client
      );
    }

    if (requestedRoles.length > 0) {
      const resolvedIds = editableRoles
        .filter((role) => requestedRoles.includes(role.name))
        .map((role) => role.id);
      for (const roleId of resolvedIds) {
        await query(
          `INSERT INTO user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [input.accountId, roleId],
          client
        );
      }
    }

    await appendRoleAudit(
      {
        eventName: STAFF_ROLE_UPDATE_APPLIED,
        actorAccountId: input.actor.userId ?? null,
        actorEmail: input.actor.email,
        targetAccountId: input.accountId,
        targetEmail: target.email,
        success: true,
        reason: arraysEqual(beforeRoles, afterRoles) ? "role_update_no_change" : "role_update_saved",
        beforeRoles,
        afterRoles,
        metadata: {
          editableRoleCount: editableRoles.length,
          auditLimit: STAFF_ROLE_AUDIT_LIMIT
        }
      },
      client
    );

    return {
      accountId: input.accountId,
      email: target.email,
      beforeRoles,
      afterRoles
    };
  });
}

export async function updateStaffDisplayName(
  accountId: string,
  value: unknown,
  actor: StaffUserActor,
  runner?: Queryable
): Promise<boolean> {
  if (!canManageStaffUsers(actor)) {
    throw new Error("Staff-user management rights are required.");
  }
  if (!isValidStaffAccountId(accountId)) return false;
  const displayName = normalizeStaffDisplayName(value);
  const result = await query(
    `INSERT INTO staff_profiles (account_id, display_name)
     SELECT u.id::text, $2
     FROM users u
     WHERE u.id::text = $1 AND EXISTS (
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = u.id AND r.key = ANY($3::text[])
     )
     ON CONFLICT (account_id) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING account_id`,
    [accountId, displayName, [...STAFF_MANAGEMENT_ROLES]],
    runner
  );
  return result.rows.length > 0;
}
