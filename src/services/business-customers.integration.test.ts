import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, getPool, initializeDatabase, query } from "../database/connection";
import {
  createTestDatabaseContext, safeCleanupTestDatabase, type TestDatabaseContext
} from "../database/test-helper";
import { anonymizeCustomer, createCustomer, deleteCustomer, getCustomerById } from "./customers";
import {
  createBusinessCustomer, getBusinessCustomer, validateBusinessCustomer, type BusinessCustomerInput
} from "./business-customers";

let context: TestDatabaseContext | undefined;
before(async () => {
  context = await createTestDatabaseContext("test_business_customers");
  await context.createAuthTables();
  await initializeDatabase();
});
after(async () => safeCleanupTestDatabase(context));

function validBusiness(email: string): BusinessCustomerInput {
  const result = validateBusinessCustomer({
    registeredName: "Example Business Ltd", registeredHouseNameNumber: "12A",
    registeredAddressLine1: "High Street", registeredAddressLine2: "Business Park",
    registeredCityTown: "Dorchester", registeredCounty: "Dorset", registeredState: "England",
    registeredPostcode: "DT1 1AA", registeredCountry: "United Kingdom",
    registeredLatitude: "50.71", registeredLongitude: "-2.44",
    officePhone: "020 7946 0958", officeEmail: email,
    bookerFullName: "Alex Booker", bookerEmail: "booker@example.com", bookerPhone: "+44 7911 123456",
    bookingAuthRequired: "yes", bookingAuthChannel: "both",
    accountsFullName: "Finance Team", accountsEmail: "finance@example.com", accountsPhone: "020 7946 0958"
  });
  assert.ok(result.input, result.errors.join("; "));
  return result.input;
}

test("persists both rows atomically and reads JSONB business data across a pool restart", async () => {
  const input = validBusiness("business-persist@example.com");
  const customer = await createBusinessCustomer(input);
  assert.equal(customer.givenName, input.registeredName);
  assert.equal(customer.surname, "");
  assert.equal(customer.company, input.registeredName);
  assert.equal(customer.source, "business");
  assert.equal(customer.email, input.officeEmail);
  assert.equal(customer.phone, input.officePhone);
  assert.equal(customer.houseNameNumber, "12A");
  assert.equal(customer.cityTown, "Dorchester");
  assert.equal(customer.latitude, 50.71);
  assert.ok(customer.address?.includes("United Kingdom"));
  await closeDatabase();
  assert.deepEqual(await getBusinessCustomer(customer.id), input);
  assert.ok(await getCustomerById(customer.id));
  assert.equal(await getBusinessCustomer("missing-business"), null);
});

test("rolls back the base customer when inserting its business row fails", async () => {
  await query(`ALTER TABLE business_customers ADD CONSTRAINT test_reject_business
    CHECK (registered_name <> 'Rollback Business')`);
  try {
    const input = { ...validBusiness("business-rollback@example.com"), registeredName: "Rollback Business" };
    await assert.rejects(createBusinessCustomer(input), /test_reject_business/);
    const result = await query("SELECT id FROM customers WHERE email = $1", [input.officeEmail]);
    assert.equal(result.rowCount, 0);
  } finally {
    await query("ALTER TABLE business_customers DROP CONSTRAINT test_reject_business");
  }
});

test("rejects invalid typed inputs before persistence and normalizes no-authorization channels", async () => {
  const invalid = validBusiness("business-invalid@example.com");
  invalid.registeredAddress.latitude = Infinity;
  await assert.rejects(createBusinessCustomer(invalid), /latitude/);
  assert.equal((await query("SELECT id FROM customers WHERE email = $1", [invalid.officeEmail])).rowCount, 0);
  const input = validBusiness("business-no-auth@example.com");
  input.bookingAuthRequired = false;
  const customer = await createBusinessCustomer(input);
  assert.equal((await getBusinessCustomer(customer.id))?.bookingAuthChannel, null);
});

test("migration enforces one business per customer and consistent authorization settings", async () => {
  const customer = await createBusinessCustomer(validBusiness("business-constraints@example.com"));
  await assert.rejects(
    query("UPDATE business_customers SET booking_auth_channel = NULL WHERE customer_id = $1", [customer.id]),
    /business_customers_auth_channel_check/
  );
  await assert.rejects(
    query("INSERT INTO business_customers SELECT * FROM business_customers WHERE customer_id = $1", [customer.id]),
    /business_customers_pkey/
  );
  for (const column of ["accounts_full_name", "accounts_email"]) {
    for (const value of [null, "", "   "]) {
      await assert.rejects(
        query(`UPDATE business_customers SET ${column} = $1 WHERE customer_id = $2`, [value, customer.id]),
        /not-null|check constraint/
      );
    }
  }
});

