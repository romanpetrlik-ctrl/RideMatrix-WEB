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
      UPDATE customers
      SET email_normalized = lower(trim(email))
      WHERE email_normalized IS NULL
        AND email IS NOT NULL
        AND trim(email) <> '';

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
  },
  {
    id: "0003_vehicle_management_mvp",
    sql: `
      CREATE TABLE IF NOT EXISTS vehicle_classes (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE
      );
      CREATE TABLE IF NOT EXISTS baggage_categories (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE
      );
      CREATE TABLE IF NOT EXISTS vehicle_class_baggage_capacity (
        vehicle_class_key TEXT NOT NULL REFERENCES vehicle_classes(key),
        baggage_category_key TEXT NOT NULL REFERENCES baggage_categories(key),
        capacity INTEGER NOT NULL CHECK (capacity >= 0),
        PRIMARY KEY (vehicle_class_key, baggage_category_key)
      );
      CREATE TABLE IF NOT EXISTS vehicles (
        id TEXT PRIMARY KEY,
        registration TEXT NOT NULL UNIQUE,
        make TEXT NOT NULL,
        model TEXT NOT NULL,
        year INTEGER,
        colour TEXT,
        vehicle_class_key TEXT NOT NULL REFERENCES vehicle_classes(key),
        status TEXT NOT NULL DEFAULT 'available',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vehicles_class ON vehicles(vehicle_class_key);
      CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(status);
      CREATE TABLE IF NOT EXISTS vehicle_driver_assignments (
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        driver_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        unassigned_at TEXT,
        PRIMARY KEY (vehicle_id, driver_id, assigned_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_active_vehicle_driver
        ON vehicle_driver_assignments(vehicle_id) WHERE unassigned_at IS NULL;
      CREATE TABLE IF NOT EXISTS vehicle_documents (
        id TEXT PRIMARY KEY,
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        document_type TEXT NOT NULL,
        document_number TEXT,
        issued_on TEXT,
        expires_on TEXT,
        original_filename TEXT,
        mime_type TEXT,
        storage_key TEXT,
        content BYTEA,
        uploaded_by TEXT,
        uploaded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle ON vehicle_documents(vehicle_id);
      CREATE TABLE IF NOT EXISTS vehicle_document_upload_rate_limits (
        rate_limit_key TEXT PRIMARY KEY,
        window_started_at TIMESTAMPTZ NOT NULL,
        request_count INTEGER NOT NULL CHECK (request_count > 0)
      );
    `
  },
  {
    id: "0004_vehicle_mvp_review_alignment",
    sql: `
      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_type TEXT NOT NULL DEFAULT 'ICE';
      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS passenger_capacity INTEGER NOT NULL DEFAULT 4;
      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS registered_keeper_details TEXT;
      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS wheelchair_accessible BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE vehicles ALTER COLUMN vehicle_class_key DROP NOT NULL;
      ALTER TABLE vehicles ALTER COLUMN status SET DEFAULT 'active';

      UPDATE vehicles SET status = 'active' WHERE status = 'available';
      UPDATE vehicles SET status = 'inactive' WHERE status = 'retired';
      UPDATE vehicles SET fuel_type = 'ICE' WHERE fuel_type IS NULL OR fuel_type NOT IN ('ICE', 'HYBRID', 'EV');
      UPDATE vehicles SET passenger_capacity = 4 WHERE passenger_capacity IS NULL OR passenger_capacity < 1;
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_fuel_type_check') THEN
          ALTER TABLE vehicles ADD CONSTRAINT vehicles_fuel_type_check CHECK (fuel_type IN ('ICE', 'HYBRID', 'EV'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_passenger_capacity_check') THEN
          ALTER TABLE vehicles ADD CONSTRAINT vehicles_passenger_capacity_check CHECK (passenger_capacity > 0);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_status_check') THEN
          ALTER TABLE vehicles ADD CONSTRAINT vehicles_status_check CHECK (status IN ('active', 'inactive', 'maintenance'));
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS vehicle_class_assignments (
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        vehicle_class_key TEXT NOT NULL REFERENCES vehicle_classes(key),
        assigned_at TEXT NOT NULL,
        unassigned_at TEXT,
        PRIMARY KEY (vehicle_id, vehicle_class_key, assigned_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_active_vehicle_class_assignment
        ON vehicle_class_assignments(vehicle_id, vehicle_class_key)
        WHERE unassigned_at IS NULL;
      INSERT INTO vehicle_class_assignments (vehicle_id, vehicle_class_key, assigned_at)
      SELECT id, vehicle_class_key, COALESCE(created_at, now()::text)
      FROM vehicles
      WHERE vehicle_class_key IS NOT NULL
      ON CONFLICT DO NOTHING;
      INSERT INTO vehicle_class_assignments (vehicle_id, vehicle_class_key, assigned_at)
      SELECT v.id, 'wheelchair_accessible', COALESCE(v.created_at, now()::text)
      FROM vehicles v
      WHERE v.wheelchair_accessible = TRUE
        AND EXISTS (SELECT 1 FROM vehicle_classes vc WHERE vc.key = 'wheelchair_accessible')
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS vehicle_baggage_capacities (
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        baggage_category_key TEXT NOT NULL REFERENCES baggage_categories(key),
        max_quantity INTEGER NOT NULL CHECK (max_quantity >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (vehicle_id, baggage_category_key)
      );

      ALTER TABLE baggage_categories ADD COLUMN IF NOT EXISTS min_reference_weight_kg NUMERIC;
      ALTER TABLE baggage_categories ADD COLUMN IF NOT EXISTS max_reference_weight_kg NUMERIC;
      ALTER TABLE baggage_categories ADD COLUMN IF NOT EXISTS nominal_length_mm INTEGER;
      ALTER TABLE baggage_categories ADD COLUMN IF NOT EXISTS nominal_width_mm INTEGER;
      ALTER TABLE baggage_categories ADD COLUMN IF NOT EXISTS nominal_height_mm INTEGER;

      UPDATE baggage_categories SET active = FALSE
      WHERE key IN ('small_case', 'large_case', 'specialist');
      INSERT INTO baggage_categories
        (key, label, description, active, min_reference_weight_kg, max_reference_weight_kg)
      VALUES
        ('xl_suitcase', 'XL suitcase', 'XL suitcase', TRUE, 31, NULL),
        ('l_suitcase', 'L suitcase', 'L suitcase', TRUE, NULL, 23),
        ('cabin_bag', 'CB cabin bag', 'CB cabin bag', TRUE, NULL, 12),
        ('backpack', 'BP backpack', 'BP backpack', TRUE, NULL, 8)
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        active = TRUE,
        min_reference_weight_kg = EXCLUDED.min_reference_weight_kg,
        max_reference_weight_kg = EXCLUDED.max_reference_weight_kg;
    `
  },
  {
    id: "0005_vehicle_document_replacement_history",
    sql: `
      ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS is_latest BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS superseded_at TEXT;

      WITH ranked AS (
         SELECT id,
           row_number() OVER (PARTITION BY vehicle_id, document_type ORDER BY uploaded_at DESC, id DESC) AS position
         FROM vehicle_documents
      )
      UPDATE vehicle_documents d
      SET is_latest = ranked.position = 1,
           superseded_at = CASE
             WHEN ranked.position = 1 THEN NULL
             ELSE COALESCE(d.superseded_at, d.uploaded_at)
           END
      FROM ranked
      WHERE ranked.id = d.id;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_documents_latest_type
         ON vehicle_documents(vehicle_id, document_type)
         WHERE is_latest = TRUE;
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
