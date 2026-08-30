import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closeDatabase, getDatabase } from "../database/connection";
import { createCustomer, getCustomerById, getCustomerCount } from "./customers";
import { EXPECTED_DEMO_CUSTOMER_IDS, getDemoCleanupReport, runDemoCleanup } from "./demo-cleanup";

let temporaryDirectory: string;
let realCustomerId: string;

before(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ridematrix-demo-cleanup-exec-"));
  process.env.DATABASE_FILE = path.join(temporaryDirectory, "test.sqlite");
  process.env.ALLOW_DEMO_CLEANUP = "true";

  const realCustomer = createCustomer({
    givenName: "Real",
    surname: "Customer",
    email: "real.customer@example.com",
    phone: "+44 7700 900999",
    status: "Active"
  });
  realCustomerId = realCustomer.id;

  const database = getDatabase();
  database
    .prepare(
      `INSERT INTO customer_bookings (id, customer_id, reference, service_date, pickup, dropoff, status, created_at)
       VALUES ('book-real-1', @customerId, 'RM-REAL-1', @now, 'Home', 'Office', 'Scheduled', @now)`
    )
    .run({ customerId: realCustomerId, now: new Date().toISOString() });
});

after(() => {
  closeDatabase();
  delete process.env.ALLOW_DEMO_CLEANUP;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("rolls back the whole transaction if an error occurs mid-cleanup", () => {
  const database = getDatabase();
  const customersBefore = getCustomerCount();
  const bookingsBefore = Number(
    (database.prepare("SELECT COUNT(*) AS total FROM customer_bookings").get() as { total: number }).total
  );

  // Force a failure inside the cleanup transaction after bookings have been
  // read but before the archive insert can succeed.
  database.exec("DROP TABLE archived_bookings");

  assert.throws(() => runDemoCleanup({ confirm: true }));

  assert.equal(getCustomerCount(), customersBefore);
  assert.equal(
    Number((database.prepare("SELECT COUNT(*) AS total FROM customer_bookings").get() as { total: number }).total),
    bookingsBefore
  );

  // Recreate the table dropped above so the confirmed run below can proceed.
  database.exec(`
    CREATE TABLE archived_bookings (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      customer_email TEXT,
      booking_id TEXT NOT NULL,
      booking_data TEXT,
      archived_at TEXT NOT NULL,
      reason TEXT
    );
  `);
});

test("confirmed cleanup removes only demo records and preserves real customers/bookings", () => {
  const result = runDemoCleanup({ confirm: true });

  assert.equal(result.refused, false);
  assert.equal(result.executed, true);
  assert.equal(result.deletedCustomerCount, EXPECTED_DEMO_CUSTOMER_IDS.length);

  const database = getDatabase();

  for (const id of EXPECTED_DEMO_CUSTOMER_IDS) {
    assert.equal(getCustomerById(id), undefined, `demo customer ${id} should have been removed`);
    const remainingBookings = database
      .prepare("SELECT COUNT(*) AS total FROM customer_bookings WHERE customer_id = ?")
      .get(id) as { total: number };
    assert.equal(remainingBookings.total, 0);
  }

  // The real customer and its booking must be completely unaffected.
  const realCustomer = getCustomerById(realCustomerId);
  assert.ok(realCustomer);
  assert.equal(realCustomer?.email, "real.customer@example.com");

  const realBookings = database
    .prepare("SELECT COUNT(*) AS total FROM customer_bookings WHERE customer_id = ?")
    .get(realCustomerId) as { total: number };
  assert.equal(realBookings.total, 1);

  // Demo bookings were archived, not silently discarded.
  const archivedCount = database
    .prepare("SELECT COUNT(*) AS total FROM archived_bookings WHERE reason = 'demo_seed_cleanup'")
    .get() as { total: number };
  assert.ok(archivedCount.total > 0);
});

test("repeat execution is safe and idempotent", () => {
  const before = getDemoCleanupReport();
  assert.equal(before.demoCustomerCount, 0);

  const result = runDemoCleanup({ confirm: true });

  assert.equal(result.alreadyClean, true);
  assert.equal(result.refused, false);
  assert.equal(result.deletedCustomerCount, 0);

  // The real customer is still present after a repeated confirmed run.
  assert.ok(getCustomerById(realCustomerId));
});
