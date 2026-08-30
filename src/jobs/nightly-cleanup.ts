/**
 * Nightly cleanup job — detects and removes inactive customers.
 *
 * Run manually:    npx tsx src/jobs/nightly-cleanup.ts
 * Schedule via:    cron / Bull / process manager (daily at 02:00 UTC recommended)
 *
 * Environment variables:
 *   INACTIVITY_MONTHS  — inactivity threshold in months (default: 12)
 *   DATABASE_URL       — PostgreSQL connection URL (e.g. ******localhost:5432/ridematrix)
 */

import dotenv from "dotenv";
import { closeDatabase, initializeDatabase } from "../database/connection";
import { detectAndCleanupInactiveCustomers } from "../services/customer-inactivity-cleanup";

dotenv.config();

const INACTIVITY_MONTHS = Number(process.env.INACTIVITY_MONTHS || 12);

async function run(): Promise<void> {
  console.log(`[nightly-cleanup] Starting at ${new Date().toISOString()}`);
  console.log(`[nightly-cleanup] Inactivity threshold: ${INACTIVITY_MONTHS} month(s)`);

  try {
    await initializeDatabase();
    const result = await detectAndCleanupInactiveCustomers(INACTIVITY_MONTHS);
    console.log(
      `[nightly-cleanup] Finished. Processed: ${result.processed}, Deleted: ${result.deleted}, Errors: ${result.errors}`
    );
    await closeDatabase();
    process.exit(result.errors > 0 ? 1 : 0);
  } catch (err) {
    console.error("[nightly-cleanup] Fatal error:", err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  }
}

run();
