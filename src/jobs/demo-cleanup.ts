/**
 * Demo customer cleanup — safely removes the 18 original seed/demo customer
 * records (and their demo-only bookings) before importing real production
 * customers.
 *
 * This script is NOT run automatically at startup and never runs as part of
 * normal request handling. It must be invoked explicitly by an administrator
 * as part of the production rollout runbook (see
 * docs/customer-persistence.md).
 *
 * Usage:
 *   npx tsx src/jobs/demo-cleanup.ts                          # dry run (read-only)
 *   npx tsx src/jobs/demo-cleanup.ts --confirm                 # execute cleanup
 *   npx tsx src/jobs/demo-cleanup.ts --confirm --allow-override
 *
 * Environment variables:
 *   ALLOW_DEMO_CLEANUP=true  — required in addition to --confirm to execute
 *   DATABASE_FILE            — SQLite database file (default: data/ridematrix.sqlite)
 */

import dotenv from "dotenv";
import fs from "fs";
import { getDatabaseFilePath } from "../database/connection";
import { DemoCleanupReport, getDemoCleanupReport, runDemoCleanup } from "../services/demo-cleanup";

dotenv.config();

const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const allowOverride = args.includes("--allow-override");

function printReport(report: DemoCleanupReport): void {
  console.log(`[demo-cleanup] Demo (seed) customers found:   ${report.demoCustomerCount}`);
  console.log(`[demo-cleanup] Related demo bookings found:   ${report.demoBookingCount}`);
  console.log(`[demo-cleanup] Import batches on record:       ${report.importBatchCount}`);
  console.log(`[demo-cleanup] Non-demo customers on record:   ${report.nonDemoCustomerCount}`);
  console.log(`[demo-cleanup] Matches expected 18-record set: ${report.matchesExpectedDemoSet}`);

  if (report.unexpectedIds.length > 0) {
    console.log(`[demo-cleanup] Unexpected candidate id(s): ${report.unexpectedIds.join(", ")}`);
  }

  if (report.missingExpectedIds.length > 0) {
    console.log(`[demo-cleanup] Missing expected id(s): ${report.missingExpectedIds.join(", ")}`);
  }

  if (report.demoCustomers.length > 0) {
    console.log("[demo-cleanup] Candidate demo customers:");
    for (const customer of report.demoCustomers) {
      console.log(
        `  - ${customer.id} | ${customer.givenName} ${customer.surname} | ${customer.email ?? "(no email)"} | ` +
          `source=${customer.source} | bookings=${customer.bookingCount}`
      );
    }
  }
}

/**
 * Copies the SQLite database file to a timestamped backup path before any
 * destructive operation. This is a best-effort, practical backup for the
 * embedded SQLite file used by this application; it does not verify that the
 * backup can be restored. Operators must copy this file to durable/offsite
 * storage and confirm it can be opened before relying on it (see the
 * production runbook in docs/customer-persistence.md).
 */
function backupDatabaseFile(): string | null {
  const file = getDatabaseFilePath();

  if (file === ":memory:") {
    console.warn("[demo-cleanup] In-memory database detected; skipping file backup (nothing to copy).");
    return null;
  }

  if (!fs.existsSync(file)) {
    console.warn(`[demo-cleanup] Database file "${file}" does not exist yet; skipping backup.`);
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${file}.pre-demo-cleanup-${timestamp}.bak`;

  fs.copyFileSync(file, backupPath);
  console.log(
    `[demo-cleanup] Backup written to ${backupPath}. Verify it can be restored before proceeding further.`
  );

  return backupPath;
}

function run(): void {
  console.log(`[demo-cleanup] Starting at ${new Date().toISOString()}`);

  const report = getDemoCleanupReport();
  printReport(report);

  if (!confirm) {
    console.log("[demo-cleanup] Dry run complete. No data was modified. Re-run with --confirm to execute cleanup.");
    process.exit(0);
  }

  if (report.demoCustomerCount > 0) {
    backupDatabaseFile();
  }

  const result = runDemoCleanup({ confirm: true, allowOverride });

  if (result.refused) {
    console.error(`[demo-cleanup] Refused: ${result.refusalReason}`);
    process.exit(1);
  }

  if (result.alreadyClean) {
    console.log("[demo-cleanup] No demo records remain. Nothing to do.");
    process.exit(0);
  }

  console.log(
    `[demo-cleanup] Removed ${result.deletedCustomerCount} demo customer(s) and archived ` +
      `${result.archivedBookingCount} related booking(s).`
  );
  process.exit(0);
}

run();
