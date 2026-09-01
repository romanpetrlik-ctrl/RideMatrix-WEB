/**
 * Read-only production/database readiness audit.
 *
 * The script only issues SELECT/metadata queries inside a READ ONLY
 * transaction. It never creates roman.petrlik@hotmail.com, never modifies
 * bookings@romanairporttransfers.co.uk, never imports customers, and never
 * runs migrations, seeds, or any other write.
 *
 * Usage:
 *   npm run audit:db            # human-readable report
 *   npm run audit:db -- --json  # machine-readable JSON report
 *
 * Environment variables:
 *   DATABASE_URL — PostgreSQL connection string of the database to inspect.
 *                  When it is missing or unreachable, every section is
 *                  reported as NOT_VERIFIED instead of being guessed.
 *
 * See docs/database-readiness-audit.md.
 */

import dotenv from "dotenv";
import { closeDatabase } from "../database/connection";
import {
  formatReadinessReport,
  runDatabaseReadinessAudit
} from "../services/db-readiness-audit";

dotenv.config();

const asJson = process.argv.slice(2).includes("--json");

async function run(): Promise<void> {
  const report = await runDatabaseReadinessAudit();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReadinessReport(report));
  }

  await closeDatabase().catch(() => {});

  const blocked = report.sections.some((section) => section.status === "BLOCKED");
  const notVerified = report.sections.some((section) => section.status === "NOT_VERIFIED");

  // 0 = ready / needs review, 2 = blocked, 3 = could not verify.
  process.exit(blocked ? 2 : notVerified ? 3 : 0);
}

run().catch(async (error) => {
  console.error("[audit:db] Audit failed:", error instanceof Error ? error.message : error);
  await closeDatabase().catch(() => {});
  process.exit(1);
});
