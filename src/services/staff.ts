import type { Pool, PoolClient } from "pg";
import { getPool } from "../database/connection";

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
  "dispatcher",
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
 * Lists internal staff users (anyone holding at least one role from
 * `STAFF_MANAGEMENT_ROLES`) from the existing auth tables (`users`,
 * `roles`, `user_roles`). Users who are only assigned `customer` and/or
 * `partner` roles are excluded. Every matching user appears exactly once,
 * with all of their assigned roles (not just the staff-qualifying ones).
 */
export async function listStaffUsers(client?: Queryable): Promise<StaffRecord[]> {
  const runner = client || getPool();
  const lastLoginColumn = await resolveLastLoginColumn(runner);
  const lastLoginSelect = lastLoginColumn
    ? `u."${lastLoginColumn}"`
    : "NULL::timestamp";

  const result = await runner.query<{
    id: string;
    email: string;
    status: string | null;
    created_at: string | Date | null;
    last_login_at: string | Date | null;
    roles: string[];
  }>(
    `SELECT
       u.id,
       u.email,
       u.status,
       u.created_at,
       ${lastLoginSelect} AS last_login_at,
       array_agg(DISTINCT r.name ORDER BY r.name) AS roles
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.id IN (
       SELECT ur2.user_id
       FROM user_roles ur2
       JOIN roles r2 ON r2.id = ur2.role_id
       WHERE r2.name = ANY($1)
     )
     GROUP BY u.id
     ORDER BY lower(u.email) ASC`,
    [Array.from(STAFF_MANAGEMENT_ROLES)]
  );

  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    status: row.status,
    roles: row.roles,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null
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
         WHERE r.name = ANY($1) AND p.name = $2
       ) AS allowed`,
      [roles, MANAGE_USERS_PERMISSION]
    );

    return Boolean(result.rows[0]?.allowed);
  } catch (error) {
    console.error(
      "[staff] Failed to evaluate manage_users permission; falling back to admin/superuser role check:",
      error
    );
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
