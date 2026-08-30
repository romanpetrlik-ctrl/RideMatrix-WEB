import type { Database } from "better-sqlite3";
import { getDatabase } from "../database/connection";
import { SEED_CUSTOMERS } from "../database/seed";

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
function loadReport(database: Database): DemoCleanupReport {
  const demoRows = database
    .prepare(
      `SELECT id, given_name, surname, email, source
       FROM customers
       WHERE source = ? AND deleted_at IS NULL
       ORDER BY id`
    )
    .all(DEMO_SOURCE) as CustomerRow[];

  const bookingCountRows = database
    .prepare(`SELECT customer_id, COUNT(*) AS total FROM customer_bookings GROUP BY customer_id`)
    .all() as Array<{ customer_id: string; total: number }>;
  const bookingCountByCustomer = new Map(bookingCountRows.map((row) => [row.customer_id, row.total]));

  const demoCustomers: DemoCustomerCandidate[] = demoRows.map((row) => ({
    id: row.id,
    givenName: row.given_name,
    surname: row.surname,
    email: row.email,
    source: row.source,
    bookingCount: bookingCountByCustomer.get(row.id) || 0
  }));

  const demoBookingCount = demoCustomers.reduce((sum, customer) => sum + customer.bookingCount, 0);

  const importBatchCount = Number(
    (database.prepare(`SELECT COUNT(*) AS total FROM import_batches`).get() as { total: number }).total
  );

  const nonDemoCustomerCount = Number(
    (
      database
        .prepare(`SELECT COUNT(*) AS total FROM customers WHERE source != ? AND deleted_at IS NULL`)
        .get(DEMO_SOURCE) as { total: number }
    ).total
  );

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
export function getDemoCleanupReport(): DemoCleanupReport {
  return loadReport(getDatabase());
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
export function runDemoCleanup(options: DemoCleanupOptions): DemoCleanupResult {
  const database = getDatabase();
  const report = loadReport(database);

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
  const emailByCustomerId = new Map(report.demoCustomers.map((customer) => [customer.id, customer.email]));
  const placeholders = ids.map(() => "?").join(", ");
  let archivedBookingCount = 0;

  const execute = database.transaction(() => {
    const bookings = database
      .prepare(`SELECT * FROM customer_bookings WHERE customer_id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown> & { id: string; customer_id: string }>;

    const archivedAt = new Date().toISOString();
    const archiveBooking = database.prepare(
      `INSERT OR IGNORE INTO archived_bookings (
        id, customer_id, customer_email, booking_id, booking_data, archived_at, reason
      ) VALUES (@id, @customerId, @customerEmail, @bookingId, @bookingData, @archivedAt, @reason)`
    );

    for (const booking of bookings) {
      archiveBooking.run({
        id: `demo-cleanup-${booking.id}`,
        customerId: booking.customer_id,
        customerEmail: emailByCustomerId.get(booking.customer_id) ?? null,
        bookingId: booking.id,
        bookingData: JSON.stringify(booking),
        archivedAt,
        reason: "demo_seed_cleanup"
      });
    }

    database.prepare(`DELETE FROM customer_bookings WHERE customer_id IN (${placeholders})`).run(...ids);
    archivedBookingCount = bookings.length;

    // Belt-and-braces: only ever delete rows that are still marked as demo
    // seed data at the moment of the transaction, never anything else.
    database.prepare(`DELETE FROM customers WHERE id IN (${placeholders}) AND source = ?`).run(...ids, DEMO_SOURCE);
  });

  execute();

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
