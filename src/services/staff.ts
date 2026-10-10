import type { Pool, PoolClient } from "pg";
import { getPool } from "../database/connection";
import { STAFF_LOGIN_SUCCEEDED } from "./staff-audit";

type Queryable = Pool | PoolClient;

/**
 * Internal auth roles that identify a user as staff (as opposed to a
 * customer or partner). Users assigned only "customer" and/or "partner"
 * roles must never appear in the staff list.
 */
export const STAFF_MANAGEMENT_ROLES = [
  "admin",
  "superuser",
  "staff",
  "tech_support",
  "driver"
] as const;

const MANAGE_USERS_PERMISSION = "manage_users";

/**
 * Candidate column names for a "last login" timestamp on `users`. The
 * production schema is owned by a separate auth service, so this list is
 * probed at runtime via `information_schema` instead of being assumed.
 */
const LAST_LOGIN_COLUMN_CANDIDATES = [
  "last_login_at",
  "last_login",
  "last_sign_in_at",
  "last_signed_in_at"
];

export type StaffRecord = {
  id: string;
  email: string;
  status: string | null;
  roles: string[];
  createdAt: string | null;
  lastLoginAt: string | null;
};

let cachedLastLoginColumn: string | null | undefined;

/**
 * Detects whether the existing `users` table exposes a last-login style
 * column. Result is cached for the lifetime of the process/pool.
 */
async function resolveLastLoginColumn(runner: Queryable): Promise<string | null> {
  if (cachedLastLoginColumn !== undefined) {
    return cachedLastLoginColumn;
  }

  const result = await runner.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'users'`
  );

  const columns = new Set(result.rows.map((row) => row.column_name));
  cachedLastLoginColumn =
    LAST_LOGIN_COLUMN_CANDIDATES.find((candidate) => columns.has(candidate)) ?? null;

  return cachedLastLoginColumn;
}

/**
 * Resets the cached last-login column lookup. Only used by tests, which
 * create a fresh schema (and therefore a fresh `users` table) per run.
 */
export function resetStaffSchemaCacheForTests(): void {
  cachedLastLoginColumn = undefined;
}

/**
 * Accepted shape for a staff account identifier taken from a URL. The auth
 * tables are owned externally, so ids are compared as text; this guard keeps
 * arbitrary input (paths, SQL fragments, very long strings) away from queries.
 */
const STAFF_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidStaffAccountId(value: unknown): value is string {
  return typeof value === "string" && STAFF_ACCOUNT_ID_PATTERN.test(value);
}

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Picks the most recent valid timestamp. Used to combine the optional
 * `users` last-login column with the latest successful `staff_login_audit`
 * event so the directory never shows "Never" while audit rows exist.
 */
function latestTimestamp(...values: Array<string | Date | null | undefined>): string | null {
  let latest: string | null = null;

  for (const value of values) {
    const iso = toIsoOrNull(value);
    if (iso && (!latest || iso > latest)) {
      latest = iso;
    }
  }

  return latest;
}

/**
 * Canonical `Date#toISOString()` shape written by `logStaffLogin`. Values in
 * this shape sort chronologically as text, so they can be compared and
 * ordered without a `::timestamptz` cast that would throw on malformed rows.
 */
const CANONICAL_AUDIT_TIMESTAMP_PATTERN =
  "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$";

const CANONICAL_AUDIT_TIMESTAMP_REGEX = new RegExp(CANONICAL_AUDIT_TIMESTAMP_PATTERN);

/**
 * SQL predicate matching `staff_login_audit` rows (alias `a`) that belong to
 * one user: by account id, or — only for events recorded without an account
 * id — by normalized email address. Shared by the directory and history
 * queries so both always agree on ownership.
 */
function auditBelongsToUserSql(accountIdExpr: string, emailExpr: string): string {
  return `(
    a.account_id = ${accountIdExpr}
    OR (a.account_id IS NULL AND lower(btrim(a.login_identifier)) = lower(btrim(${emailExpr})))
  )`;
}

async function queryStaffUsers(runner: Queryable, accountId?: string): Promise<StaffRecord[]> {
  const lastLoginColumn = await resolveLastLoginColumn(runner);
  const lastLoginSelect = lastLoginColumn
    ? `u."${lastLoginColumn}"`
    : "NULL::timestamp";
  const params: unknown[] = [
    Array.from(STAFF_MANAGEMENT_ROLES),
    STAFF_LOGIN_SUCCEEDED,
    CANONICAL_AUDIT_TIMESTAMP_PATTERN
  ];
  let accountFilter = "";

  if (accountId !== undefined) {
    params.push(accountId);
    accountFilter = "AND u.id::text = $4";
  }

  const result = await runner.query<{
    id: string;
    email: string;
    status: string | null;
    created_at: string | Date | null;
    last_login_at: string | Date | null;
    audit_last_login_at: string | Date | null;
    roles: string[];
  }>(
    `SELECT
       u.id,
       u.email,
       u.status,
       u.created_at,
       ${lastLoginSelect} AS last_login_at,
       (
         SELECT max(a.occurred_at)
         FROM staff_login_audit a
         WHERE a.success = TRUE
           AND a.event_name = $2
           AND a.occurred_at ~ $3
           AND ${auditBelongsToUserSql("u.id::text", "u.email")}
       ) AS audit_last_login_at,
       array_agg(DISTINCT r.key ORDER BY r.key) AS roles
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.id IN (
       SELECT ur2.user_id
       FROM user_roles ur2
       JOIN roles r2 ON r2.id = ur2.role_id
       WHERE r2.key = ANY($1)
     )
     ${accountFilter}
     GROUP BY u.id
     ORDER BY lower(u.email) ASC`,
    params
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    email: row.email,
    status: row.status,
    roles: row.roles,
    createdAt: toIsoOrNull(row.created_at),
    lastLoginAt: latestTimestamp(row.last_login_at, row.audit_last_login_at)
  }));
}

