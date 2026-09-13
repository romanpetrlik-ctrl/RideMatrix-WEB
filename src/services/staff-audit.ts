import { randomUUID } from "node:crypto";
import { query } from "../database/connection";

export const STAFF_LOGIN_SUCCEEDED = "staff_login_succeeded";
export const STAFF_LOGIN_FAILED = "staff_login_failed";

export type StaffLoginAuditEvent = {
  eventName: typeof STAFF_LOGIN_SUCCEEDED | typeof STAFF_LOGIN_FAILED;
  accountId?: string;
  loginIdentifier?: string;
  success: boolean;
  failureCategory?: "invalid_credentials" | "disabled_account" | "unauthorized" | "blocked" | "system_failure";
  ipAddress?: string;
  userAgent?: string;
};

export async function logStaffLogin(event: StaffLoginAuditEvent): Promise<void> {
  try {
    await query(
      `INSERT INTO staff_login_audit
        (id, occurred_at, event_name, account_id, login_identifier, success, failure_category, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        new Date().toISOString(),
        event.eventName,
        event.accountId ?? null,
        event.loginIdentifier ?? null,
        event.success,
        event.failureCategory ?? null,
        event.ipAddress ?? null,
        event.userAgent ?? null
      ]
    );
  } catch (error) {
    // Audit persistence must not change the authentication response or redirect.
    console.error("[staff-audit] Failed to persist login event:", error);
  }
}
