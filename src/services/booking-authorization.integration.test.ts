import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { getPool, initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, type TestDatabaseContext } from "../database/test-helper";
import { createBusinessCustomer, validateBusinessCustomer } from "./business-customers";
import { createCustomer } from "./customers";
import {
  consumeBookingAuthorizationToken,
  getBookingAuthorizationTokenStatus,
  issueBookingAuthorizationRequest
} from "./booking-authorization";

let context: TestDatabaseContext | undefined;
let customerId: string;
before(async () => {
  context = await createTestDatabaseContext("test_booking_authorization");
  await context.createAuthTables();
  await initializeDatabase();
  const business = validateBusinessCustomer({
    registeredName: "Authorization Test Ltd",
    registeredHouseNameNumber: "12", registeredAddressLine1: "High Street",
    registeredCityTown: "Dorchester", registeredPostcode: "DT1 1AA",
    registeredCountry: "United Kingdom",
    officePhone: "020 7946 0958", officeEmail: "authorization@example.com",
    bookerFullName: "Alex Booker", bookerEmail: "booker@example.com", bookerPhone: "+44 7911 123456",
    accountsFullName: "Finance Team", accountsEmail: "finance@example.com", accountsPhone: "",
    bookingAuthRequired: "yes", bookingAuthChannel: "both"
  });
  assert.ok(business.input, business.errors.join("; "));
  customerId = (await createBusinessCustomer(business.input)).id;
  await query(`INSERT INTO customer_bookings
    (id, customer_id, reference, service_date, pickup, dropoff, status, created_at)
    VALUES ('authorization-booking', $1, 'AUTH-TEST', '2026-10-26', 'Office', 'Station',
            'Scheduled', CURRENT_TIMESTAMP::text)`, [customerId]);
});
after(async () => safeCleanupTestDatabase(context));

test("PostgreSQL issuance is scoped, hashed, read-only on GET inspection, and terminal for both decisions", async () => {
  for (const decision of ["approved", "declined"] as const) {
    const issued = await issueBookingAuthorizationRequest({
      customerId, bookingId: "authorization-booking", channel: "whatsapp"
    }, getPool());
    assert.equal(issued.channel, "whatsapp");
    const stored = (await query("SELECT * FROM booking_authorization_requests WHERE id = $1", [issued.id])).rows[0];
    assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(stored).includes(issued.token));
    assert.equal(stored.decided_at, null);
    assert.equal(await getBookingAuthorizationTokenStatus(issued.token, getPool()), "pending");
    assert.deepEqual(await consumeBookingAuthorizationToken(issued.token, decision, getPool()), {
      status: decision, outcome: "decided"
    });
    const decided = (await query("SELECT * FROM booking_authorization_requests WHERE id = $1", [issued.id])).rows[0];
    assert.ok(decided.decided_at instanceof Date);
    const opposite = decision === "approved" ? "declined" : "approved";
    assert.deepEqual(await consumeBookingAuthorizationToken(issued.token, opposite, getPool()), {
      status: decision, outcome: "already_decided"
    });
  }
});

test("PostgreSQL expiry cannot approve; missing and wrong-customer bookings and channels cannot issue", async () => {
  const issued = await issueBookingAuthorizationRequest({ customerId, bookingId: "authorization-booking" });
  await query("UPDATE booking_authorization_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1",
    [issued.id]);
  assert.equal(await getBookingAuthorizationTokenStatus(issued.token), "expired");
  assert.equal((await query("SELECT status FROM booking_authorization_requests WHERE id = $1", [issued.id])).rows[0].status, "pending");
  assert.deepEqual(await consumeBookingAuthorizationToken(issued.token, "approved"), {
    status: "expired", outcome: "expired"
  });
  assert.equal((await query("SELECT decided_at FROM booking_authorization_requests WHERE id = $1", [issued.id])).rows[0].decided_at, null);
  assert.deepEqual(await consumeBookingAuthorizationToken("z".repeat(43), "approved"), {
    status: "invalid", outcome: "invalid"
  });
  await assert.rejects(issueBookingAuthorizationRequest({ customerId, bookingId: "missing" }));
  const other = await createCustomer({ givenName: "Other", surname: "Customer", email: null, phone: null });
  await query(`INSERT INTO customer_bookings
    (id, customer_id, reference, service_date, pickup, dropoff, status, created_at)
    VALUES ('other-authorization-booking', $1, 'OTHER-AUTH', '2026-10-26', 'Office', 'Station',
            'Scheduled', CURRENT_TIMESTAMP::text)`, [other.id]);
  await assert.rejects(issueBookingAuthorizationRequest({ customerId, bookingId: "other-authorization-booking" }));
  await query("UPDATE business_customers SET booking_auth_channel = 'email' WHERE customer_id = $1", [customerId]);
  await assert.rejects(issueBookingAuthorizationRequest({ customerId, bookingId: "authorization-booking", channel: "whatsapp" }));
  await query("UPDATE business_customers SET booking_auth_channel = 'both' WHERE customer_id = $1", [customerId]);
});

test("concurrent conflicting PostgreSQL decisions have exactly one winner and preserve its decision", async () => {
  const issued = await issueBookingAuthorizationRequest({ customerId, bookingId: "authorization-booking" });
  const results = await Promise.all([
    consumeBookingAuthorizationToken(issued.token, "approved", getPool()),
    consumeBookingAuthorizationToken(issued.token, "declined", getPool())
  ]);
  assert.equal(results.filter(result => result.outcome === "decided").length, 1);
  assert.equal(results.filter(result => result.outcome === "already_decided").length, 1);
  assert.equal(results[0].status, results[1].status);
  assert.equal(await getBookingAuthorizationTokenStatus(issued.token), results[0].status);
});
