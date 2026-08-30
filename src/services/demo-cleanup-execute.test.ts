import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import { createCustomer, getCustomerById, getCustomerCount } from "./customers";
import { EXPECTED_DEMO_CUSTOMER_IDS, getDemoCleanupReport, runDemoCleanup } from "./demo-cleanup";

let dbContext: TestDatabaseContext;
let realCustomerId: string;

before(async () => {
  dbContext = await createTestDatabaseContext("test_democleanup_exec");
  process.env.ALLOW_DEMO_CLEANUP = "true";
  await dbContext.createAuthTables();
  await initializeDatabase();

  const realCustomer = await createCustomer({
    givenName: "Real",
    surname: "Customer",
    email: "real.customer@example.com",
    phone: "+44 7700 900999",
    status: "Active"
  });
  realCustomerId = realCustomer.id;

  const now = new Date().toISOString();
  await query(
    `INSERT INTO customer_bookings (id, customer_id, reference, service_date, pickup, dropoff, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    ["book-real-1", realCustomerId, "RM-REAL-1", now, "Home", "Office", "Scheduled", now]
  );
});

after(async () => {
  delete process.env.ALLOW_DEMO_CLEANUP;
  await dbContext.cleanup();
});

test("rolls back the whole transaction if an error occurs mid-cleanup", async () => {
  const customersBefore = await getCustomerCount();
  const bookingsRes = await query<{ total: number }>("SELECT COUNT(*)::int AS total FROM customer_bookings");
  const bookingsBefore = Number(bookingsRes.rows[0].total);

  // Force a failure inside the cleanup transaction after bookings have been
  // read but before the archive insert can succeed.
  await query("DROP TABLE archived_bookings CASCADE");

  await assert.rejects(async () => {
    await runDemoCleanup({ confirm: true });
  });

  assert.equal(await getCustomerCount(), customersBefore);
  const bookingsAfter = await query<{ total: number }>("SELECT COUNT(*)::int AS total FROM customer_bookings");
  assert.equal(Number(bookingsAfter.rows[0].total), bookingsBefore);

  // Recreate the table dropped above so the confirmed run below can proceed.
  await query(`
    CREATE TABLE IF NOT EXISTS archived_bookings (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      customer_email TEXT,
      booking_id TEXT NOT NULL,
      booking_data JSONB,
      archived_at TIMESTAMP WITH TIME ZONE NOT NULL,
      reason TEXT
    );
  `);
});

test("confirmed cleanup removes only demo records and preserves real customers/bookings and auth tables", async () => {
  const authBefore = await dbContext.countAuthRows();

  const result = await runDemoCleanup({ confirm: true });

  assert.equal(result.refused, false);
  assert.equal(result.executed, true);
  assert.equal(result.deletedCustomerCount, EXPECTED_DEMO_CUSTOMER_IDS.length);

  for (const id of EXPECTED_DEMO_CUSTOMER_IDS) {
    assert.equal(await getCustomerById(id), undefined, `demo customer ${id} should have been removed`);
    const remainingBookings = await query<{ total: number }>(
      "SELECT COUNT(*)::int AS total FROM customer_bookings WHERE customer_id = $1",
      [id]
    );
    assert.equal(remainingBookings.rows[0].total, 0);
  }

  // The real customer and its booking must be completely unaffected.
  const realCustomer = await getCustomerById(realCustomerId);
  assert.ok(realCustomer);
  assert.equal(realCustomer?.email, "real.customer@example.com");

  const realBookings = await query<{ total: number }>(
    "SELECT COUNT(*)::int AS total FROM customer_bookings WHERE customer_id = $1",
    [realCustomerId]
  );
  assert.equal(realBookings.rows[0].total, 1);

  // Demo bookings were archived, not silently discarded.
  const archivedCount = await query<{ total: number }>(
    "SELECT COUNT(*)::int AS total FROM archived_bookings WHERE reason = 'demo_seed_cleanup'"
  );
  assert.ok(archivedCount.rows[0].total > 0);

  // Auth tables must remain untouched
  const authAfter = await dbContext.countAuthRows();
  assert.deepEqual(authAfter, authBefore);
});

test("repeat execution is safe and idempotent", async () => {
  const beforeReport = await getDemoCleanupReport();
  assert.equal(beforeReport.demoCustomerCount, 0);

  const result = await runDemoCleanup({ confirm: true });

  assert.equal(result.alreadyClean, true);
  assert.equal(result.refused, false);
  assert.equal(result.deletedCustomerCount, 0);

  // The real customer is still present after a repeated confirmed run.
  assert.ok(await getCustomerById(realCustomerId));
});
