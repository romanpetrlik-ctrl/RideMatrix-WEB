import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, initializeDatabase, query, withTransaction } from "./connection";
import { TestDatabaseContext, createTestDatabaseContext } from "./test-helper";
import {
  createCustomer,
  getCustomerByEmail,
  getCustomerById,
  getCustomerCount,
  listCustomers,
  updateCustomer
} from "../services/customers";

let dbContext: TestDatabaseContext;

before(async () => {
  dbContext = await createTestDatabaseContext("test_pg_integration");
  // Set up existing auth tables first to simulate pre-existing production database
  await dbContext.createAuthTables();
  await initializeDatabase();
});

after(async () => {
  await dbContext.cleanup();
});

test("PostgreSQL migrations preserve existing auth tables and auth records", async () => {
  const authRows = await dbContext.countAuthRows();
  assert.equal(authRows.users, 2);
  assert.equal(authRows.roles, 2);
  assert.equal(authRows.permissions, 2);

  // Migrations can run repeatedly without error or data loss
  await initializeDatabase();

  const authRowsAfter = await dbContext.countAuthRows();
  assert.deepEqual(authRowsAfter, authRows);
});

test("Customer email normalization and uniqueness", async () => {
  const created = await createCustomer({
    givenName: "Unique",
    surname: "Test",
    email: "Unique.Person@domain.com",
    phone: "+44 7700 900555",
    status: "Active"
  });

  assert.ok(created);
  assert.equal(created.email, "Unique.Person@domain.com");

  // Lookup with different casing and whitespace
  const found = await getCustomerByEmail("  unique.person@domain.com  ");
  assert.ok(found);
  assert.equal(found.id, created.id);

  // Direct check of email_normalized in PostgreSQL
  const dbRow = await query<{ email_normalized: string }>(
    "SELECT email_normalized FROM customers WHERE id = $1",
    [created.id]
  );
  assert.equal(dbRow.rows[0].email_normalized, "unique.person@domain.com");
});

test("Customer origin markers are set accurately by source", async () => {
  // Manual creation sets source = 'manual'
  const manual = await createCustomer({
    givenName: "Manual",
    surname: "User",
    email: "manual.user@domain.com",
    phone: null
  });

  const manualDb = await query<{ source: string }>(
    "SELECT source FROM customers WHERE id = $1",
    [manual.id]
  );
  assert.equal(manualDb.rows[0].source, "manual");

  // Demo seeded records have source = 'seed'
  const seedDb = await query<{ source: string }>(
    "SELECT source FROM customers WHERE id = $1",
    ["cust-001"]
  );
  assert.equal(seedDb.rows[0].source, "seed");
});

test("Temporal booking status derives Completed vs Scheduled at read time for imported history", async () => {
  const now = new Date();
  const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const futureDate = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const customer = await createCustomer({
    givenName: "Booking",
    surname: "Temporal",
    email: "temporal@domain.com",
    phone: null
  });

  const batchId = "batch-temporal-test";
  await query(
    `INSERT INTO import_batches (id, source_type, original_filename, uploaded_by, uploaded_at, status, total_rows, imported_rows, rejected_rows)
     VALUES ($1, 'cabcher', 'test.csv', 'admin@example.com', $2, 'imported', 2, 2, 0)`,
    [batchId, now.toISOString()]
  );

  await query(
    `INSERT INTO imported_bookings (
      id, import_batch_id, dedupe_key, source_system, source_reference_raw, customer_name_raw, customer_email, service_date_time,
      pickup_text, dropoff_text, is_future, inferred_temporal_status, customer_id, created_at, updated_at
    ) VALUES ($1, $2, $1, 'cabcher', 'REF-PAST', 'Booking Temporal', $3, $4, 'A', 'B', 0, 'past', $5, $6, $6)`,
    ["imp-book-past-1", batchId, customer.email, pastDate, customer.id, now.toISOString()]
  );

  await query(
    `INSERT INTO imported_bookings (
      id, import_batch_id, dedupe_key, source_system, source_reference_raw, customer_name_raw, customer_email, service_date_time,
      pickup_text, dropoff_text, is_future, inferred_temporal_status, customer_id, created_at, updated_at
    ) VALUES ($1, $2, $1, 'cabcher', 'REF-FUT', 'Booking Temporal', $3, $4, 'A', 'B', 1, 'upcoming', $5, $6, $6)`,
    ["imp-book-fut-2", batchId, customer.email, futureDate, customer.id, now.toISOString()]
  );

  const reloaded = await getCustomerById(customer.id);
  assert.ok(reloaded);
  assert.equal(reloaded.bookings.length, 2);

  const pastBooking = reloaded.bookings.find((b) => b.id === "imp-book-past-1");
  const futureBooking = reloaded.bookings.find((b) => b.id === "imp-book-fut-2");

  assert.equal(pastBooking?.status, "Completed");
  assert.equal(futureBooking?.status, "Scheduled");
});

test("Transaction rollback helper works atomically in PostgreSQL", async () => {
  const initialCount = await getCustomerCount();

  await assert.rejects(async () => {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO customers (id, given_name, surname, email, email_normalized, preferred_contact, status, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          "cust-tx-test",
          "Tx",
          "Test",
          "tx.test@example.com",
          "tx.test@example.com",
          "Unknown",
          "Active",
          "manual",
          new Date().toISOString()
        ]
      );
      // Throw error to trigger rollback
      throw new Error("Deliberate transaction failure");
    });
  });

  assert.equal(await getCustomerCount(), initialCount);
  assert.equal(await getCustomerById("cust-tx-test"), undefined);
});