/**
 * Lists internal staff users (anyone holding at least one role from
 * `STAFF_MANAGEMENT_ROLES`) from the existing auth tables (`users`,
 * `roles`, `user_roles`). Users who are only assigned `customer` and/or
 * `partner` roles are excluded. Every matching user appears exactly once,
 * with all of their assigned roles (not just the staff-qualifying ones).
 *
 * `lastLoginAt` is the most recent of the optional `users` last-login
 * column and the latest successful `staff_login_audit` event for the user.
 */
export async function listStaffUsers(client?: Queryable): Promise<StaffRecord[]> {
  return queryStaffUsers(client || getPool());
}

/**
 * Loads a single internal staff user by id. Returns `null` for malformed
 * ids, unknown users, and users without an internal staff role.
 */
export async function getStaffUser(accountId: string, client?: Queryable): Promise<StaffRecord | null> {
  if (!isValidStaffAccountId(accountId)) {
    return null;
  }

  const rows = await queryStaffUsers(client || getPool(), accountId);
  return rows[0] ?? null;
}

export type StaffLoginAuditRecord = {
  id: string;
  occurredAt: string | null;
  eventName: string;
  success: boolean;
  failureCategory: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

export const STAFF_LOGIN_AUDIT_PAGE_LIMIT = 200;

/**
 * Returns the most recent login audit events for exactly one staff account,
 * matched by account id or (for events without an account id) by normalized
 * email. Only display-safe columns are selected.
 */
export async function listStaffLoginAuditEvents(
  staff: Pick<StaffRecord, "id" | "email">,
  client?: Queryable
): Promise<StaffLoginAuditRecord[]> {
  const runner = client || getPool();
  const result = await runner.query<{
    id: string;
    occurred_at: string;
    event_name: string;
    success: boolean;
    failure_category: string | null;
    ip_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT a.id, a.occurred_at, a.event_name, a.success, a.failure_category, a.ip_address, a.user_agent
     FROM staff_login_audit a
     WHERE ${auditBelongsToUserSql("$1", "$2")}
     ORDER BY (a.occurred_at ~ $4) DESC, a.occurred_at DESC, a.id DESC
     LIMIT $3`,
    [String(staff.id), staff.email, STAFF_LOGIN_AUDIT_PAGE_LIMIT, CANONICAL_AUDIT_TIMESTAMP_PATTERN]
  );

  return result.rows.map((row) => ({
    id: row.id,
    occurredAt: CANONICAL_AUDIT_TIMESTAMP_REGEX.test(row.occurred_at) ? toIsoOrNull(row.occurred_at) : null,
    eventName: row.event_name,
    success: Boolean(row.success),
    failureCategory: row.failure_category,
    ipAddress: row.ip_address,
    userAgent: row.user_agent
  }));
}

/**
 * Checks whether any of the given (session) role names grants the
 * `manage_users` permission via `role_permissions` / `permissions`. Falls
 * back to `false` (never silently authorizes) if the permission tables are
 * unavailable; callers combine this with an admin/superuser role fallback.
 */
export async function hasManageUsersPermission(
  roles: string[],
  client?: Queryable
): Promise<boolean> {
  if (!Array.isArray(roles) || roles.length === 0) {
    return false;
  }

  const runner = client || getPool();

  try {
    const result = await runner.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE r.key = ANY($1) AND p.key = $2
       ) AS allowed`,
      [roles, MANAGE_USERS_PERMISSION]
    );

    return Boolean(result.rows[0]?.allowed);
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError?.code !== "42P01") {
      console.error(
        "[staff] Failed to evaluate manage_users permission; falling back to admin/superuser role check:",
        error
      );
    }
    return false;
  }
}

/**
 * Authorization gate for staff management: prefers the `manage_users`
 * permission when the permission tables are available, with a documented
 * safe fallback to the repository's admin/superuser role model.
 */
export async function canManageStaff(roles: string[], client?: Queryable): Promise<boolean> {
  const roleList = Array.isArray(roles) ? roles : [];

  if (roleList.includes("admin") || roleList.includes("superuser")) {
    return true;
  }

  return hasManageUsersPermission(roleList, client);
}
