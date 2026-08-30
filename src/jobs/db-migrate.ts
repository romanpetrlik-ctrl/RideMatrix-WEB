import dotenv from "dotenv";
import { closeDatabase, getPool } from "../database/connection";
import { runMigrations } from "../database/migrations";

dotenv.config();

async function run(): Promise<void> {
  const client = await getPool().connect();

  try {
    const executed = await runMigrations(client);
    if (executed.length === 0) {
      console.log("[db:migrate] Database schema is already up to date.");
    } else {
      console.log(`[db:migrate] Applied migration(s): ${executed.join(", ")}`);
    }
  } finally {
    client.release();
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error("[db:migrate] Migration failed:", error);
  process.exit(1);
});
