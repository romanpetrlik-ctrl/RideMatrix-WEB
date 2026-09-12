import dotenv from "dotenv";
import { closeDatabase, initializeDatabase } from "../database/connection";
import { readCustomerRetentionPolicy } from "../services/customer-retention-config";
import { processCustomerRetention } from "../services/customers";

dotenv.config();

async function run(): Promise<void> {
  const policy = readCustomerRetentionPolicy();
  try {
    await initializeDatabase();
    const result = await processCustomerRetention(policy);
    console.log(
      `[customers:retention] inactive=${result.inactive} anonymized=${result.anonymized} purged=${result.purged}`
    );
    await closeDatabase();
  } catch (error) {
    console.error("[customers:retention] unrecoverable database error");
    await closeDatabase().catch(() => {});
    process.exitCode = 1;
  }
}

void run();
