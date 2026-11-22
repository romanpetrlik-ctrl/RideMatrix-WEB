import type { Pool, PoolClient } from "pg";
import {
  crossingFeeScheduleDrafts,
  londonFeeScheduleDrafts
} from "../services/london-fee-schedule-data";
import { roadChargeScheduleSeeds } from "../services/road-charge-schedules";

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
        status TEXT NOT NULL DEFAULT 'Active',
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
  },
  {
    id: "0005_customer_geocoding",
    sql: `
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS geocoded_at TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS geocode_status TEXT;
      CREATE INDEX IF NOT EXISTS idx_customers_coordinates
        ON customers (latitude, longitude);
    `
  },
  {
    id: "0007_multi_licensing_authority",
    sql: `
      CREATE TABLE IF NOT EXISTS licensing_authorities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        authority_type TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        preference_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_licensing_authorities_name_unique
        ON licensing_authorities (lower(name));

      CREATE TABLE IF NOT EXISTS operator_licensing_authorities (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL,
        licensing_authority_id TEXT NOT NULL REFERENCES licensing_authorities(id),
        license_reference TEXT,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        revoked_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (valid_until IS NULL OR valid_until > valid_from)
      );
      CREATE INDEX IF NOT EXISTS idx_operator_licenses_lookup
        ON operator_licensing_authorities (operator_id, licensing_authority_id);

      CREATE TABLE IF NOT EXISTS vehicle_licensing_authorities (
        id TEXT PRIMARY KEY,
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        licensing_authority_id TEXT NOT NULL REFERENCES licensing_authorities(id),
        license_reference TEXT,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        revoked_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (valid_until IS NULL OR valid_until > valid_from)
      );
      CREATE INDEX IF NOT EXISTS idx_vehicle_licenses_lookup
        ON vehicle_licensing_authorities (vehicle_id, licensing_authority_id);

      CREATE TABLE IF NOT EXISTS driver_licensing_authorities (
        id TEXT PRIMARY KEY,
        driver_id TEXT NOT NULL,
        licensing_authority_id TEXT NOT NULL REFERENCES licensing_authorities(id),
        license_reference TEXT,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        revoked_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (valid_until IS NULL OR valid_until > valid_from)
      );
      CREATE INDEX IF NOT EXISTS idx_driver_licenses_lookup
        ON driver_licensing_authorities (driver_id, licensing_authority_id);

      ALTER TABLE customer_bookings ADD COLUMN IF NOT EXISTS operator_id TEXT;
      ALTER TABLE customer_bookings ADD COLUMN IF NOT EXISTS driver_id TEXT;
      ALTER TABLE customer_bookings ADD COLUMN IF NOT EXISTS vehicle_id TEXT
        REFERENCES vehicles(id);
      ALTER TABLE customer_bookings ADD COLUMN IF NOT EXISTS licensing_authority_id TEXT
        REFERENCES licensing_authorities(id);
      ALTER TABLE customer_bookings ADD COLUMN IF NOT EXISTS assignment_status TEXT
        NOT NULL DEFAULT 'unassigned';
      ALTER TABLE customer_bookings ADD COLUMN IF NOT EXISTS assignment_review_required BOOLEAN
        NOT NULL DEFAULT FALSE;
      ALTER TABLE customer_bookings ADD COLUMN IF NOT EXISTS assigned_at TEXT;
      ALTER TABLE customer_bookings ADD COLUMN IF NOT EXISTS assigned_by TEXT;
      ALTER TABLE customer_bookings ADD COLUMN IF NOT EXISTS assignment_source TEXT;
      ALTER TABLE customer_bookings ADD COLUMN IF NOT EXISTS assignment_reason TEXT;
      CREATE INDEX IF NOT EXISTS idx_customer_bookings_authority
        ON customer_bookings (licensing_authority_id, service_date);

      CREATE TABLE IF NOT EXISTS booking_assignment_audit (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES customer_bookings(id) ON DELETE CASCADE,
        operator_id TEXT,
        driver_id TEXT,
        vehicle_id TEXT,
        licensing_authority_id TEXT REFERENCES licensing_authorities(id),
        assigned_at TEXT NOT NULL,
        actor_id TEXT,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_booking_assignment_audit_booking
        ON booking_assignment_audit (booking_id, assigned_at);
    `
  },
  {
    id: "0006_customer_lifecycle_retention",
    sql: `
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS inactive_at TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS anonymized_at TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS erasure_requested_at TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS retention_hold_until TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS retention_hold_reason TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS purge_after TEXT;

      UPDATE customers
      SET status = 'Active',
          retention_hold_reason = COALESCE(retention_hold_reason, 'Legacy Pending status requires review'),
          updated_at = COALESCE(updated_at, now()::text)
      WHERE status = 'Pending';
      UPDATE customers
      SET status = 'Suspended',
          retention_hold_reason = COALESCE(retention_hold_reason, 'Legacy Delete Pending status requires review'),
          erasure_requested_at = COALESCE(erasure_requested_at, updated_at),
          updated_at = COALESCE(updated_at, now()::text)
      WHERE status = 'Delete Pending';

      CREATE INDEX IF NOT EXISTS idx_customers_operational
        ON customers (deleted_at, anonymized_at, inactive_at, erasure_requested_at);
      CREATE INDEX IF NOT EXISTS idx_customers_inactivity_candidates
        ON customers (last_booking_at, inactive_at)
        WHERE deleted_at IS NULL AND anonymized_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_customers_purge_candidates
        ON customers (purge_after, anonymized_at)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_customers_retention_holds
        ON customers (retention_hold_until)
        WHERE retention_hold_until IS NOT NULL;
    `
  },
  {
    id: "0007_staff_login_audit",
    sql: `
      CREATE TABLE IF NOT EXISTS staff_login_audit (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        event_name TEXT NOT NULL,
        account_id TEXT,
        login_identifier TEXT,
        success BOOLEAN NOT NULL,
        failure_category TEXT,
        ip_address TEXT,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_staff_login_audit_occurred_at
        ON staff_login_audit (occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_staff_login_audit_account
        ON staff_login_audit (account_id, occurred_at DESC);
    `
  },
  {
    id: "0008_operator_setup_foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS operators (
        id TEXT PRIMARY KEY,
        legal_name TEXT NOT NULL,
        trading_name TEXT,
        license_holder_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'setup_required'
          CHECK (status IN ('setup_required', 'active', 'suspended', 'archived')),
        created_by_user_id TEXT,
        created_by_user_email TEXT,
        updated_by_user_id TEXT,
        updated_by_user_email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operators_status
        ON operators (status);

      CREATE TABLE IF NOT EXISTS operator_addresses (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
        address_type TEXT NOT NULL
          CHECK (address_type IN ('registered_pho', 'operational')),
        formatted_address TEXT,
        house_name_number TEXT,
        address_line1 TEXT,
        address_line2 TEXT,
        address_line3 TEXT,
        city_town TEXT,
        county TEXT,
        state TEXT,
        postcode TEXT,
        country_code TEXT
          CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
        country_name TEXT,
        latitude DOUBLE PRECISION
          CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
        longitude DOUBLE PRECISION
          CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
        provider_name TEXT,
        provider_place_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (operator_id, address_type)
      );
      CREATE INDEX IF NOT EXISTS idx_operator_addresses_country_code
        ON operator_addresses (country_code);

      CREATE TABLE IF NOT EXISTS operator_licences (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        licence_type TEXT NOT NULL DEFAULT 'pho'
          CHECK (licence_type IN ('pho')),
        licence_number TEXT NOT NULL,
        licensing_authority_id TEXT REFERENCES licensing_authorities(id),
        valid_from DATE NOT NULL,
        valid_to DATE,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'active', 'expired', 'suspended', 'revoked')),
        created_by_user_id TEXT,
        created_by_user_email TEXT,
        updated_by_user_id TEXT,
        updated_by_user_email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (valid_to IS NULL OR valid_to > valid_from)
      );
      CREATE INDEX IF NOT EXISTS idx_operator_licences_operator
        ON operator_licences (operator_id);
      CREATE INDEX IF NOT EXISTS idx_operator_licences_status
        ON operator_licences (status);
      CREATE INDEX IF NOT EXISTS idx_operator_licences_validity
        ON operator_licences (valid_from, valid_to);

      CREATE TABLE IF NOT EXISTS operator_licence_documents (
        id TEXT PRIMARY KEY,
        licence_id TEXT NOT NULL REFERENCES operator_licences(id) ON DELETE CASCADE,
        original_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size BIGINT NOT NULL CHECK (byte_size > 0),
        checksum TEXT NOT NULL,
        storage_key TEXT,
        content BYTEA,
        is_latest BOOLEAN NOT NULL DEFAULT TRUE,
        superseded_at TEXT,
        uploaded_by_user_id TEXT,
        uploaded_by_user_email TEXT,
        uploaded_at TEXT NOT NULL,
        CHECK (storage_key IS NOT NULL OR content IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_operator_licence_documents_licence
        ON operator_licence_documents (licence_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_licence_documents_latest
        ON operator_licence_documents (licence_id)
        WHERE is_latest = TRUE;

      CREATE TABLE IF NOT EXISTS operator_licence_history (
        id TEXT PRIMARY KEY,
        licence_id TEXT NOT NULL REFERENCES operator_licences(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL
          CHECK (
            event_type IN (
              'created',
              'updated',
              'status_changed',
              'document_uploaded',
              'document_replaced',
              'document_removed'
            )
          ),
        actor_user_id TEXT,
        actor_user_email TEXT,
        previous_status TEXT,
        next_status TEXT,
        summary TEXT NOT NULL,
        metadata JSONB,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operator_licence_history_licence_time
        ON operator_licence_history (licence_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_operator_licence_history_actor_time
        ON operator_licence_history (actor_user_id, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS system_setup_state (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
        setup_key TEXT NOT NULL
          CHECK (setup_key IN ('initial_system_setup')),
        status TEXT NOT NULL DEFAULT 'incomplete'
          CHECK (status IN ('incomplete', 'in_progress', 'completed')),
        started_at TEXT,
        started_by_user_id TEXT,
        started_by_user_email TEXT,
        completed_at TEXT,
        completed_by_user_id TEXT,
        completed_by_user_email TEXT,
        last_edited_at TEXT,
        last_edited_by_user_id TEXT,
        last_edited_by_user_email TEXT,
        UNIQUE (setup_key)
      );
      CREATE INDEX IF NOT EXISTS idx_system_setup_state_operator
        ON system_setup_state (operator_id);
    `
  },
  {
    id: "0009_initial_setup_wizard_and_test_safety",
    sql: `
      CREATE TABLE IF NOT EXISTS system_setup_bootstrap (
        id TEXT PRIMARY KEY,
        bootstrap_key TEXT NOT NULL UNIQUE
          CHECK (bootstrap_key IN ('initial_superuser_bootstrap')),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'completed')),
        installer_user_id TEXT,
        installer_email_normalized TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS system_setup_steps (
        setup_key TEXT NOT NULL
          CHECK (setup_key IN ('initial_system_setup')),
        step_key TEXT NOT NULL
          CHECK (
            step_key IN (
              'bootstrap_superuser',
              'operator_profile',
              'registered_pho_address',
              'operational_address',
              'pho_licence',
              'licence_document',
              'review_confirmation',
              'completed'
            )
          ),
        completed_at TEXT NOT NULL,
        completed_by_user_id TEXT,
        completed_by_user_email TEXT,
        PRIMARY KEY (setup_key, step_key)
      );

      CREATE TABLE IF NOT EXISTS system_setup_audit_events (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        event_name TEXT NOT NULL,
        actor_user_id TEXT,
        actor_user_email TEXT,
        setup_key TEXT,
        operator_id TEXT,
        summary TEXT NOT NULL,
        metadata JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_system_setup_audit_occurred_at
        ON system_setup_audit_events (occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_system_setup_audit_operator
        ON system_setup_audit_events (operator_id, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS system_test_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        role_key TEXT NOT NULL,
        email_normalized_snapshot TEXT NOT NULL,
        purpose TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deactivated_at TEXT,
        deactivated_by_user_id TEXT,
        UNIQUE (user_id, role_key)
      );
      CREATE INDEX IF NOT EXISTS idx_system_test_accounts_active
        ON system_test_accounts (active, role_key);
      CREATE INDEX IF NOT EXISTS idx_system_test_accounts_email
        ON system_test_accounts (email_normalized_snapshot);

      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS total_fare_amount NUMERIC(12, 2);
      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS is_test_booking BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS test_account_user_id TEXT;
      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS test_reason TEXT;
      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS test_marked_at TEXT;
      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS test_marked_by_user_id TEXT;

      ALTER TABLE customer_bookings
        DROP CONSTRAINT IF EXISTS chk_customer_bookings_test_fields;
      ALTER TABLE customer_bookings
        ADD CONSTRAINT chk_customer_bookings_test_fields
        CHECK (
          (is_test_booking = TRUE AND test_account_user_id IS NOT NULL AND length(trim(COALESCE(test_reason, ''))) > 0)
          OR
          (is_test_booking = FALSE AND test_account_user_id IS NULL AND COALESCE(test_reason, '') = '')
        );

      CREATE INDEX IF NOT EXISTS idx_customer_bookings_test_booking
        ON customer_bookings (is_test_booking, service_date DESC);
      CREATE INDEX IF NOT EXISTS idx_customer_bookings_test_account
        ON customer_bookings (test_account_user_id, service_date DESC)
        WHERE test_account_user_id IS NOT NULL;

      CREATE OR REPLACE FUNCTION rm_enforce_test_booking_policy() RETURNS trigger AS $$
      BEGIN
        IF NEW.is_test_booking THEN
          IF NEW.test_account_user_id IS NULL THEN
            RAISE EXCEPTION 'Test bookings require a registered test account user id.';
          END IF;

          IF NOT EXISTS (
            SELECT 1
            FROM system_test_accounts ta
            WHERE ta.user_id = NEW.test_account_user_id
              AND ta.active = TRUE
          ) THEN
            RAISE EXCEPTION 'Only active registered test accounts may create test bookings.';
          END IF;
        ELSE
          IF lower(COALESCE(NEW.assignment_status, '')) = 'assigned'
             AND (NEW.total_fare_amount IS NULL OR NEW.total_fare_amount <= 0) THEN
            RAISE EXCEPTION 'Non-test bookings must have a positive fare amount.';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_customer_bookings_test_policy ON customer_bookings;
      CREATE TRIGGER trg_customer_bookings_test_policy
      BEFORE INSERT OR UPDATE OF is_test_booking, test_account_user_id, test_reason, total_fare_amount, assignment_status
      ON customer_bookings
      FOR EACH ROW
      EXECUTE FUNCTION rm_enforce_test_booking_policy();
    `
  },
  {
    id: "0010_operator_trial_status",
    sql: `
      ALTER TABLE operators
        DROP CONSTRAINT IF EXISTS operators_status_check;
      ALTER TABLE operators
        ADD CONSTRAINT operators_status_check
        CHECK (status IN ('setup_required', 'trial', 'active', 'suspended', 'archived'));
      ALTER TABLE operators
        ADD COLUMN IF NOT EXISTS trial_started_at TEXT,
        ADD COLUMN IF NOT EXISTS trial_ends_at TEXT;
    `
  },
  {
    id: "0011_staff_profiles",
    sql: `
      CREATE TABLE IF NOT EXISTS staff_profiles (
        account_id TEXT PRIMARY KEY,
        display_name TEXT,
        CHECK (display_name IS NULL OR (
          display_name = btrim(display_name)
          AND char_length(display_name) BETWEEN 1 AND 100
          AND display_name !~ '[[:cntrl:]]'
        ))
      );
    `
  },
  {
    id: "0012_vehicle_license_badges_and_document_metadata",
    sql: `
      ALTER TABLE vehicle_licensing_authorities
        ADD COLUMN IF NOT EXISTS license_type TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_license_badge TEXT;
      ALTER TABLE vehicle_licensing_authorities
        DROP CONSTRAINT IF EXISTS vehicle_licensing_authorities_license_type_check;
      ALTER TABLE vehicle_licensing_authorities
        ADD CONSTRAINT vehicle_licensing_authorities_license_type_check
          CHECK (license_type IS NULL OR license_type IN ('hackney_carriage', 'private_hire'));
      ALTER TABLE vehicle_licensing_authorities
        DROP CONSTRAINT IF EXISTS vehicle_licensing_authorities_badge_check;
      ALTER TABLE vehicle_licensing_authorities
        ADD CONSTRAINT vehicle_licensing_authorities_badge_check
          CHECK (vehicle_license_badge IS NULL OR (
            vehicle_license_badge = btrim(vehicle_license_badge)
            AND char_length(vehicle_license_badge) BETWEEN 1 AND 64
            AND vehicle_license_badge !~ '[[:cntrl:]]'
          ));

      ALTER TABLE vehicle_documents
        ADD COLUMN IF NOT EXISTS license_id TEXT REFERENCES vehicle_licensing_authorities(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS byte_size BIGINT,
        ADD COLUMN IF NOT EXISTS checksum TEXT;
      UPDATE vehicle_documents
        SET byte_size = octet_length(content)
        WHERE byte_size IS NULL AND content IS NOT NULL;
      ALTER TABLE vehicle_documents
        DROP CONSTRAINT IF EXISTS vehicle_documents_byte_size_check;
      ALTER TABLE vehicle_documents
        ADD CONSTRAINT vehicle_documents_byte_size_check
          CHECK (byte_size IS NULL OR byte_size >= 0);
      ALTER TABLE vehicle_documents
        DROP CONSTRAINT IF EXISTS vehicle_documents_checksum_check;
      ALTER TABLE vehicle_documents
        ADD CONSTRAINT vehicle_documents_checksum_check
          CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$');

      DROP INDEX IF EXISTS idx_vehicle_documents_latest_type;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_documents_latest_type_license
        ON vehicle_documents(vehicle_id, document_type, COALESCE(license_id, ''))
        WHERE is_latest = TRUE;

      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS vehicle_license_type TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_license_badge TEXT;
      ALTER TABLE customer_bookings
        DROP CONSTRAINT IF EXISTS customer_bookings_vehicle_license_type_check;
      ALTER TABLE customer_bookings
        ADD CONSTRAINT customer_bookings_vehicle_license_type_check
          CHECK (vehicle_license_type IS NULL OR vehicle_license_type IN ('hackney_carriage', 'private_hire'));
      ALTER TABLE booking_assignment_audit
        ADD COLUMN IF NOT EXISTS vehicle_license_type TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_license_badge TEXT;
    `
  },
  {
    id: "0013_vehicle_licence_fields",
    sql: `
      ALTER TABLE vehicles
        ADD COLUMN IF NOT EXISTS vehicle_license_type TEXT,
        ADD COLUMN IF NOT EXISTS vehicle_license_badge TEXT;
      ALTER TABLE vehicles
        DROP CONSTRAINT IF EXISTS vehicles_vehicle_license_type_check;
      ALTER TABLE vehicles
        ADD CONSTRAINT vehicles_vehicle_license_type_check
          CHECK (vehicle_license_type IS NULL OR vehicle_license_type IN ('hackney_carriage', 'private_hire'));
      ALTER TABLE vehicles
        DROP CONSTRAINT IF EXISTS vehicles_vehicle_license_badge_check;
      ALTER TABLE vehicles
        ADD CONSTRAINT vehicles_vehicle_license_badge_check
          CHECK (vehicle_license_badge IS NULL OR (
            vehicle_license_badge = btrim(vehicle_license_badge)
            AND char_length(vehicle_license_badge) BETWEEN 1 AND 64
            AND vehicle_license_badge !~ '[[:cntrl:]]'
          ));
    `
  },
  {
    id: "0014_entity_documents_docuvault",
    sql: `
      CREATE TABLE IF NOT EXISTS entity_documents (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('vehicle', 'driver', 'operator')),
        entity_id TEXT NOT NULL,
        category TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size BIGINT NOT NULL CHECK (byte_size > 0),
        checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        storage_path TEXT NOT NULL UNIQUE,
        uploaded_by TEXT,
        uploaded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entity_documents_entity
        ON entity_documents (entity_type, entity_id, category, uploaded_at DESC);

      CREATE TABLE IF NOT EXISTS document_access_events (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES entity_documents(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('upload', 'view', 'download')),
        actor_id TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_document_access_events_document
        ON document_access_events (document_id, occurred_at DESC);
    `
  },
  {
    id: "0015_vehicle_license_optional_authority",
    sql: `
      ALTER TABLE vehicle_licensing_authorities
        ALTER COLUMN licensing_authority_id DROP NOT NULL;
    `
  },
  {
    id: "0016_staff_role_change_audit",
    sql: `
      CREATE TABLE IF NOT EXISTS staff_role_change_audit (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        event_name TEXT NOT NULL,
        actor_account_id TEXT,
        actor_email TEXT,
        target_account_id TEXT,
        target_email TEXT,
        success BOOLEAN NOT NULL,
        reason TEXT,
        before_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
        after_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_staff_role_change_audit_target
        ON staff_role_change_audit (target_account_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_staff_role_change_audit_occurred_at
        ON staff_role_change_audit (occurred_at DESC);
    `
  },
  {
    id: "0017_driver_profiles",
    sql: `
      CREATE TABLE IF NOT EXISTS driver_profiles (
        driver_id TEXT PRIMARY KEY,
        first_name TEXT NOT NULL CHECK (
          first_name = btrim(first_name)
          AND char_length(first_name) BETWEEN 1 AND 100
          AND first_name !~ '[[:cntrl:]]'
        ),
        last_name TEXT NOT NULL CHECK (
          last_name = btrim(last_name)
          AND char_length(last_name) BETWEEN 1 AND 100
          AND last_name !~ '[[:cntrl:]]'
        ),
        short_name TEXT NOT NULL CHECK (
          short_name = btrim(short_name)
          AND char_length(short_name) BETWEEN 1 AND 160
          AND short_name !~ '[[:cntrl:]]'
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_driver_profiles_short_name
        ON driver_profiles (lower(short_name), driver_id);
    `
  },
  {
    id: "0018_driver_lifecycle_legacy_profiles",
    sql: `
      ALTER TABLE driver_profiles
        ALTER COLUMN first_name DROP NOT NULL,
        ALTER COLUMN last_name DROP NOT NULL,
        ALTER COLUMN short_name DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'pending_review',
        ADD COLUMN IF NOT EXISTS manual_review_required BOOLEAN NOT NULL DEFAULT FALSE;

      ALTER TABLE driver_profiles
        DROP CONSTRAINT IF EXISTS driver_profiles_lifecycle_status_check;
      ALTER TABLE driver_profiles
        ADD CONSTRAINT driver_profiles_lifecycle_status_check
          CHECK (lifecycle_status IN ('pending_review', 'active', 'rejected', 'suspended', 'archived'));

      UPDATE driver_profiles dp
         SET short_name = COALESCE(
               NULLIF(left(regexp_replace(btrim(concat_ws(' ', NULLIF(btrim(dp.first_name), ''), NULLIF(btrim(dp.last_name), ''))), '[[:cntrl:]]', '', 'g'), 160), ''),
               NULLIF(left(regexp_replace(btrim(to_jsonb(u) ->> 'full_name'), '[[:cntrl:]]', '', 'g'), 160), ''),
               NULLIF(left(regexp_replace(btrim(concat_ws(' ',
                 NULLIF(btrim(to_jsonb(u) ->> 'first_name'), ''),
                 NULLIF(btrim(to_jsonb(u) ->> 'last_name'), '')
               )), '[[:cntrl:]]', '', 'g'), 160), ''),
               CASE WHEN NULLIF(split_part(COALESCE(u.email, ''), '@', 1), '') IS NOT NULL
                 THEN left(split_part(u.email, '@', 1), 1) || '***' END
             ),
             manual_review_required = (NULLIF(btrim(dp.first_name), '') IS NULL OR NULLIF(btrim(dp.last_name), '') IS NULL),
             lifecycle_status = CASE
               WHEN lower(COALESCE(u.status::text, '')) = 'active'
                AND NULLIF(btrim(dp.first_name), '') IS NOT NULL
                AND NULLIF(btrim(dp.last_name), '') IS NOT NULL
                AND EXISTS (
                  SELECT 1
                    FROM driver_licensing_authorities dl
                    JOIN licensing_authorities la ON la.id = dl.licensing_authority_id AND la.active = TRUE
                   WHERE dl.driver_id = dp.driver_id
                     AND dl.active = TRUE AND dl.revoked_at IS NULL
                     AND dl.valid_from <= CURRENT_DATE::text
                     AND (dl.valid_until IS NULL OR dl.valid_until > CURRENT_DATE::text)
                ) THEN 'active'
               ELSE 'pending_review'
             END
        FROM users u
       WHERE u.id::text = dp.driver_id
         AND (NULLIF(btrim(dp.short_name), '') IS NULL
           OR dp.manual_review_required = FALSE
           OR dp.lifecycle_status = 'pending_review');

      INSERT INTO driver_profiles
        (driver_id, short_name, lifecycle_status, manual_review_required, created_at, updated_at)
      SELECT u.id::text,
             COALESCE(
               NULLIF(left(regexp_replace(btrim(to_jsonb(u) ->> 'full_name'), '[[:cntrl:]]', '', 'g'), 160), ''),
               NULLIF(left(regexp_replace(btrim(concat_ws(' ',
                 NULLIF(btrim(to_jsonb(u) ->> 'first_name'), ''),
                 NULLIF(btrim(to_jsonb(u) ->> 'last_name'), '')
               )), '[[:cntrl:]]', '', 'g'), 160), ''),
               CASE WHEN NULLIF(split_part(COALESCE(u.email, ''), '@', 1), '') IS NOT NULL
                 THEN left(split_part(u.email, '@', 1), 1) || '***' END
             ),
             'pending_review',
             TRUE,
             CURRENT_TIMESTAMP::text,
             CURRENT_TIMESTAMP::text
        FROM users u
       WHERE EXISTS (
         SELECT 1 FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id AND r.key = 'driver'
       )
         AND NOT EXISTS (
           SELECT 1 FROM driver_profiles dp WHERE dp.driver_id = u.id::text
         );

      CREATE TABLE IF NOT EXISTS driver_lifecycle_audit (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        actor_id TEXT,
        actor_email TEXT,
        previous_status TEXT,
        requested_status TEXT NOT NULL,
        reason TEXT,
        success BOOLEAN NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_driver_lifecycle_audit_driver
        ON driver_lifecycle_audit (driver_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_driver_lifecycle_audit_occurred_at
        ON driver_lifecycle_audit (occurred_at DESC);
    `
  },
  {
    id: "0019_driver_remove_technical_display_labels",
    sql: `
      UPDATE driver_profiles dp
         SET first_name = COALESCE(NULLIF(btrim(dp.first_name), ''), NULLIF(btrim(to_jsonb(u) ->> 'first_name'), '')),
             last_name = COALESCE(NULLIF(btrim(dp.last_name), ''), NULLIF(btrim(to_jsonb(u) ->> 'last_name'), '')),
             short_name = COALESCE(
               NULLIF(left(regexp_replace(btrim(concat_ws(' ',
                 NULLIF(btrim(to_jsonb(u) ->> 'first_name'), ''),
                 NULLIF(btrim(to_jsonb(u) ->> 'last_name'), '')
               )), '[[:cntrl:]]', '', 'g'), 160), ''),
               CASE WHEN NULLIF(split_part(COALESCE(u.email, ''), '@', 1), '') IS NOT NULL
                 THEN left(split_part(u.email, '@', 1), 1) || '***' END
             ),
             manual_review_required = dp.manual_review_required OR (
               COALESCE(NULLIF(btrim(dp.first_name), ''), NULLIF(btrim(to_jsonb(u) ->> 'first_name'), '')) IS NULL
               OR COALESCE(NULLIF(btrim(dp.last_name), ''), NULLIF(btrim(to_jsonb(u) ->> 'last_name'), '')) IS NULL
             ),
             updated_at = CURRENT_TIMESTAMP::text
        FROM users u
       WHERE u.id::text = dp.driver_id
         AND dp.short_name ~* '^Driver[[:space:]]*#';
    `
  },
  {
    id: "0020_seed_dorset_council_licensing_authority",
    sql: `
      INSERT INTO licensing_authorities
        (id, name, authority_type, active, preference_order, created_at, updated_at)
      VALUES
        ('dorset_council', 'Dorset Council', 'local', TRUE, 0, CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        authority_type = EXCLUDED.authority_type,
        active = TRUE,
        preference_order = EXCLUDED.preference_order,
        updated_at = EXCLUDED.updated_at;
    `
  },
  {
    id: "0021_business_customers",
    sql: `
      CREATE TABLE IF NOT EXISTS business_customers (
        customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
        registered_name TEXT NOT NULL,
        registered_address JSONB NOT NULL CHECK (jsonb_typeof(registered_address) = 'object'),
        operational_address JSONB NOT NULL CHECK (jsonb_typeof(operational_address) = 'object'),
        office_phone TEXT NOT NULL,
        office_email TEXT NOT NULL,
        booker_full_name TEXT NOT NULL,
        booker_email TEXT NOT NULL,
        booker_phone TEXT NOT NULL,
        booking_auth_required BOOLEAN NOT NULL,
        booking_auth_channel TEXT,
        accounts_full_name TEXT NOT NULL CHECK (btrim(accounts_full_name) <> ''),
        accounts_email TEXT NOT NULL CHECK (btrim(accounts_email) <> ''),
        accounts_phone TEXT,
        CONSTRAINT business_customers_auth_channel_check CHECK (
          (booking_auth_required = FALSE AND booking_auth_channel IS NULL)
          OR (booking_auth_required = TRUE AND booking_auth_channel IS NOT NULL
            AND booking_auth_channel IN ('email', 'whatsapp', 'both'))
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_bookings_customer_id_id
        ON customer_bookings (customer_id, id);

      CREATE TABLE IF NOT EXISTS booking_authorization_requests (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES business_customers(customer_id) ON DELETE CASCADE,
        booking_id TEXT NOT NULL REFERENCES customer_bookings(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
        expires_at TIMESTAMPTZ NOT NULL,
        decided_at TIMESTAMPTZ,
        decided_by_channel TEXT CHECK (decided_by_channel IN ('email', 'whatsapp')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT booking_authorization_requests_customer_booking_fk
          FOREIGN KEY (customer_id, booking_id) REFERENCES customer_bookings(customer_id, id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_booking_authorization_requests_customer_id
        ON booking_authorization_requests (customer_id);
      CREATE INDEX IF NOT EXISTS idx_booking_authorization_requests_booking_id
        ON booking_authorization_requests (booking_id);
    `
  },
  {
    id: "0022_london_fee_schedule_drafts",
    sql: `
      CREATE TABLE IF NOT EXISTS london_fee_schedule_versions (
        id TEXT PRIMARY KEY,
        scheme TEXT NOT NULL CHECK (scheme IN ('london-lez', 'london-ulez')),
        version INTEGER NOT NULL CHECK (version > 0),
        status TEXT NOT NULL CHECK (status = 'draft_inactive'),
        payload JSONB NOT NULL CHECK (
          jsonb_typeof(payload) = 'object'
          AND payload->>'status' = 'draft_inactive'
          AND payload->>'active' = 'false'
          AND payload->>'bookingPriceUsage' = 'never'
        ),
        actor_account_id TEXT,
        actor_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (scheme, version)
      );

      CREATE INDEX IF NOT EXISTS idx_london_fee_schedule_versions_scheme_version
        ON london_fee_schedule_versions (scheme, version DESC);

      CREATE OR REPLACE FUNCTION rm_reject_london_fee_schedule_version_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'London fee schedule versions are append-only.';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS london_fee_schedule_versions_append_only
        ON london_fee_schedule_versions;
      CREATE TRIGGER london_fee_schedule_versions_append_only
        BEFORE UPDATE OR DELETE ON london_fee_schedule_versions
        FOR EACH ROW EXECUTE FUNCTION rm_reject_london_fee_schedule_version_mutation();

      INSERT INTO london_fee_schedule_versions
        (id, scheme, version, status, payload, actor_email)
      VALUES
        (
          'london-lez-draft-v1',
          'london-lez',
          1,
          'draft_inactive',
          '${JSON.stringify(londonFeeScheduleDrafts["london-lez"]).replace(/'/g, "''")}'::jsonb,
          'Initial supplied draft'
        ),
        (
          'london-ulez-draft-v1',
          'london-ulez',
          1,
          'draft_inactive',
          '${JSON.stringify(londonFeeScheduleDrafts["london-ulez"]).replace(/'/g, "''")}'::jsonb,
          'Initial supplied draft'
        )
      ON CONFLICT (scheme, version) DO NOTHING;
    `
  },
  {
    id: "0023_crossing_fee_schedule_drafts",
    sql: `
      ALTER TABLE london_fee_schedule_versions
        DROP CONSTRAINT IF EXISTS london_fee_schedule_versions_scheme_check;
      ALTER TABLE london_fee_schedule_versions
        ADD CONSTRAINT london_fee_schedule_versions_scheme_check
        CHECK (scheme IN ('london-lez', 'london-ulez', 'dartford-crossing', 'blackwall-silvertown-tunnels'));

      INSERT INTO london_fee_schedule_versions
        (id, scheme, version, status, payload, actor_email)
      VALUES
        (
          'dartford-crossing-draft-v1',
          'dartford-crossing',
          1,
          'draft_inactive',
          '${JSON.stringify(crossingFeeScheduleDrafts["dartford-crossing"]).replace(/'/g, "''")}'::jsonb,
          'Initial supplied draft'
        ),
        (
          'blackwall-silvertown-tunnels-draft-v1',
          'blackwall-silvertown-tunnels',
          1,
          'draft_inactive',
          '${JSON.stringify(crossingFeeScheduleDrafts["blackwall-silvertown-tunnels"]).replace(/'/g, "''")}'::jsonb,
          'Initial supplied draft'
        )
      ON CONFLICT (scheme, version) DO NOTHING;
    `
  },
  {
    id: "0024_airport_fee_configurations",
    sql: `
      CREATE TABLE IF NOT EXISTS airport_fee_configurations (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
        dropoff_place_id TEXT NOT NULL CHECK (length(trim(dropoff_place_id)) BETWEEN 1 AND 500),
        dropoff_location_label TEXT NOT NULL CHECK (length(trim(dropoff_location_label)) BETWEEN 1 AND 500),
        dropoff_latitude NUMERIC(10, 7) NOT NULL CHECK (dropoff_latitude BETWEEN -90 AND 90),
        dropoff_longitude NUMERIC(10, 7) NOT NULL CHECK (dropoff_longitude BETWEEN -180 AND 180),
        dropoff_fee NUMERIC(8, 2) NOT NULL CHECK (dropoff_fee BETWEEN 0 AND 999999.99),
        pickup_place_id TEXT NOT NULL CHECK (length(trim(pickup_place_id)) BETWEEN 1 AND 500),
        pickup_location_label TEXT NOT NULL CHECK (length(trim(pickup_location_label)) BETWEEN 1 AND 500),
        pickup_latitude NUMERIC(10, 7) NOT NULL CHECK (pickup_latitude BETWEEN -90 AND 90),
        pickup_longitude NUMERIC(10, 7) NOT NULL CHECK (pickup_longitude BETWEEN -180 AND 180),
        pickup_fee NUMERIC(8, 2) NOT NULL CHECK (pickup_fee BETWEEN 0 AND 999999.99),
        created_by_account_id TEXT,
        created_by_email TEXT,
        updated_by_account_id TEXT,
        updated_by_email TEXT,
        archived_at TIMESTAMPTZ,
        archived_by_account_id TEXT,
        archived_by_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_airport_fee_configurations_active
        ON airport_fee_configurations (display_name, id)
        WHERE archived_at IS NULL;

      CREATE TABLE IF NOT EXISTS airport_fee_configuration_audit (
        id BIGSERIAL PRIMARY KEY,
        airport_id TEXT NOT NULL REFERENCES airport_fee_configurations(id),
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'archived')),
        snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
        actor_account_id TEXT,
        actor_email TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_airport_fee_configuration_audit_airport
        ON airport_fee_configuration_audit (airport_id, occurred_at DESC);

      CREATE OR REPLACE FUNCTION rm_reject_airport_fee_configuration_audit_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Airport fee configuration audit events are append-only.';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS airport_fee_configuration_audit_append_only
        ON airport_fee_configuration_audit;
      CREATE TRIGGER airport_fee_configuration_audit_append_only
        BEFORE UPDATE OR DELETE ON airport_fee_configuration_audit
        FOR EACH ROW EXECUTE FUNCTION rm_reject_airport_fee_configuration_audit_mutation();
    `
  },
  {
    id: "0025_airport_pickup_timing_policy",
    sql: `
      ALTER TABLE airport_fee_configurations
        ADD COLUMN IF NOT EXISTS pickup_time_reference TEXT,
        ADD COLUMN IF NOT EXISTS pickup_deferred_enabled BOOLEAN,
        ADD COLUMN IF NOT EXISTS pickup_deferred_minutes INTEGER,
        ADD COLUMN IF NOT EXISTS pickup_fee_covered_minutes INTEGER;

      ALTER TABLE airport_fee_configurations
        DROP CONSTRAINT IF EXISTS airport_fee_configurations_pickup_time_reference_check,
        ADD CONSTRAINT airport_fee_configurations_pickup_time_reference_check
          CHECK (pickup_time_reference IS NULL OR pickup_time_reference IN ('ALT', 'AGA')),
        DROP CONSTRAINT IF EXISTS airport_fee_configurations_pickup_deferred_minutes_check,
        ADD CONSTRAINT airport_fee_configurations_pickup_deferred_minutes_check
          CHECK (pickup_deferred_minutes IS NULL OR pickup_deferred_minutes IN (0, 15, 30, 45, 60)),
        DROP CONSTRAINT IF EXISTS airport_fee_configurations_pickup_fee_covered_minutes_check,
        ADD CONSTRAINT airport_fee_configurations_pickup_fee_covered_minutes_check
          CHECK (pickup_fee_covered_minutes IS NULL OR pickup_fee_covered_minutes IN (10, 15, 20, 30, 40, 45, 60)),
        DROP CONSTRAINT IF EXISTS airport_fee_configurations_pickup_deferred_policy_check,
        ADD CONSTRAINT airport_fee_configurations_pickup_deferred_policy_check
          CHECK (
            pickup_deferred_enabled IS NULL OR
            (pickup_deferred_minutes IS NOT NULL AND (
              (pickup_deferred_enabled = FALSE AND pickup_deferred_minutes = 0) OR
              (pickup_deferred_enabled = TRUE AND pickup_deferred_minutes IN (15, 30, 45, 60))
            ))
          );
    `
  },
  {
    id: "0026_fare_settings",
    sql: `
      CREATE TABLE IF NOT EXISTS fare_settings_current (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        configuration JSONB NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        updated_by_account_id TEXT,
        updated_by_email TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO fare_settings_current (id, configuration)
      VALUES (
        1,
        '{"timezone":"Europe/London","matchingBasis":"scheduled-service-time","interval":"start-inclusive-end-exclusive","precedence":"bank-holiday-over-daily","dailySurcharge":{"enabled":false,"percentage":"","startTime":"","endTime":""},"bankHolidaySurcharge":{"enabled":false,"periods":[]}}'::jsonb
      )
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS fare_settings_history (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE CHECK (version > 0),
        configuration JSONB NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
        actor_account_id TEXT,
        actor_email TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE OR REPLACE FUNCTION rm_reject_fare_settings_history_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Fare settings history is append-only.';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS fare_settings_history_append_only ON fare_settings_history;
      CREATE TRIGGER fare_settings_history_append_only
        BEFORE UPDATE OR DELETE ON fare_settings_history
        FOR EACH ROW EXECUTE FUNCTION rm_reject_fare_settings_history_mutation();
    `
  },
  {
    id: "0027_fare_settings_distance_slabs",
    sql: `
      UPDATE fare_settings_current
         SET configuration = jsonb_set(configuration, '{distanceSlabs}', '[]'::jsonb, true)
       WHERE NOT (configuration ? 'distanceSlabs');
    `
  },
  {
    id: "0028_fare_minimum_and_fixed_fares",
    sql: `
      UPDATE fare_settings_current
         SET configuration = jsonb_set(configuration, '{minimumFareRules}', '[]'::jsonb, true)
       WHERE NOT (configuration ? 'minimumFareRules');

      UPDATE fare_settings_current
         SET configuration = jsonb_set(configuration, '{fixedFares}', '[]'::jsonb, true)
       WHERE NOT (configuration ? 'fixedFares');
    `
  },
  {
    id: "0029_poi_management",
    sql: `
      CREATE TABLE IF NOT EXISTS points_of_interest (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
        category TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 100),
        place_id TEXT NOT NULL CHECK (length(trim(place_id)) BETWEEN 1 AND 500),
        location_label TEXT NOT NULL CHECK (length(trim(location_label)) BETWEEN 1 AND 500),
        latitude NUMERIC(10, 7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
        longitude NUMERIC(10, 7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
        notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
        created_by_account_id TEXT,
        created_by_email TEXT,
        updated_by_account_id TEXT,
        updated_by_email TEXT,
        deleted_at TIMESTAMPTZ,
        deleted_by_account_id TEXT,
        deleted_by_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_points_of_interest_active
        ON points_of_interest (display_name, id)
        WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS poi_fees (
        id TEXT PRIMARY KEY,
        poi_id TEXT NOT NULL REFERENCES points_of_interest(id) ON DELETE RESTRICT,
        action TEXT NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 100),
        amount NUMERIC(8, 2) NOT NULL CHECK (amount BETWEEN 0 AND 999999.99),
        currency TEXT NOT NULL CHECK (currency = 'GBP'),
        fee_basis TEXT NOT NULL CHECK (length(trim(fee_basis)) BETWEEN 1 AND 100),
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('selection', 'confirmation')),
        notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
        created_by_account_id TEXT,
        created_by_email TEXT,
        updated_by_account_id TEXT,
        updated_by_email TEXT,
        deleted_at TIMESTAMPTZ,
        deleted_by_account_id TEXT,
        deleted_by_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_poi_fees_active
        ON poi_fees (poi_id, action, id)
        WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS points_of_interest_audit (
        id BIGSERIAL PRIMARY KEY,
        poi_id TEXT NOT NULL REFERENCES points_of_interest(id),
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'deleted')),
        snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
        actor_account_id TEXT,
        actor_email TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_points_of_interest_audit_poi
        ON points_of_interest_audit (poi_id, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS poi_fees_audit (
        id BIGSERIAL PRIMARY KEY,
        poi_fee_id TEXT NOT NULL REFERENCES poi_fees(id),
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'deleted')),
        snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
        actor_account_id TEXT,
        actor_email TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_poi_fees_audit_fee
        ON poi_fees_audit (poi_fee_id, occurred_at DESC);

      CREATE OR REPLACE FUNCTION rm_reject_poi_audit_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'POI configuration audit events are append-only.';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS points_of_interest_audit_append_only ON points_of_interest_audit;
      CREATE TRIGGER points_of_interest_audit_append_only
        BEFORE UPDATE OR DELETE ON points_of_interest_audit
        FOR EACH ROW EXECUTE FUNCTION rm_reject_poi_audit_mutation();

      DROP TRIGGER IF EXISTS poi_fees_audit_append_only ON poi_fees_audit;
      CREATE TRIGGER poi_fees_audit_append_only
        BEFORE UPDATE OR DELETE ON poi_fees_audit
        FOR EACH ROW EXECUTE FUNCTION rm_reject_poi_audit_mutation();
    `
  },
  {
    id: "0030_dead_mileage",
    sql: `
      UPDATE fare_settings_current
         SET configuration = jsonb_set(
           configuration, '{deadMileage}', '{"freeRadiusMiles":""}'::jsonb, true
         )
       WHERE NOT (configuration ? 'deadMileage');

      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS vehicle_dispatched_from_base BOOLEAN,
        ADD COLUMN IF NOT EXISTS return_to_base_after_dropoff BOOLEAN;

      CREATE TABLE IF NOT EXISTS booking_dead_mileage_flag_audit (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL,
        vehicle_dispatched_from_base BOOLEAN NOT NULL,
        return_to_base_after_dropoff BOOLEAN NOT NULL,
        actor_id TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_booking_dead_mileage_flag_audit_booking
        ON booking_dead_mileage_flag_audit (booking_id, occurred_at DESC);

      CREATE OR REPLACE FUNCTION rm_reject_booking_dead_mileage_flag_audit_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Booking dead-mileage flag audit events are append-only.';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS booking_dead_mileage_flag_audit_append_only
        ON booking_dead_mileage_flag_audit;
      CREATE TRIGGER booking_dead_mileage_flag_audit_append_only
        BEFORE UPDATE OR DELETE ON booking_dead_mileage_flag_audit
        FOR EACH ROW EXECUTE FUNCTION rm_reject_booking_dead_mileage_flag_audit_mutation();
    `
  },
  {
    id: "0031_verified_operational_coordinates",
    sql: `
      ALTER TABLE operator_addresses
        ADD COLUMN IF NOT EXISTS coordinates_verified BOOLEAN NOT NULL DEFAULT FALSE;
    `
  },
  {
    id: "0032_minimum_fare_rules_without_radius",
    sql: `
      UPDATE fare_settings_current
         SET configuration = jsonb_set(
           configuration,
           '{minimumFareRules}',
           (
             SELECT COALESCE(
               jsonb_agg(rule_data - 'radiusMiles' ORDER BY ordinality),
               '[]'::jsonb
             )
               FROM jsonb_array_elements(configuration -> 'minimumFareRules')
                    WITH ORDINALITY AS rules(rule_data, ordinality)
           ),
           true
         )
       WHERE jsonb_typeof(configuration -> 'minimumFareRules') = 'array'
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(configuration -> 'minimumFareRules') AS rules(rule_data)
            WHERE rule_data ? 'radiusMiles'
         );
    `
  },
  {
    id: "0033_new_booking_price_snapshots",
    sql: `
      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS service_time TEXT,
        ADD COLUMN IF NOT EXISTS service_timezone TEXT,
        ADD COLUMN IF NOT EXISTS created_by_account_id TEXT,
        ADD COLUMN IF NOT EXISTS created_by_email TEXT,
        ADD COLUMN IF NOT EXISTS booking_manager_name TEXT,
        ADD COLUMN IF NOT EXISTS booking_manager_phone TEXT,
        ADD COLUMN IF NOT EXISTS booking_manager_email TEXT,
        ADD COLUMN IF NOT EXISTS passenger_is_booking_manager BOOLEAN,
        ADD COLUMN IF NOT EXISTS passenger_name TEXT,
        ADD COLUMN IF NOT EXISTS passenger_phone TEXT,
        ADD COLUMN IF NOT EXISTS adults SMALLINT,
        ADD COLUMN IF NOT EXISTS children SMALLINT,
        ADD COLUMN IF NOT EXISTS sports_equipment SMALLINT,
        ADD COLUMN IF NOT EXISTS xl_baggage SMALLINT,
        ADD COLUMN IF NOT EXISTS l_baggage SMALLINT,
        ADD COLUMN IF NOT EXISTS cabin_hand_bags SMALLINT,
        ADD COLUMN IF NOT EXISTS backpacks SMALLINT,
        ADD COLUMN IF NOT EXISTS child_seat_required BOOLEAN,
        ADD COLUMN IF NOT EXISTS booster_required BOOLEAN,
        ADD COLUMN IF NOT EXISTS price_status TEXT;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_bookings_new_booking_values_check') THEN
          ALTER TABLE customer_bookings ADD CONSTRAINT customer_bookings_new_booking_values_check CHECK (
            (price_status IS NULL OR price_status IN ('complete', 'incomplete'))
            AND (service_time IS NULL OR service_time ~ '^([01][0-9]|2[0-3]):[0-5][05]$')
            AND (adults IS NULL OR adults BETWEEN 0 AND 7)
            AND (children IS NULL OR children BETWEEN 0 AND 7)
            AND (sports_equipment IS NULL OR sports_equipment BETWEEN 0 AND 7)
            AND (xl_baggage IS NULL OR xl_baggage BETWEEN 0 AND 7)
            AND (l_baggage IS NULL OR l_baggage BETWEEN 0 AND 7)
            AND (cabin_hand_bags IS NULL OR cabin_hand_bags BETWEEN 0 AND 7)
            AND (backpacks IS NULL OR backpacks BETWEEN 0 AND 7)
          );
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS booking_journey_stops (
        booking_id TEXT NOT NULL REFERENCES customer_bookings(id) ON DELETE CASCADE,
        position SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 3),
        stop_type TEXT NOT NULL CHECK (stop_type IN ('pickup', 'via', 'dropoff')),
        location_kind TEXT NOT NULL CHECK (location_kind IN ('airport', 'poi', 'address')),
        managed_location_id TEXT,
        provider_place_id TEXT,
        label TEXT NOT NULL CHECK (btrim(label) <> ''),
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        postcode TEXT,
        coordinates_verified BOOLEAN NOT NULL,
        PRIMARY KEY (booking_id, position),
        CHECK ((location_kind = 'address') = (managed_location_id IS NULL)),
        CHECK ((latitude IS NULL) = (longitude IS NULL)),
        CHECK (NOT coordinates_verified OR latitude IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS booking_price_snapshots (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL UNIQUE REFERENCES customer_bookings(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('complete', 'incomplete')),
        currency TEXT NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
        total_amount NUMERIC(12,2),
        fare_settings_version INTEGER,
        inputs JSONB NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
        route JSONB NOT NULL CHECK (jsonb_typeof(route) = 'object'),
        calculation JSONB NOT NULL CHECK (jsonb_typeof(calculation) = 'object'),
        unresolved_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by_account_id TEXT,
        created_by_email TEXT NOT NULL,
        CHECK ((status = 'complete') = (total_amount IS NOT NULL)),
        CHECK (status = 'complete' OR unresolved_acknowledged)
      );

      CREATE TABLE IF NOT EXISTS booking_price_line_items (
        snapshot_id TEXT NOT NULL REFERENCES booking_price_snapshots(id) ON DELETE CASCADE,
        position SMALLINT NOT NULL CHECK (position >= 0),
        line_type TEXT NOT NULL,
        label TEXT NOT NULL CHECK (btrim(label) <> ''),
        status TEXT NOT NULL CHECK (status IN ('applied', 'zero', 'not-applicable', 'unresolved')),
        amount NUMERIC(12,2),
        basis TEXT NOT NULL,
        source JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source) = 'object'),
        PRIMARY KEY (snapshot_id, position),
        CHECK ((status IN ('applied', 'zero')) = (amount IS NOT NULL)),
        CHECK (status <> 'zero' OR amount = 0)
      );

      CREATE OR REPLACE FUNCTION rm_reject_booking_price_snapshot_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Booking price snapshots are immutable once saved.';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_booking_price_snapshots_immutable ON booking_price_snapshots;
      CREATE TRIGGER trg_booking_price_snapshots_immutable
        BEFORE UPDATE ON booking_price_snapshots
        FOR EACH ROW EXECUTE FUNCTION rm_reject_booking_price_snapshot_mutation();
      DROP TRIGGER IF EXISTS trg_booking_price_line_items_immutable ON booking_price_line_items;
      CREATE TRIGGER trg_booking_price_line_items_immutable
        BEFORE UPDATE ON booking_price_line_items
        FOR EACH ROW EXECUTE FUNCTION rm_reject_booking_price_snapshot_mutation();
    `
  },
  {
    id: "0034_protect_booking_price_snapshot_deletes",
    sql: `
      CREATE OR REPLACE FUNCTION rm_guard_booking_price_snapshot_delete() RETURNS trigger AS $$
      BEGIN
        IF current_setting('ridematrix.allow_booking_price_snapshot_delete', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION 'Booking price snapshots can only be deleted during authorized retention cleanup.';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_booking_price_snapshots_immutable_delete ON booking_price_snapshots;
      CREATE TRIGGER trg_booking_price_snapshots_immutable_delete
        BEFORE DELETE ON booking_price_snapshots
        FOR EACH ROW EXECUTE FUNCTION rm_guard_booking_price_snapshot_delete();
      DROP TRIGGER IF EXISTS trg_booking_price_line_items_immutable_delete ON booking_price_line_items;
      CREATE TRIGGER trg_booking_price_line_items_immutable_delete
        BEFORE DELETE ON booking_price_line_items
        FOR EACH ROW EXECUTE FUNCTION rm_guard_booking_price_snapshot_delete();
    `
  },
  {
    // Allows structured road-charge schedules to be enabled through an audited, append-only version. Legacy
    // drafts remain valid history; Dartford Crossing stays draft-only. Nothing is seeded active.
    id: "0035_road_charge_schedule_activation",
    sql: `
      ALTER TABLE london_fee_schedule_versions DROP CONSTRAINT IF EXISTS london_fee_schedule_versions_status_check;
      ALTER TABLE london_fee_schedule_versions DROP CONSTRAINT IF EXISTS london_fee_schedule_versions_payload_check;
      ALTER TABLE london_fee_schedule_versions DROP CONSTRAINT IF EXISTS london_fee_schedule_versions_scheme_check;

      ALTER TABLE london_fee_schedule_versions
        ADD CONSTRAINT london_fee_schedule_versions_scheme_check
        CHECK (scheme IN ('london-lez', 'london-ulez', 'london-congestion-charge', 'dartford-crossing', 'blackwall-silvertown-tunnels'));
      ALTER TABLE london_fee_schedule_versions
        ADD CONSTRAINT london_fee_schedule_versions_status_check
        CHECK (status IN ('draft_inactive', 'inactive', 'active'));
      ALTER TABLE london_fee_schedule_versions
        ADD CONSTRAINT london_fee_schedule_versions_payload_check
        CHECK (
          jsonb_typeof(payload) = 'object'
          AND (
            (
              status = 'draft_inactive'
              AND payload->>'status' = 'draft_inactive'
              AND payload->>'active' = 'false'
              AND payload->>'bookingPriceUsage' = 'never'
            )
            OR (
              payload->>'format' = 'road-charge-schedule-v1'
              AND scheme IN ('london-lez', 'london-ulez', 'london-congestion-charge', 'blackwall-silvertown-tunnels')
              AND payload->>'scheme' = scheme
              AND payload->>'status' = status
              AND (
                (
                  status = 'inactive'
                  AND payload->>'active' = 'false'
                  AND payload->>'bookingPriceUsage' = 'never'
                )
                OR (
                  status = 'active'
                  AND payload->>'active' = 'true'
                  AND payload->>'bookingPriceUsage' = 'new-booking-quotes'
                  AND payload->>'effectiveFrom' ~ '^\\d{4}-\\d{2}-\\d{2}$'
                  AND jsonb_typeof(payload->'verification') = 'object'
                  AND payload->'verification'->>'sourcesConfirmed' = 'true'
                  AND payload->'calculationBlockers' = '[]'::jsonb
                )
              )
            )
          )
        );

      INSERT INTO london_fee_schedule_versions (id, scheme, version, status, payload, actor_email)
      SELECT seed.scheme || '-structured-v' || (COALESCE(latest.version, 0) + 1),
             seed.scheme,
             COALESCE(latest.version, 0) + 1,
             'inactive',
             jsonb_set(seed.payload, '{supersedesLegacyDraftVersion}', COALESCE(to_jsonb(latest.version), 'null'::jsonb)),
             'System migration: structured road-charge schedule (inactive)'
        FROM (VALUES
        ('london-lez', '${JSON.stringify(roadChargeScheduleSeeds["london-lez"]).replace(/'/g, "''")}'::jsonb),
        ('london-ulez', '${JSON.stringify(roadChargeScheduleSeeds["london-ulez"]).replace(/'/g, "''")}'::jsonb),
        ('london-congestion-charge', '${JSON.stringify(roadChargeScheduleSeeds["london-congestion-charge"]).replace(/'/g, "''")}'::jsonb),
        ('blackwall-silvertown-tunnels', '${JSON.stringify(roadChargeScheduleSeeds["blackwall-silvertown-tunnels"]).replace(/'/g, "''")}'::jsonb)
        ) AS seed (scheme, payload)
        LEFT JOIN LATERAL (
          SELECT max(version) AS version FROM london_fee_schedule_versions WHERE scheme = seed.scheme
        ) AS latest ON true
      ON CONFLICT (scheme, version) DO NOTHING;
    `
  },
  {
    id: "0036_congestion_charge_default_21_inactive_version",
    sql: `
      INSERT INTO london_fee_schedule_versions (id, scheme, version, status, payload, actor_email)
      SELECT seed.scheme || '-structured-v' || (COALESCE(latest.version, 0) + 1),
             seed.scheme,
             COALESCE(latest.version, 0) + 1,
             'inactive',
             jsonb_set(
               jsonb_set(base.payload, '{rates}', (
                 SELECT jsonb_agg(
                   CASE WHEN item.rate->>'key' = 'cc-standard'
                        THEN item.rate || (
                          SELECT seeded.rate
                            FROM jsonb_array_elements(seed.payload->'rates') AS seeded(rate)
                           WHERE seeded.rate->>'key' = 'cc-standard'
                        )
                        ELSE item.rate
                   END ORDER BY item.position
                 )
                   FROM jsonb_array_elements(base.payload->'rates') WITH ORDINALITY AS item(rate, position)
               )),
               '{operatingRules,0}', seed.payload #> '{operatingRules,0}'
             ) || '{"status":"inactive","active":false,"bookingPriceUsage":"never","verification":null}'::jsonb,
             'System migration: congestion charge £21 default (inactive)'
        FROM (VALUES
        ('london-congestion-charge', '${JSON.stringify(roadChargeScheduleSeeds["london-congestion-charge"]).replace(/'/g, "''")}'::jsonb)
        ) AS seed (scheme, payload)
        LEFT JOIN LATERAL (
          SELECT max(version) AS version FROM london_fee_schedule_versions WHERE scheme = seed.scheme
        ) AS latest ON true
        LEFT JOIN LATERAL (
          SELECT payload
            FROM london_fee_schedule_versions
           WHERE scheme = seed.scheme
             AND payload->>'format' = 'road-charge-schedule-v1'
           ORDER BY version DESC
           LIMIT 1
        ) AS configured ON true
        CROSS JOIN LATERAL (
          SELECT COALESCE(
            configured.payload,
            jsonb_set(seed.payload, '{supersedesLegacyDraftVersion}', COALESCE(to_jsonb(latest.version), 'null'::jsonb))
          ) AS payload
        ) AS base
      ON CONFLICT (scheme, version) DO NOTHING;
    `
  },
  {
    // The owner approved deployment-time activation for the verified default tunnel schedule.
    // Do not activate if the latest schedule has been customized or otherwise changed.
    id: "0037_activate_default_tunnel_schedule",
    sql: `
      INSERT INTO london_fee_schedule_versions (id, scheme, version, status, payload, actor_email)
      SELECT seed.scheme || '-owner-authorized-active-v' || (latest.version + 1),
             seed.scheme,
             latest.version + 1,
             'active',
             (latest.payload - ARRAY['supersedesLegacyDraftVersion', 'status', 'active', 'bookingPriceUsage', 'verification']::text[])
               || jsonb_build_object(
                 'status', 'active',
                 'active', true,
                 'bookingPriceUsage', 'new-booking-quotes',
                 'verification', jsonb_build_object(
                   'verifiedOn', '2026-11-19',
                   'verifiedByEmail', 'System migration: owner-authorized activation',
                   'verifiedByAccountId', NULL,
                   'recordedAt', to_jsonb(CURRENT_TIMESTAMP),
                   'sourcesConfirmed', true
                 )
               ),
             'System migration: owner-authorized activation'
        FROM (VALUES
          ('blackwall-silvertown-tunnels', '${JSON.stringify(roadChargeScheduleSeeds["blackwall-silvertown-tunnels"]).replace(/'/g, "''")}'::jsonb)
        ) AS seed (scheme, payload)
        JOIN LATERAL (
          SELECT version, status, payload
            FROM london_fee_schedule_versions
           WHERE scheme = seed.scheme
           ORDER BY version DESC
           LIMIT 1
        ) AS latest ON true
       WHERE latest.status = 'inactive'
         AND latest.version = 2
         AND latest.payload - ARRAY['supersedesLegacyDraftVersion', 'status', 'active', 'bookingPriceUsage', 'verification']::text[]
             = seed.payload - ARRAY['supersedesLegacyDraftVersion', 'status', 'active', 'bookingPriceUsage', 'verification']::text[]
      ON CONFLICT (scheme, version) DO NOTHING;
    `
  },
  {
    id: "0038_new_booking_vehicle_class_payment_method",
    sql: `
      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS vehicle_class_key TEXT REFERENCES vehicle_classes(key),
        ADD COLUMN IF NOT EXISTS payment_method TEXT;
      ALTER TABLE customer_bookings
        DROP CONSTRAINT IF EXISTS customer_bookings_payment_method_check;
      ALTER TABLE customer_bookings
        ADD CONSTRAINT customer_bookings_payment_method_check
        CHECK (payment_method IS NULL OR payment_method IN ('card-online', 'bank-transfer', 'card', 'payment-link'));
    `
  },
  {
    id: "0039_booking_archive",
    sql: `
      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS archived_at TEXT,
        ADD COLUMN IF NOT EXISTS archived_by_user_id TEXT,
        ADD COLUMN IF NOT EXISTS archive_reason TEXT;
      CREATE INDEX IF NOT EXISTS idx_customer_bookings_active_service_date
        ON customer_bookings (service_date, service_time)
        WHERE archived_at IS NULL;

      CREATE TABLE IF NOT EXISTS booking_archive_audit (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES customer_bookings(id) ON DELETE CASCADE,
        actor_user_id TEXT,
        actor_user_email TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (btrim(reason) <> '' AND char_length(reason) <= 500),
        archived_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_booking_archive_audit_booking
        ON booking_archive_audit (booking_id, archived_at DESC);
    `
  },
  {
    id: "0040_customer_profile_discount",
    sql: `
      ALTER TABLE customers
        ADD COLUMN IF NOT EXISTS customer_discount_percentage NUMERIC(5, 2);
      ALTER TABLE customers
        DROP CONSTRAINT IF EXISTS customers_customer_discount_percentage_check;
      ALTER TABLE customers
        ADD CONSTRAINT customers_customer_discount_percentage_check
        CHECK (
          customer_discount_percentage IS NULL
          OR customer_discount_percentage BETWEEN 0.01 AND 100
        );
    `
  },
  {
    id: "0041_booking_status_workflow",
    sql: `
      UPDATE customer_bookings SET status = 'New' WHERE status = 'Scheduled';

      CREATE TABLE IF NOT EXISTS booking_status_audit (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES customer_bookings(id),
        previous_status TEXT NOT NULL,
        new_status TEXT NOT NULL CHECK (new_status IN ('New', 'Accepted', 'Cancelled')),
        reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
        actor_user_id TEXT,
        actor_user_email TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        CHECK (new_status <> 'Cancelled' OR btrim(COALESCE(reason, '')) <> '')
      );
      CREATE INDEX IF NOT EXISTS idx_booking_status_audit_booking
        ON booking_status_audit (booking_id, changed_at DESC);
    `
  },
  {
    id: "0042_booking_no_show_status",
    sql: `
      ALTER TABLE booking_status_audit
        DROP CONSTRAINT IF EXISTS booking_status_audit_new_status_check;
      ALTER TABLE booking_status_audit
        ADD CONSTRAINT booking_status_audit_new_status_check
        CHECK (new_status IN ('New', 'Accepted', 'Cancelled', 'No Show'));
    `
  },
  {
    id: "0043_booking_lifecycle_and_live_tracking",
    sql: `
      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS notify_booking_manager BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS live_status TEXT,
        ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'scheduled',
        ADD COLUMN IF NOT EXISTS payment_due_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS extras_description TEXT,
        ADD COLUMN IF NOT EXISTS extras_amount NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS extras_paid_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS driver_notes TEXT;

      ALTER TABLE customer_bookings
        DROP CONSTRAINT IF EXISTS customer_bookings_payment_status_check;
      ALTER TABLE customer_bookings
        ADD CONSTRAINT customer_bookings_payment_status_check
        CHECK (payment_status IN ('scheduled', 'link_sent', 'paid', 'failed', 'refunded'));
      ALTER TABLE customer_bookings
        DROP CONSTRAINT IF EXISTS customer_bookings_extras_check;
      ALTER TABLE customer_bookings
        ADD CONSTRAINT customer_bookings_extras_check
        CHECK (
          (extras_description IS NULL AND extras_amount IS NULL)
          OR (
            extras_description IS NOT NULL AND btrim(extras_description) <> ''
            AND char_length(extras_description) <= 500
            AND extras_amount IS NOT NULL AND extras_amount BETWEEN 0.01 AND 10000
          )
        );

      ALTER TABLE booking_status_audit
        DROP CONSTRAINT IF EXISTS booking_status_audit_new_status_check;
      ALTER TABLE booking_status_audit
        ADD CONSTRAINT booking_status_audit_new_status_check
        CHECK (new_status IN (
          'New', 'Under availability review', 'Accepted', 'Driver assigned',
          'Completed', 'Cancelled', 'No Show'
        ));

      CREATE TABLE IF NOT EXISTS driver_presence (
        driver_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        online_until TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS booking_live_status_audit (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES customer_bookings(id),
        previous_status TEXT,
        new_status TEXT NOT NULL CHECK (new_status IN (
          'En route', 'Waiting near pickup', 'Arrived at pickup', 'Passenger on board',
          'Journey started', 'On break', 'Resume journey', 'Arrived at destination',
          'Extras payable', 'Extras paid', 'Ride finished'
        )),
        details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
        actor_user_id TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_live_status_audit_booking
        ON booking_live_status_audit (booking_id, occurred_at DESC);
      CREATE OR REPLACE FUNCTION rm_reject_booking_lifecycle_audit_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Booking lifecycle audit events are append-only.';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS booking_live_status_audit_append_only ON booking_live_status_audit;
      CREATE TRIGGER booking_live_status_audit_append_only
        BEFORE UPDATE OR DELETE ON booking_live_status_audit
        FOR EACH ROW EXECUTE FUNCTION rm_reject_booking_lifecycle_audit_mutation();

      CREATE TABLE IF NOT EXISTS booking_status_notification_outbox (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES customer_bookings(id),
        live_event_id TEXT NOT NULL REFERENCES booking_live_status_audit(id),
        recipient_type TEXT NOT NULL CHECK (recipient_type IN ('lead_passenger', 'booking_manager')),
        recipient_name TEXT NOT NULL,
        recipient_email TEXT,
        recipient_phone TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        delivery_status TEXT NOT NULL DEFAULT 'pending_provider'
          CHECK (delivery_status IN ('pending_provider', 'sent', 'failed')),
        CHECK (recipient_email IS NOT NULL OR recipient_phone IS NOT NULL),
        UNIQUE (live_event_id, recipient_type)
      );

      CREATE TABLE IF NOT EXISTS booking_status_color_settings (
        status_type TEXT NOT NULL CHECK (status_type IN ('operational', 'live')),
        status_key TEXT NOT NULL,
        display_label TEXT NOT NULL,
        color_hex TEXT NOT NULL CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
        updated_by_account_id TEXT,
        updated_by_email TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (status_type, status_key)
      );
      CREATE TABLE IF NOT EXISTS booking_status_color_audit (
        id TEXT PRIMARY KEY,
        status_type TEXT NOT NULL,
        status_key TEXT NOT NULL,
        previous_color_hex TEXT NOT NULL,
        new_color_hex TEXT NOT NULL,
        actor_account_id TEXT,
        actor_email TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      DROP TRIGGER IF EXISTS booking_status_color_audit_append_only ON booking_status_color_audit;
      CREATE TRIGGER booking_status_color_audit_append_only
        BEFORE UPDATE OR DELETE ON booking_status_color_audit
        FOR EACH ROW EXECUTE FUNCTION rm_reject_booking_lifecycle_audit_mutation();

      INSERT INTO booking_status_color_settings (status_type, status_key, display_label, color_hex) VALUES
        ('operational', 'New', 'New', '#DCEAF5'),
        ('operational', 'Under availability review', 'Under availability review', '#F6E7B8'),
        ('operational', 'Accepted', 'Accepted', '#DCEFD9'),
        ('operational', 'Driver assigned', 'Driver assigned', '#D8E9E8'),
        ('operational', 'Completed', 'Completed', '#DCEFD9'),
        ('operational', 'Cancelled', 'Cancelled', '#F5DDDA'),
        ('operational', 'No Show', 'No Show', '#F2D8D8'),
        ('operational', 'Archived', 'Archived', '#E7E4E0'),
        ('live', 'Driver online', 'Driver online', '#2E8B57'),
        ('live', 'En route', 'En route', '#2677B8'),
        ('live', 'Waiting near pickup', 'Waiting near pickup', '#D08B18'),
        ('live', 'Arrived at pickup', 'Arrived at pickup', '#258C73'),
        ('live', 'Passenger on board', 'Passenger on board', '#16806B'),
        ('live', 'Journey started', 'Journey started', '#2677B8'),
        ('live', 'On break', 'On break', '#8265A8'),
        ('live', 'Resume journey', 'Resume journey', '#2677B8'),
        ('live', 'Arrived at destination', 'Arrived at destination', '#258C73'),
        ('live', 'Extras payable', 'Extras payable', '#D08B18'),
        ('live', 'Extras paid', 'Extras paid', '#258C73'),
        ('live', 'Ride finished', 'Ride finished', '#16806B')
      ON CONFLICT (status_type, status_key) DO NOTHING;
    `
  },
  {
    id: "0044_automated_booking_integrations",
    sql: `
      ALTER TABLE customer_bookings
        ADD COLUMN IF NOT EXISTS passenger_email TEXT,
        ADD COLUMN IF NOT EXISTS passenger_whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS booking_manager_whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS payer_type TEXT NOT NULL DEFAULT 'booking_manager',
        ADD COLUMN IF NOT EXISTS payer_name TEXT,
        ADD COLUMN IF NOT EXISTS payer_email TEXT,
        ADD COLUMN IF NOT EXISTS payer_phone TEXT,
        ADD COLUMN IF NOT EXISTS payment_paid_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS payment_deadline_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT,
        ADD COLUMN IF NOT EXISTS stripe_checkout_url TEXT,
        ADD COLUMN IF NOT EXISTS payment_link_sent_at TIMESTAMPTZ;

      ALTER TABLE customer_bookings
        DROP CONSTRAINT IF EXISTS customer_bookings_payment_method_check,
        ADD CONSTRAINT customer_bookings_payment_method_check
          CHECK (payment_method IS NULL OR payment_method IN (
            'invoice', 'payment-link', 'card-online', 'bank-transfer', 'card'
          )),
        DROP CONSTRAINT IF EXISTS customer_bookings_payer_type_check,
        ADD CONSTRAINT customer_bookings_payer_type_check
          CHECK (payer_type IN ('booking_manager', 'lead_passenger', 'other')),
        DROP CONSTRAINT IF EXISTS customer_bookings_payer_details_check,
        ADD CONSTRAINT customer_bookings_payer_details_check
          CHECK (
            (payer_name IS NULL OR char_length(payer_name) <= 200)
            AND (payer_email IS NULL OR char_length(payer_email) <= 254)
            AND (payer_phone IS NULL OR char_length(payer_phone) <= 50)
          ),
        DROP CONSTRAINT IF EXISTS customer_bookings_passenger_email_check,
        ADD CONSTRAINT customer_bookings_passenger_email_check
          CHECK (passenger_email IS NULL OR char_length(passenger_email) <= 254);

      ALTER TABLE customer_bookings
        DROP CONSTRAINT IF EXISTS customer_bookings_payment_status_check,
        ADD CONSTRAINT customer_bookings_payment_status_check
          CHECK (payment_status IN ('scheduled', 'link_sent', 'paid', 'failed', 'expired', 'refunded'));

      ALTER TABLE driver_profiles
        ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT,
        ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS booking_integration_settings (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        minimum_online_notice_hours INTEGER NOT NULL DEFAULT 12
          CHECK (minimum_online_notice_hours IN (6, 12, 24)),
        updated_by_account_id TEXT,
        updated_by_email TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO booking_integration_settings (id, minimum_online_notice_hours)
      VALUES (1, 12) ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS booking_delivery_outbox (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES customer_bookings(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'payment_link', 'payment_cancelled', 'customer_reminder_24h',
          'driver_reminder_24h', 'live_status'
        )),
        event_key TEXT NOT NULL DEFAULT '',
        recipient_type TEXT NOT NULL CHECK (recipient_type IN (
          'payer', 'lead_passenger', 'booking_manager', 'driver'
        )),
        channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
        recipient_name TEXT NOT NULL,
        recipient_contact TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
        available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        delivery_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (delivery_status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at TIMESTAMPTZ,
        UNIQUE (booking_id, event_type, event_key, recipient_type, channel, recipient_contact)
      );
      CREATE INDEX IF NOT EXISTS idx_booking_delivery_outbox_due
        ON booking_delivery_outbox (available_at, created_at)
        WHERE delivery_status IN ('pending', 'failed', 'sending');

      CREATE TABLE IF NOT EXISTS booking_integration_alerts (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES customer_bookings(id) ON DELETE CASCADE,
        alert_type TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMPTZ,
        resolved_by_account_id TEXT,
        resolved_by_email TEXT,
        UNIQUE (booking_id, alert_type)
      );

      CREATE TABLE IF NOT EXISTS booking_calendar_events (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES customer_bookings(id) ON DELETE CASCADE,
        calendar_scope TEXT NOT NULL CHECK (calendar_scope IN ('dispatch', 'driver')),
        driver_id UUID REFERENCES users(id) ON DELETE SET NULL,
        provider TEXT NOT NULL CHECK (provider IN ('microsoft', 'google')),
        external_event_id TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (sync_status IN ('pending', 'synced', 'failed', 'deleted')),
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_dispatch_calendar_event
        ON booking_calendar_events (booking_id) WHERE calendar_scope = 'dispatch';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_driver_calendar_event
        ON booking_calendar_events (booking_id, driver_id) WHERE calendar_scope = 'driver';
      CREATE INDEX IF NOT EXISTS idx_booking_calendar_events_sync
        ON booking_calendar_events (sync_status, updated_at);

      CREATE TABLE IF NOT EXISTS driver_calendar_connections (
        driver_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('microsoft', 'google')),
        calendar_email TEXT NOT NULL,
        encrypted_access_token TEXT NOT NULL,
        encrypted_refresh_token TEXT NOT NULL,
        access_token_expires_at TIMESTAMPTZ NOT NULL,
        connected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS driver_calendar_oauth_states (
        state_hash TEXT PRIMARY KEY,
        driver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('microsoft', 'google')),
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_driver_calendar_oauth_states_expiry
        ON driver_calendar_oauth_states (expires_at);

      CREATE TABLE IF NOT EXISTS stripe_webhook_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `
  },
  {
    id: "0045_ots_booking_imports",
    sql: `
      CREATE TABLE IF NOT EXISTS ots_booking_imports (
        reservation_id TEXT PRIMARY KEY CHECK (btrim(reservation_id) <> ''),
        source_url TEXT NOT NULL,
        snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
        imported_by_account_id TEXT NOT NULL,
        imported_by_email TEXT NOT NULL,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
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
