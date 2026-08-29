import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closeDatabase, getDatabase } from "../database/connection";
import { createCustomer, getCustomerById, getCustomerCount } from "./customers";
import {
  DEMO_SOURCE,
  EXPECTED_DEMO_CUSTOMER_IDS,
  getDemoCleanupReport,
  runDemoCleanup
} from "./demo-cleanup";

let temporaryDirectory: string;

before(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ridematrix-demo-cleanup-"));
  process.env.DATABASE_FILE = path.join(temporaryDirectory, "test.sqlite");
  process.env.ALLOW_DEMO_CLEANUP = "false";
});

after(() => {
  closeDatabase();
  delete process.env.ALLOW_DEMO_CLEANUP;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("dry-run report matches the 18 expected demo records and modifies nothing", () => {
  const before = getDemoCleanupReport();

  assert.equal(before.demoCustomerCount, 18);
  assert.equal(before.demoCustomerCount, EXPECTED_DEMO_CUSTOMER_IDS.length);
  assert.equal(before.matchesExpectedDemoSet, true);
  assert.ok(before.demoCustomers.every((customer) => customer.source === DEMO_SOURCE));
  assert.equal(getCustomerCount(), 18);

  const result = runDemoCleanup({ confirm: false });

  assert.equal(result.dryRun, true);
  assert.equal(result.executed, false);
  assert.equal(result.alreadyClean, false);

  // Nothing was modified by the dry run.
  assert.equal(getCustomerCount(), 18);
  assert.equal(getDemoCleanupReport().demoCustomerCount, 18);
});

test("refuses a confirmed run when ALLOW_DEMO_CLEANUP is not enabled", () => {
  const result = runDemoCleanup({ confirm: true });

  assert.equal(result.refused, true);
  assert.match(result.refusalReason || "", /ALLOW_DEMO_CLEANUP/);
  assert.equal(getCustomerCount(), 18);
});

test("refuses a confirmed run when the candidate set does not match the expected demo ids", () => {
  process.env.ALLOW_DEMO_CLEANUP = "true";

  // Simulate a real customer that was accidentally marked with the demo source.
  const database = getDatabase();
  database
    .prepare(
      `INSERT INTO customers (
        id, given_name, surname, email, email_normalized, preferred_contact, status, source,
        created_at, updated_at
      ) VALUES ('cust-extra-demo', 'Extra', 'Demo', 'extra.demo@example.com', 'extra.demo@example.com',
        'Unknown', 'Active', 'seed', @now, @now)`
    )
    .run({ now: new Date().toISOString() });

  const report = getDemoCleanupReport();
  assert.equal(report.demoCustomerCount, 19);
  assert.equal(report.matchesExpectedDemoSet, false);
  assert.deepEqual(report.unexpectedIds, ["cust-extra-demo"]);

  const result = runDemoCleanup({ confirm: true });

  assert.equal(result.refused, true);
  assert.match(result.refusalReason || "", /does not match the expected/);

  // Refusal must not touch any data.
  assert.equal(getCustomerCount(), 19);
  assert.ok(getCustomerById("cust-extra-demo"));

  // An explicit reviewed override allows the operator to proceed anyway.
  const overridden = runDemoCleanup({ confirm: true, allowOverride: true });
  assert.equal(overridden.refused, false);
  assert.equal(overridden.executed, true);
  assert.equal(overridden.deletedCustomerCount, 19);

  process.env.ALLOW_DEMO_CLEANUP = "false";
});
