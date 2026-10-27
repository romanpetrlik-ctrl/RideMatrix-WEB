import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { getPool } from "../database/connection";

export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
};
export type BookingAuthorizationChannel = "email" | "whatsapp";
export type BookingAuthorizationDecision = "approved" | "declined";
export type BookingAuthorizationStatus = "pending" | BookingAuthorizationDecision | "expired" | "invalid";
export type BookingAuthorizationResult = {
  status: Exclude<BookingAuthorizationStatus, "pending">;
  outcome: "decided" | "already_decided" | "expired" | "invalid";
};

const DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_LIFETIME_MS = 7 * DEFAULT_LIFETIME_MS;
const validToken = (token: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(token);
const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export async function issueBookingAuthorizationRequest(
  input: {
    customerId: string;
    bookingId: string;
    channel?: BookingAuthorizationChannel;
    expiresAt?: Date;
  },
  runner?: Queryable
): Promise<{ id: string; token: string; channel: BookingAuthorizationChannel; expiresAt: Date }> {
  const now = Date.now();
  const expiresAt = input.expiresAt ?? new Date(now + DEFAULT_LIFETIME_MS);
  const lifetime = expiresAt instanceof Date ? expiresAt.getTime() - now : NaN;
  if (!Number.isFinite(lifetime) || lifetime < 60_000 || lifetime > MAX_LIFETIME_MS) {
    throw new Error("Authorization expiry must be between one minute and seven days from now.");
  }
  if (!input.customerId || !input.bookingId ||
      (input.channel !== undefined && input.channel !== "email" && input.channel !== "whatsapp")) {
    throw new Error("Booking authorization cannot be issued.");
  }

  const token = randomBytes(32).toString("base64url");
  const result = await (runner ?? getPool()).query<{
    id: string; expires_at: Date; channel: BookingAuthorizationChannel;
  }>(
    `WITH eligible AS (
       SELECT bc.customer_id, cb.id AS booking_id,
              COALESCE($4::text, CASE WHEN bc.booking_auth_channel = 'both'
                                    THEN 'email' ELSE bc.booking_auth_channel END) AS channel
       FROM business_customers bc
       JOIN customer_bookings cb ON cb.customer_id = bc.customer_id
       WHERE bc.customer_id = $1 AND cb.id = $2 AND bc.booking_auth_required = TRUE
         AND bc.booking_auth_channel IN ('email', 'whatsapp', 'both')
         AND ($4::text IS NULL OR bc.booking_auth_channel IN ($4::text, 'both'))
     ), inserted AS (
       INSERT INTO booking_authorization_requests
         (id, customer_id, booking_id, token_hash, status, expires_at, created_at, updated_at)
       SELECT $3, customer_id, booking_id, $5, 'pending', $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       FROM eligible
       RETURNING id, expires_at
     )
     SELECT inserted.id, inserted.expires_at, eligible.channel FROM inserted CROSS JOIN eligible`,
    [input.customerId, input.bookingId, randomUUID(), input.channel ?? null, hashToken(token), expiresAt]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Booking authorization cannot be issued.");
  }
  return { id: row.id, token, channel: row.channel, expiresAt: new Date(row.expires_at) };
}

/** Read-only: messaging link scanners must never consume or expire a request. */
export async function getBookingAuthorizationTokenStatus(
  token: string,
  runner?: Queryable
): Promise<BookingAuthorizationStatus> {
  if (!validToken(token)) return "invalid";
  const result = await (runner ?? getPool()).query<{ status: Exclude<BookingAuthorizationStatus, "invalid"> }>(
    `SELECT CASE WHEN status = 'pending' AND expires_at <= CURRENT_TIMESTAMP
                 THEN 'expired' ELSE status END AS status
     FROM booking_authorization_requests WHERE token_hash = $1`,
    [hashToken(token)]
  );
  return result.rows[0]?.status ?? "invalid";
}

export async function consumeBookingAuthorizationToken(
  token: string,
  decision: BookingAuthorizationDecision,
  runner?: Queryable
): Promise<BookingAuthorizationResult> {
  if (!validToken(token) || (decision !== "approved" && decision !== "declined")) {
    return { status: "invalid", outcome: "invalid" };
  }
  // One conditional write arbitrates simultaneous, conflicting decisions.
  // The delivery channel is not proof of which transport a forwarded bearer link used.
  const result = await (runner ?? getPool()).query<{ status: BookingAuthorizationDecision | "expired" }>(
    `UPDATE booking_authorization_requests
     SET status = CASE WHEN expires_at <= CURRENT_TIMESTAMP THEN 'expired' ELSE $2 END,
         decided_at = CASE WHEN expires_at > CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP ELSE NULL END,
         decided_by_channel = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE token_hash = $1 AND status = 'pending'
     RETURNING status`,
    [hashToken(token), decision]
  );
  const status = result.rows[0]?.status;
  if (status) {
    return { status, outcome: status === "expired" ? "expired" : "decided" };
  }
  // A separate statement sees a concurrent winner after UPDATE waits for its lock.
  const existing = await getBookingAuthorizationTokenStatus(token, runner);
  if (existing === "approved" || existing === "declined") {
    return { status: existing, outcome: "already_decided" };
  }
  return existing === "expired"
    ? { status: "expired", outcome: "expired" }
    : { status: "invalid", outcome: "invalid" };
}
