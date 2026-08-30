import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import { getCustomerById, getCustomerCount } from "./customers";
import {
  DEMO_SOURCE,
  EXPECTED_DEMO_CUSTOMER_IDS,
  getDemoCleanupReport,
  runDemoCleanup
} from "./demo-cleanup";

let dbContext: TestDatabaseContext;

before(async () => {
  dbContext = await createTestDatabaseContext("test_democleanup");
  process.env.ALLOW_DEMO_CLEANUP = "false";
  await initializeDatabase();
});

after(async () => {
  delete process.env.ALLOW_DEMO_CLEANUP;
  await dbContext.cleanup();
});

test("dry-run report matches the 18 expected demo records and modifies nothing", async () => {
  const beforeReport = await getDemoCleanupReport();

  assert.equal(beforeReport.demoCustomerCount, 18);
  assert.equal(beforeReport.demoCustomerCount, EXPECTED_DEMO_CUSTOMER_IDS.length);
  assert.equal(beforeReport.matchesExpectedDemoSet, true);
  assert.ok(beforeReport.demoCustomers.every((customer) => customer.source === DEMO_SOURCE));
  assert.equal(await getCustomerCount(), 18);

  const result = await runDemoCleanup({ confirm: false });

  assert.equal(result.dryRun, true);
  assert.equal(result.executed, false);
  assert.equal(result.alreadyClean, false);

  // Nothing was modified by the dry run.
  assert.equal(await getCustomerCount(), 18);
  const afterReport = await getDemoCleanupReport();
  assert.equal(afterReport.demoCustomerCount, 18);
});

test("refuses a confirmed run when ALLOW_DEMO_CLEANUP is not enabled", async () => {
  const result = await runDemoCleanup({ confirm: true });

  assert.equal(result.refused, true);
  assert.match(result.refusalReason || "", /ALLOW_DEMO_CLEANUP/);
  assert.equal(await getCustomerCount(), 18);
});

test("refuses a confirmed run when the candidate set does not match the expected demo ids", async () => {
  process.env.ALLOW_DEMO_CLEANUP = "true";

  // Simulate a real customer that was accidentally marked with the demo source.
  const now = new Date().toISOString();
  await query(
    `INSERT INTO customers (
      id, given_name, surname, email, email_normalized, preferred_contact, status, source,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [
      "cust-extra-demo",
      "Extra",
      "Demo",
      "extra.demo@example.com",
      "extra.demo@example.com",
      "Unknown",
      "Active",
      "seed",
      now
    ]
  );

  const report = await getDemoCleanupReport();
  assert.equal(report.demoCustomerCount, 19);
  assert.equal(report.matchesExpectedDemoSet, false);
  assert.deepEqual(report.unexpectedIds, ["cust-extra-demo"]);

  const result = await runDemoCleanup({ confirm: true });

  assert.equal(result.refused, true);
  assert.match(result.refusalReason || "", /does not match the expected/);

  // Refusal must not touch any data.
  assert.equal(await getCustomerCount(), 19);
  assert.ok(await getCustomerById("cust-extra-demo"));

  // An explicit reviewed override allows the operator to proceed anyway.
  const overridden = await runDemoCleanup({ confirm: true, allowOverride: true });
  assert.equal(overridden.refused, false);
  assert.equal(overridden.executed, true);
  assert.equal(overridden.deletedCustomerCount, 19);

  process.env.ALLOW_DEMO_CLEANUP = "false";
});
