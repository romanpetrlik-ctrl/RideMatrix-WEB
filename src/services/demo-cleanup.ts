import type { Pool, PoolClient } from "pg";
import { getPool, withTransaction } from "../database/connection";
import { SEED_CUSTOMERS } from "../database/seed";

type Queryable = Pool | PoolClient;

/**
 * Origin marker used exclusively by `seedCustomers` (see `src/database/seed.ts`).
 * Manual registrations use `manual`, Cabcher imports use `import`, and
 * booking-driven auto-creation uses `booking` — none of those code paths are
 * allowed to write `seed`, so this value unambiguously identifies demo data.
 */
export const DEMO_SOURCE = "seed";

/** The 18 original demo customer ids, used as a defense-in-depth identity check. */
export const EXPECTED_DEMO_CUSTOMER_IDS = SEED_CUSTOMERS.map((customer) => customer.id).sort();

export type DemoCustomerCandidate = {
  id: string;
  givenName: string;
  surname: string;
  email: string | null;
  source: string;
  bookingCount: number;
};

export type DemoCleanupReport = {
  demoCustomers: DemoCustomerCandidate[];
  demoCustomerCount: number;
  demoBookingCount: number;
  importBatchCount: number;
  nonDemoCustomerCount: number;
  /** True only when the candidate set exactly matches the 18 expected seed ids. */
  matchesExpectedDemoSet: boolean;
  unexpectedIds: string[];
  missingExpectedIds: string[];
};

type CustomerRow = {
  id: string;
  given_name: string;
  surname: string;
  email: string | null;
  source: string;
};

/**
 * Builds a read-only report describing the current demo/seed customers,
 * their related bookings, import batches and non-demo customer counts. This
 * never modifies the database and is safe to call at any time.
 */
async function loadReport(runner: Queryable): Promise<DemoCleanupReport> {
  const demoRowsRes = await runner.query<CustomerRow>(
    `SELECT id, given_name, surname, email, source
     FROM customers
     WHERE source = $1 AND deleted_at IS NULL
     ORDER BY id`,
    [DEMO_SOURCE]
  );
  const demoRows = demoRowsRes.rows;

  const bookingCountRowsRes = await runner.query<{ customer_id: string; total: string | number }>(
    `SELECT customer_id, COUNT(*) AS total FROM customer_bookings GROUP BY customer_id`
  );
  const bookingCountByCustomer = new Map(
    bookingCountRowsRes.rows.map((row) => [row.customer_id, Number(row.total)])
  );

  const demoCustomers: DemoCustomerCandidate[] = demoRows.map((row) => ({
    id: row.id,
    givenName: row.given_name,
    surname: row.surname,
    email: row.email,
    source: row.source,
    bookingCount: bookingCountByCustomer.get(row.id) || 0
  }));

  const demoBookingCount = demoCustomers.reduce((sum, customer) => sum + customer.bookingCount, 0);

  const importBatchCountRes = await runner.query<{ total: string | number }>(
    `SELECT COUNT(*) AS total FROM import_batches`
  );
  const importBatchCount = Number(importBatchCountRes.rows[0]?.total ?? 0);

  const nonDemoCustomerCountRes = await runner.query<{ total: string | number }>(
    `SELECT COUNT(*) AS total FROM customers WHERE source != $1 AND deleted_at IS NULL`,
    [DEMO_SOURCE]
  );
  const nonDemoCustomerCount = Number(nonDemoCustomerCountRes.rows[0]?.total ?? 0);

  const candidateIds = demoCustomers.map((customer) => customer.id).sort();
  const expectedSet = new Set(EXPECTED_DEMO_CUSTOMER_IDS);
  const candidateSet = new Set(candidateIds);
  const unexpectedIds = candidateIds.filter((id) => !expectedSet.has(id));
  const missingExpectedIds = EXPECTED_DEMO_CUSTOMER_IDS.filter((id) => !candidateSet.has(id));
  const matchesExpectedDemoSet = unexpectedIds.length === 0 && missingExpectedIds.length === 0;

  return {
    demoCustomers,
    demoCustomerCount: demoCustomers.length,
    demoBookingCount,
    importBatchCount,
    nonDemoCustomerCount,
    matchesExpectedDemoSet,
    unexpectedIds,
    missingExpectedIds
  };
}

/**
 * Read-only dry-run report. Never modifies data. Use this to inspect the
 * exact candidate list before running a confirmed cleanup.
 */
export async function getDemoCleanupReport(client?: Queryable): Promise<DemoCleanupReport> {
  const runner = client || getPool();
  return loadReport(runner);
}

export type DemoCleanupOptions = {
  /** Explicit confirmation flag. Without this the operation is always a dry run. */
  confirm: boolean;
  /**
   * Explicit reviewed override, required when the candidate set does not
   * exactly match the 18 expected demo ids (different count or identity).
   */
  allowOverride?: boolean;
};

