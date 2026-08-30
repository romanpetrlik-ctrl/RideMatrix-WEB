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
 *   DATABASE_URL             — PostgreSQL connection URL (e.g. ******localhost:5432/ridematrix)
 */

import dotenv from "dotenv";
import { closeDatabase, initializeDatabase } from "../database/connection";
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

async function run(): Promise<void> {
  console.log(`[demo-cleanup] Starting at ${new Date().toISOString()}`);

  try {
    await initializeDatabase();
    const report = await getDemoCleanupReport();
    printReport(report);

    if (!confirm) {
      console.log("[demo-cleanup] Dry run complete. No data was modified. Re-run with --confirm to execute cleanup.");
      await closeDatabase();
      process.exit(0);
    }

    if (report.demoCustomerCount > 0) {
      console.log(
        "[demo-cleanup] Note: For PostgreSQL production databases, ensure a database snapshot or pg_dump backup " +
          "has been taken and verified before running destructive cleanup."
      );
    }

    const result = await runDemoCleanup({ confirm: true, allowOverride });

    if (result.refused) {
      console.error(`[demo-cleanup] Refused: ${result.refusalReason}`);
      await closeDatabase();
      process.exit(1);
    }

    if (result.alreadyClean) {
      console.log("[demo-cleanup] No demo records remain. Nothing to do.");
      await closeDatabase();
      process.exit(0);
    }

    console.log(
      `[demo-cleanup] Removed ${result.deletedCustomerCount} demo customer(s) and archived ` +
        `${result.archivedBookingCount} related booking(s).`
    );
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    console.error("[demo-cleanup] Fatal error:", error);
    await closeDatabase().catch(() => {});
    process.exit(1);
  }
}

run();
