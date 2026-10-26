import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { QueryResultRow } from "pg";
import {
  consumeBookingAuthorizationToken,
  getBookingAuthorizationTokenStatus,
  issueBookingAuthorizationRequest,
  type BookingAuthorizationStatus,
  type Queryable
} from "./booking-authorization";

function fakeDatabase() {
  const rows = new Map<string, { status: BookingAuthorizationStatus; expiresAt: Date }>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let required = true;
  let channel: string | null = "both";
  const runner: Queryable = {
    async query<R extends QueryResultRow>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      let result: QueryResultRow[] = [];
      if (sql.includes("WITH eligible")) {
        const selected = values[3] ?? (channel === "both" ? "email" : channel);
        if (required && values[0] === "business" && values[1] === "booking" &&
            channel && (channel === "both" || channel === selected)) {
          rows.set(String(values[4]), { status: "pending", expiresAt: values[5] as Date });
          result = [{ id: values[2], expires_at: values[5], channel: selected }];
        }
      } else {
        const row = rows.get(String(values[0]));
        if (sql.startsWith("UPDATE")) {
          if (row?.status === "pending") {
            row.status = row.expiresAt.getTime() <= Date.now()
              ? "expired" : values[1] as BookingAuthorizationStatus;
            result = [{ status: row.status }];
          }
        } else if (row) {
          result = [{ status: row.status === "pending" && row.expiresAt.getTime() <= Date.now()
            ? "expired" : row.status }];
        }
      }
      return { rows: result as R[], rowCount: result.length, command: "", oid: 0, fields: [] };
    }
  };
  return { runner, rows, calls, policy: (authRequired: boolean, allowed: string | null) => {
    required = authRequired;
    channel = allowed;
  } };
}

test("issue stores only SHA256 of a unique high-entropy token, scoped to the required business booking", async () => {
  const db = fakeDatabase();
  const first = await issueBookingAuthorizationRequest({ customerId: "business", bookingId: "booking" }, db.runner);
  const second = await issueBookingAuthorizationRequest({
    customerId: "business", bookingId: "booking", channel: "whatsapp"
  }, db.runner);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first.token, "base64url").length, 32);
  assert.notEqual(first.token, second.token);
  assert.equal(first.channel, "email");
  assert.equal(second.channel, "whatsapp");
  assert.equal(db.calls[0].values[4], createHash("sha256").update(first.token).digest("hex"));
  assert.ok(db.calls.every(call => !JSON.stringify(call).includes(first.token)));
  assert.match(db.calls[0].sql, /cb.customer_id = bc.customer_id/);
  assert.match(db.calls[0].sql, /cb.id = \$2/);
  assert.match(db.calls[0].sql, /booking_auth_required = TRUE/);
  assert.equal(await getBookingAuthorizationTokenStatus(first.token, db.runner), "pending");
});

test("issuance rejects missing/wrong bookings, disabled authorization, missing/disallowed channels and expiry bounds", async () => {
  const db = fakeDatabase();
  for (const input of [
    { customerId: "other-business", bookingId: "booking" },
    { customerId: "business", bookingId: "missing" },
    { customerId: "business", bookingId: "booking", expiresAt: new Date(0) },
    { customerId: "business", bookingId: "booking", expiresAt: new Date(Date.now() + 8 * 86400000) },
    { customerId: "business", bookingId: "booking", expiresAt: new Date(NaN) }
  ]) await assert.rejects(issueBookingAuthorizationRequest(input, db.runner));
  db.policy(false, "email");
  await assert.rejects(issueBookingAuthorizationRequest({ customerId: "business", bookingId: "booking" }, db.runner));
  db.policy(true, null);
  await assert.rejects(issueBookingAuthorizationRequest({ customerId: "business", bookingId: "booking" }, db.runner));
  db.policy(true, "email");
  await assert.rejects(issueBookingAuthorizationRequest({
    customerId: "business", bookingId: "booking", channel: "whatsapp"
  }, db.runner));
  const issued = await issueBookingAuthorizationRequest({
    customerId: "business", bookingId: "booking", expiresAt: new Date(Date.now() + 120000)
  }, db.runner);
  assert.equal(issued.channel, "email");
});

for (const decision of ["approved", "declined"] as const) {
  test(`token can be ${decision} once and neither repeated nor opposite decisions overwrite it`, async () => {
    const db = fakeDatabase();
    const issued = await issueBookingAuthorizationRequest({ customerId: "business", bookingId: "booking" }, db.runner);
    assert.deepEqual(await consumeBookingAuthorizationToken(issued.token, decision, db.runner), {
      status: decision, outcome: "decided"
    });
    for (const repeated of ["approved", "declined"] as const) {
      assert.deepEqual(await consumeBookingAuthorizationToken(issued.token, repeated, db.runner), {
        status: decision, outcome: "already_decided"
      });
    }
    assert.equal(await getBookingAuthorizationTokenStatus(issued.token, db.runner), decision);
    const update = db.calls.find(call => call.sql.startsWith("UPDATE"))!.sql;
    assert.match(update, /WHERE token_hash = \$1 AND status = 'pending'/);
    assert.match(update, /expires_at <= CURRENT_TIMESTAMP THEN 'expired'/);
    assert.match(update, /decided_at = CASE WHEN expires_at > CURRENT_TIMESTAMP/);
  });
}

test("expiry is read-only on inspection and terminal on consumption", async () => {
  const db = fakeDatabase();
  const issued = await issueBookingAuthorizationRequest({ customerId: "business", bookingId: "booking" }, db.runner);
  const row = [...db.rows.values()][0];
  row.expiresAt = new Date(0);
  assert.equal(await getBookingAuthorizationTokenStatus(issued.token, db.runner), "expired");
  assert.equal(row.status, "pending");
  assert.deepEqual(await consumeBookingAuthorizationToken(issued.token, "approved", db.runner), {
    status: "expired", outcome: "expired"
  });
  assert.equal(row.status, "expired");
  assert.deepEqual(await consumeBookingAuthorizationToken(issued.token, "declined", db.runner), {
    status: "expired", outcome: "expired"
  });
});

test("malformed and unknown tokens produce generic invalid results", async () => {
  const db = fakeDatabase();
  for (const token of ["", "not-a-token", "x".repeat(1000), "a".repeat(43)]) {
    assert.equal(await getBookingAuthorizationTokenStatus(token, db.runner), "invalid");
    assert.deepEqual(await consumeBookingAuthorizationToken(token, "approved", db.runner), {
      status: "invalid", outcome: "invalid"
    });
  }
  assert.equal(db.calls.length, 3);
  assert.equal(await getBookingAuthorizationTokenStatus("invalid"), "invalid");
  assert.deepEqual(await consumeBookingAuthorizationToken("invalid", "declined"), {
    status: "invalid", outcome: "invalid"
  });
});