export type DemoCleanupResult = {
  report: DemoCleanupReport;
  dryRun: boolean;
  executed: boolean;
  /** True when there were no demo records left to remove (idempotent no-op). */
  alreadyClean: boolean;
  refused: boolean;
  refusalReason?: string;
  deletedCustomerCount: number;
  archivedBookingCount: number;
};

function isDemoCleanupEnabledByConfig(): boolean {
  return String(process.env.ALLOW_DEMO_CLEANUP ?? "").trim().toLowerCase() === "true";
}

function refusal(report: DemoCleanupReport, reason: string): DemoCleanupResult {
  return {
    report,
    dryRun: false,
    executed: false,
    alreadyClean: false,
    refused: true,
    refusalReason: reason,
    deletedCustomerCount: 0,
    archivedBookingCount: 0
  };
}

/**
 * Executes (or dry-runs) the demo customer cleanup.
 *
 * Safety controls:
 * - `options.confirm` must be true, otherwise this only returns the report.
 * - `ALLOW_DEMO_CLEANUP=true` must be set, otherwise a confirmed run refuses.
 * - The candidate set must exactly match the 18 expected demo ids, unless
 *   `options.allowOverride` is explicitly supplied.
 * - Runs in a single transaction: related demo-only bookings are archived
 *   into `archived_bookings` and removed, then demo customers are deleted.
 *   Only rows with `source = 'seed'` are ever touched.
 * - Idempotent: once no demo records remain, subsequent confirmed runs are a
 *   safe no-op and never require an override.
 */
export async function runDemoCleanup(
  options: DemoCleanupOptions,
  client?: Queryable
): Promise<DemoCleanupResult> {
  const runner = client || getPool();
  const report = await loadReport(runner);

  if (!options.confirm) {
    return {
      report,
      dryRun: true,
      executed: false,
      alreadyClean: report.demoCustomerCount === 0,
      refused: false,
      deletedCustomerCount: 0,
      archivedBookingCount: 0
    };
  }

  if (report.demoCustomerCount === 0) {
    return {
      report,
      dryRun: false,
      executed: false,
      alreadyClean: true,
      refused: false,
      deletedCustomerCount: 0,
      archivedBookingCount: 0
    };
  }

  const identityMatches =
    report.matchesExpectedDemoSet && report.demoCustomerCount === EXPECTED_DEMO_CUSTOMER_IDS.length;

  if (!identityMatches && !options.allowOverride) {
    return refusal(
      report,
      `Candidate demo set (${report.demoCustomerCount} record(s)) does not match the expected ` +
        `${EXPECTED_DEMO_CUSTOMER_IDS.length} seed record(s). Re-run with an explicit reviewed ` +
        `override (--allow-override) only after manually verifying the candidate list.`
    );
  }

  if (!isDemoCleanupEnabledByConfig()) {
    return refusal(
      report,
      `ALLOW_DEMO_CLEANUP is not set to "true". Refusing to execute a destructive cleanup.`
    );
  }

  const ids = report.demoCustomers.map((customer) => customer.id);
  const emailByCustomerId = new Map(
    report.demoCustomers.map((customer) => [customer.id, customer.email])
  );
  let archivedBookingCount = 0;

  const runWithTx = async (txClient: Queryable) => {
    const bookingsRes = await txClient.query<Record<string, unknown> & { id: string; customer_id: string }>(
      "SELECT * FROM customer_bookings WHERE customer_id = ANY($1)",
      [ids]
    );
    const bookings = bookingsRes.rows;

    const archivedAt = new Date().toISOString();
    const insertArchiveSql = `
      INSERT INTO archived_bookings (
        id, customer_id, customer_email, booking_id, booking_data, archived_at, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
    `;

    for (const booking of bookings) {
      await txClient.query(insertArchiveSql, [
        `demo-cleanup-${booking.id}`,
        booking.customer_id,
        emailByCustomerId.get(booking.customer_id) ?? null,
        booking.id,
        JSON.stringify(booking),
        archivedAt,
        "demo_seed_cleanup"
      ]);
    }

    await txClient.query("DELETE FROM customer_bookings WHERE customer_id = ANY($1)", [ids]);
    archivedBookingCount = bookings.length;

    // Belt-and-braces: only ever delete rows that are still marked as demo
    // seed data at the moment of the transaction, never anything else.
    await txClient.query(
      "DELETE FROM customers WHERE id = ANY($1) AND source = $2",
      [ids, DEMO_SOURCE]
    );
  };

  if (client) {
    await runWithTx(client);
  } else {
    await withTransaction(runWithTx);
  }

  return {
    report,
    dryRun: false,
    executed: true,
    alreadyClean: false,
    refused: false,
    deletedCustomerCount: ids.length,
    archivedBookingCount
  };
}
