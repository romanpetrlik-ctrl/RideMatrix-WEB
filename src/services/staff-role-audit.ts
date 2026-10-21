import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { query } from "../database/connection";

type Queryable = Pool | PoolClient;

export const STAFF_ROLE_UPDATE_APPLIED = "staff_role_update_applied";
export const STAFF_ROLE_UPDATE_BLOCKED = "staff_role_update_blocked";

export type StaffRoleAuditEvent = {
  eventName: typeof STAFF_ROLE_UPDATE_APPLIED | typeof STAFF_ROLE_UPDATE_BLOCKED;
  actorAccountId?: string | null;
  actorEmail?: string | null;
  targetAccountId?: string | null;
  targetEmail?: string | null;
  success: boolean;
  reason: string;
  beforeRoles: string[];
  afterRoles: string[];
  metadata?: Record<string, unknown>;
};

export type StaffRoleAuditRecord = {
  id: string;
  occurredAt: string | null;
  eventName: string;
  success: boolean;
  reason: string;
  actorEmail: string | null;
  beforeRoles: string[];
  afterRoles: string[];
};

const CANONICAL_AUDIT_TIMESTAMP_REGEX =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function appendStaffRoleAuditEvent(
  event: StaffRoleAuditEvent,
  runner?: Queryable
): Promise<void> {
  await query(
    `INSERT INTO staff_role_change_audit
      (id, occurred_at, event_name, actor_account_id, actor_email, target_account_id, target_email, success, reason, before_roles, after_roles, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)`,
    [
      randomUUID(),
      new Date().toISOString(),
      event.eventName,
      event.actorAccountId ?? null,
      event.actorEmail ?? null,
      event.targetAccountId ?? null,
      event.targetEmail ?? null,
      event.success,
      event.reason,
      JSON.stringify(event.beforeRoles),
      JSON.stringify(event.afterRoles),
      JSON.stringify(event.metadata ?? {})
    ],
    runner
  );
}

export async function listStaffRoleAuditEvents(
  accountId: string,
  limit: number,
  runner?: Queryable
): Promise<StaffRoleAuditRecord[]> {
  const result = await query<{
    id: string;
    occurred_at: string;
    event_name: string;
    success: boolean;
    reason: string;
    actor_email: string | null;
    before_roles: string[] | null;
    after_roles: string[] | null;
  }>(
    `SELECT id, occurred_at, event_name, success, reason, actor_email, before_roles, after_roles
       FROM staff_role_change_audit
      WHERE target_account_id = $1
      ORDER BY occurred_at DESC, id DESC
      LIMIT $2`,
    [accountId, limit],
    runner
  );

  return result.rows.map((row) => ({
    id: row.id,
    occurredAt: CANONICAL_AUDIT_TIMESTAMP_REGEX.test(row.occurred_at) ? toIsoOrNull(row.occurred_at) : null,
    eventName: row.event_name,
    success: Boolean(row.success),
    reason: row.reason,
    actorEmail: row.actor_email,
    beforeRoles: Array.isArray(row.before_roles) ? row.before_roles : [],
    afterRoles: Array.isArray(row.after_roles) ? row.after_roles : []
  }));
}
