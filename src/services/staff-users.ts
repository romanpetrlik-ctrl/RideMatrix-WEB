import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../database/connection";

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

/** Initial status for an invited account when the auth schema supports it. */
export const INVITED_USER_STATUS = "Pending";

export type AssignableRole = {
  id: number;
  name: string;
  label: string;
  description: string;
};

export type StaffUserActor = {
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

/** Returns true when the `users` table exposes a `status` column. */
async function hasUserStatusColumn(runner?: Queryable): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_name = 'users'
          AND column_name = 'status'
          AND table_schema = ANY (current_schemas(false))
     ) AS exists`,
    [],
    runner
  );

  return Boolean(result.rows[0]?.exists);
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

  const withStatus = await hasUserStatusColumn();

  try {
    return await withTransaction(async (client) => {
      const inserted = await query<{ id: string; email: string; status: string | null }>(
        withStatus
          ? `INSERT INTO users (email, status) VALUES ($1, $2) RETURNING id, email, status`
          : `INSERT INTO users (email) VALUES ($1) RETURNING id, email, NULL::text AS status`,
        withStatus ? [email, INVITED_USER_STATUS] : [email],
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