test("authorization migration enforces booking ownership, unique tokens, statuses and cascading deletes", async () => {
  const business = await createBusinessCustomer(validBusiness("business-auth-schema@example.com"));
  const other = await createCustomer({ givenName: "Private", surname: "Customer", email: null, phone: null });
  async function booking(id: string, customerId: string): Promise<void> {
    await query(`INSERT INTO customer_bookings
      (id, customer_id, reference, service_date, pickup, dropoff, status, created_at)
      VALUES ($1, $2, $1, '2026-10-26', 'Office', 'Station', 'Scheduled', CURRENT_TIMESTAMP::text)`,
    [id, customerId]);
  }
  await booking("business-owned-booking", business.id);
  await booking("private-owned-booking", other.id);
  const insert = (id: string, bookingId: string, hash: string) => query(
    `INSERT INTO booking_authorization_requests (id, customer_id, booking_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '1 hour') RETURNING *`,
    [id, business.id, bookingId, hash]
  );
  await assert.rejects(insert("wrong-owner", "private-owned-booking", "wrong-owner-hash"), /customer_booking_fk/);
  const request = await insert("business-request", "business-owned-booking", "unique-token-hash");
  assert.equal(request.rows[0].status, "pending");
  assert.ok(request.rows[0].created_at instanceof Date);
  assert.ok(request.rows[0].updated_at instanceof Date);
  assert.equal(request.rows[0].decided_at, null);
  await assert.rejects(insert("duplicate-token", "business-owned-booking", "unique-token-hash"), /token_hash_key/);
  await assert.rejects(
    query("UPDATE booking_authorization_requests SET status = 'invalid' WHERE id = 'business-request'"), /check/
  );
  await assert.rejects(
    query("UPDATE booking_authorization_requests SET decided_by_channel = 'sms' WHERE id = 'business-request'"), /check/
  );
  await query("DELETE FROM customer_bookings WHERE id = 'business-owned-booking'");
  assert.equal((await query("SELECT id FROM booking_authorization_requests WHERE id = 'business-request'")).rowCount, 0);
  await booking("business-cascade-booking", business.id);
  await insert("business-cascade-request", "business-cascade-booking", "cascade-token-hash");
  await query("DELETE FROM business_customers WHERE customer_id = $1", [business.id]);
  assert.equal(await getBusinessCustomer(business.id), null);
  assert.equal((await query("SELECT id FROM booking_authorization_requests WHERE id = 'business-cascade-request'")).rowCount, 0);
  const withoutBookings = await createBusinessCustomer(validBusiness("business-customer-cascade@example.com"));
  await query("DELETE FROM customers WHERE id = $1", [withoutBookings.id]);
  assert.equal(await getBusinessCustomer(withoutBookings.id), null);
});

test("anonymization deletes business PII and authorization tokens while retaining anonymized bookings", async () => {
  const business = await createBusinessCustomer(validBusiness("business-anonymize@example.com"));
  await query(`INSERT INTO customer_bookings
    (id, customer_id, reference, service_date, pickup, dropoff, status, created_at)
    VALUES ('business-anonymize-booking', $1, 'BUS-ANON', '2020-01-01', 'Office', 'Station',
      'Completed', CURRENT_TIMESTAMP::text)`, [business.id]);
  await query(`INSERT INTO booking_authorization_requests
    (id, customer_id, booking_id, token_hash, expires_at)
    VALUES ('business-anonymize-request', $1, 'business-anonymize-booking', 'anonymize-token-hash',
      CURRENT_TIMESTAMP + INTERVAL '1 hour')`, [business.id]);
  await query("UPDATE customers SET purge_after = '2020-01-01T00:00:00.000Z' WHERE id = $1", [business.id]);
  const client = await getPool().connect();
  try {
    assert.equal(await anonymizeCustomer(business.id, client), true);
  } finally {
    client.release();
  }
  assert.equal(await getBusinessCustomer(business.id), null);
  assert.equal((await query("SELECT customer_id FROM business_customers WHERE customer_id = $1", [business.id])).rowCount, 0);
  assert.equal((await query("SELECT id FROM booking_authorization_requests WHERE customer_id = $1", [business.id])).rowCount, 0);
  const customer = await getCustomerById(business.id);
  assert.equal(customer?.givenName, "Anonymized");
  assert.equal(customer?.email, null);
  assert.equal(customer?.source, "business");
  assert.equal(customer?.bookings[0]?.pickup, "[anonymized]");
});

test("retention holds preserve business profiles", async () => {
  const business = await createBusinessCustomer(validBusiness("business-retention-hold@example.com"));
  await query(`UPDATE customers SET purge_after = '2020-01-01T00:00:00.000Z',
    retention_hold_until = '2999-01-01T00:00:00.000Z' WHERE id = $1`, [business.id]);
  const client = await getPool().connect();
  try {
    assert.equal(await anonymizeCustomer(business.id, client), false);
  } finally {
    client.release();
  }
  assert.ok(await getBusinessCustomer(business.id));
});

test("direct business reads do not expose soft-deleted or anonymized customer profiles", async () => {
  const deleted = await createBusinessCustomer(validBusiness("business-soft-delete@example.com"));
  assert.equal(await deleteCustomer(deleted.id), true);
  assert.equal(await getBusinessCustomer(deleted.id), null);
  const anonymized = await createBusinessCustomer(validBusiness("business-hidden-anonymized@example.com"));
  await query("UPDATE customers SET anonymized_at = CURRENT_TIMESTAMP::text WHERE id = $1", [anonymized.id]);
  assert.equal(await getBusinessCustomer(anonymized.id), null);
});
