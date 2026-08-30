import type { Pool, PoolClient } from "pg";

export type Migration = {
  id: string;
  sql: string;
};

type Queryable = Pool | PoolClient;

export const MIGRATION_ADVISORY_LOCK_KEY = [1383695443, 1735357005] as const;

/**
 * Ordered list of PostgreSQL migrations.
 *
 * Migrations are kept as TypeScript modules (instead of loose `.sql` files) so
 * that they are shipped by `tsc` without an extra copy step and are applied by
 * the same runner in development (`tsx`) and in production (`dist`).
 */
export const MIGRATIONS: Migration[] = [
  {
    id: "0001_customer_persistence",
    sql: `
      CREATE OR REPLACE FUNCTION rm_normalize_phone(val text) RETURNS text AS $$
      BEGIN
        IF val IS NULL THEN
          RETURN '';
        END IF;
        RETURN lower(regexp_replace(val, '[^\\d+]', '', 'g'));
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;

      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        title TEXT,
        given_name TEXT NOT NULL,
        surname TEXT NOT NULL,
        email TEXT,
        email_normalized TEXT,
        phone TEXT,
        company TEXT,
        address TEXT,
        house_name_number TEXT,
        address_line1 TEXT,
        address_line2 TEXT,
        address_line3 TEXT,
        city_town TEXT,
        county TEXT,
        state TEXT,
        postcode TEXT,
        preferred_contact TEXT NOT NULL DEFAULT 'Unknown',
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'Pending',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        last_booking_at TEXT,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_customers_email_normalized ON customers (email_normalized);
      CREATE INDEX IF NOT EXISTS idx_customers_status ON customers (status);
      CREATE INDEX IF NOT EXISTS idx_customers_surname ON customers (surname, given_name);
      CREATE INDEX IF NOT EXISTS idx_customers_deleted_at ON customers (deleted_at);
      CREATE INDEX IF NOT EXISTS idx_customers_last_booking_at ON customers (last_booking_at);

      CREATE TABLE IF NOT EXISTS customer_bookings (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers (id),
        reference TEXT NOT NULL,
        service_date TEXT NOT NULL,
        pickup TEXT NOT NULL,
        dropoff TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_customer_bookings_customer_id
        ON customer_bookings (customer_id, service_date);

      CREATE TABLE IF NOT EXISTS import_batches (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        uploaded_by TEXT,
        uploaded_at TEXT NOT NULL,
        status TEXT NOT NULL,
        total_rows INTEGER NOT NULL DEFAULT 0,
        imported_rows INTEGER NOT NULL DEFAULT 0,
        rejected_rows INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS imported_bookings (
        id TEXT PRIMARY KEY,
        import_batch_id TEXT NOT NULL REFERENCES import_batches (id),
        source_system TEXT NOT NULL,
        source_reference_raw TEXT,
        source_account_raw TEXT,
        customer_email TEXT NOT NULL,
        customer_phone TEXT,
        customer_name_raw TEXT NOT NULL,
        customer_given_name TEXT,
        customer_surname TEXT,
        service_date_time TEXT NOT NULL,
        pickup_text TEXT NOT NULL,
        dropoff_text TEXT NOT NULL,
        vehicle_class_raw TEXT,
        payment_method_raw TEXT,
        total_fare_amount DOUBLE PRECISION,
        currency TEXT,
        is_future INTEGER NOT NULL,
        inferred_temporal_status TEXT NOT NULL,
        customer_id TEXT,
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_imported_bookings_customer_id
        ON imported_bookings (customer_id, service_date_time);
      CREATE INDEX IF NOT EXISTS idx_imported_bookings_customer_email
        ON imported_bookings (customer_email);

      CREATE TABLE IF NOT EXISTS imported_customers (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        phone TEXT,
        full_name TEXT NOT NULL,
        given_name TEXT,
        surname TEXT,
        booking_count_total INTEGER NOT NULL DEFAULT 0,
        booking_count_past INTEGER NOT NULL DEFAULT 0,
        booking_count_upcoming INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT,
        last_seen_at TEXT,
        next_booking_at TEXT,
        last_pickup_text TEXT,
        last_dropoff_text TEXT,
        preferred_vehicle_raw TEXT,
        last_payment_method_raw TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS archived_bookings (
        id TEXT PRIMARY KEY,
        customer_id TEXT,
        customer_email TEXT,
        booking_id TEXT NOT NULL,
        booking_data TEXT,
        archived_at TEXT NOT NULL,
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS id_sequences (
        name TEXT PRIMARY KEY,
        value BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bootstrap_state (
        key TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `
  },
  {
    id: "0002_active_customer_email_uniqueness",
    sql: `
      DO $$
      DECLARE
        duplicate_email text;
      BEGIN
        SELECT email_normalized INTO duplicate_email
        FROM customers
        WHERE deleted_at IS NULL
          AND email_normalized IS NOT NULL
        GROUP BY email_normalized
        HAVING COUNT(*) > 1
        LIMIT 1;

        IF duplicate_email IS NOT NULL THEN
          RAISE EXCEPTION
            'Cannot create active customer email uniqueness index; duplicate active email_normalized value exists: %. Soft-delete or merge duplicate active customers before rerunning migration.',
            duplicate_email
            USING ERRCODE = 'unique_violation';
        END IF;
      END $$;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_active_email_normalized_unique
        ON customers (email_normalized)
        WHERE deleted_at IS NULL
          AND email_normalized IS NOT NULL;
    `
  }
];

async function ensureMigrationsTable(client: Queryable): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

export async function runMigrations(client: Queryable): Promise<string[]> {
  await client.query("SELECT pg_advisory_lock($1, $2)", [...MIGRATION_ADVISORY_LOCK_KEY]);

  try {
    await ensureMigrationsTable(client);

    const appliedRes = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(appliedRes.rows.map((row) => String(row.id)));

    const executed: string[] = [];

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) {
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)", [
          migration.id,
          new Date().toISOString()
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      executed.push(migration.id);
    }

    return executed;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1, $2)", [...MIGRATION_ADVISORY_LOCK_KEY]);
  }
}
