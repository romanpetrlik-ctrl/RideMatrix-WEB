import pg from "pg";
import { runMigrations } from "./migrations";
import { seedCustomers } from "./seed";

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * Demo/seed customer data must never be created automatically in production.
 * `SEED_DEMO_DATA` defaults to enabled everywhere except when `NODE_ENV` is
 * `production`, so existing development/test/staging behaviour is unchanged
 * while production deployments are safe by default. Set `SEED_DEMO_DATA=true`
 * explicitly to override the production default (for example on a staging
 * environment that also has `NODE_ENV=production`), or `SEED_DEMO_DATA=false`
 * to disable it anywhere else.
 */
export function shouldSeedDemoData(): boolean {
  const configured = String(process.env.SEED_DEMO_DATA ?? "").trim().toLowerCase();

  if (configured === "true") {
    return true;
  }

  if (configured === "false") {
    return false;
  }

  return process.env.NODE_ENV !== "production";
}

export function resolveDatabaseUrl(): string {
  const configured = String(process.env.DATABASE_URL || "").trim();

  if (!configured) {
    throw new Error(
      "DATABASE_URL environment variable is missing. " +
        "Configure a valid PostgreSQL connection string (e.g. ******host:5432/ridematrix)."
    );
  }

  return configured;
}

/**
 * Returns the shared PostgreSQL connection pool, configuring it from DATABASE_URL.
 */
export function getPool(): pg.Pool {
  if (pool) {
    return pool;
  }

  const connectionString = resolveDatabaseUrl();

  pool = new Pool({
    connectionString,
    max: process.env.DATABASE_POOL_MAX ? parseInt(process.env.DATABASE_POOL_MAX, 10) : 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  pool.on("error", (err) => {
    console.error("[database] Unexpected error on idle PostgreSQL client:", err);
  });

  return pool;
}

/**
 * Executes a parameterized SQL query on the pool or on an existing client.
 */
export async function query<R extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
  client?: pg.PoolClient | pg.Pool
): Promise<pg.QueryResult<R>> {
  const runner = client || getPool();
  return runner.query<R>(text, params);
}

/**
 * Executes a callback inside a PostgreSQL transaction using a dedicated client.
 */
export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Opens the database eagerly and applies pending migrations and demo seed.
 */
export async function initializeDatabase(): Promise<void> {
  const currentPool = getPool();
  const client = await currentPool.connect();

  try {
    await runMigrations(client);

    if (shouldSeedDemoData()) {
      await seedCustomers(client);
    } else {
      console.log("[database] SEED_DEMO_DATA is disabled; skipping demo customer seed.");
    }
  } finally {
    client.release();
  }
}

export async function closeDatabase(): Promise<void> {
  if (!pool) {
    return;
  }

  const currentPool = pool;
  pool = null;
  await currentPool.end();
}
