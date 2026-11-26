import assert from "node:assert/strict";
import test from "node:test";
import { MIGRATIONS, MIGRATION_ADVISORY_LOCK_KEY, runMigrations } from "./migrations";

test("migration runner holds advisory lock while checking migration state", async () => {
  const calls: { text: string; params?: unknown[] }[] = [];
  const client = {
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      if (text === "SELECT id FROM schema_migrations") {
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  await runMigrations(client as any);

  assert.equal(calls[0].text, "SELECT pg_advisory_lock($1, $2)");
  assert.deepEqual(calls[0].params, [...MIGRATION_ADVISORY_LOCK_KEY]);
  assert.equal(calls[calls.length - 1].text, "SELECT pg_advisory_unlock($1, $2)");
  assert.deepEqual(calls[calls.length - 1].params, [...MIGRATION_ADVISORY_LOCK_KEY]);

  const lockIndex = calls.findIndex((call) => call.text === "SELECT pg_advisory_lock($1, $2)");
  const stateIndex = calls.findIndex((call) => call.text === "SELECT id FROM schema_migrations");
  const unlockIndex = calls.findIndex((call) => call.text === "SELECT pg_advisory_unlock($1, $2)");

  assert.ok(lockIndex > -1);
  assert.ok(stateIndex > lockIndex);
  assert.ok(unlockIndex > stateIndex);
});

test("migration runner releases advisory lock if migration check fails", async () => {
  const calls: string[] = [];
  const client = {
    async query(text: string) {
      calls.push(text);
      if (text === "SELECT id FROM schema_migrations") {
        throw new Error("migration state unavailable");
      }
      return { rows: [] };
    }
  };

  await assert.rejects(() => runMigrations(client as any), /migration state unavailable/);

  assert.equal(calls[0], "SELECT pg_advisory_lock($1, $2)");
  assert.equal(calls[calls.length - 1], "SELECT pg_advisory_unlock($1, $2)");
});

test("airport fee migration stores separate operational Places and preserves archived audit history", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0024_airport_fee_configurations");
  assert.ok(migration);
  assert.match(migration.sql, /dropoff_place_id TEXT NOT NULL/);
  assert.match(migration.sql, /pickup_place_id TEXT NOT NULL/);
  assert.match(migration.sql, /dropoff_latitude NUMERIC/);
  assert.match(migration.sql, /pickup_longitude NUMERIC/);
  assert.match(migration.sql, /dropoff_fee NUMERIC\(8, 2\) NOT NULL CHECK \(dropoff_fee BETWEEN 0 AND 999999\.99\)/);
  assert.match(migration.sql, /pickup_fee NUMERIC\(8, 2\) NOT NULL CHECK \(pickup_fee BETWEEN 0 AND 999999\.99\)/);
  assert.match(migration.sql, /archived_at TIMESTAMPTZ/);
  assert.match(migration.sql, /airport_fee_configuration_audit_append_only/);
  assert.doesNotMatch(migration.sql, /customer_bookings|fare_totals/i);
});

test("airport pick-up timing migration preserves legacy incompleteness and constrains supported values", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0025_airport_pickup_timing_policy");
  assert.ok(migration);
  assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS pickup_time_reference TEXT/);
  assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS pickup_deferred_enabled BOOLEAN/);
  assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS pickup_deferred_minutes INTEGER/);
  assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS pickup_fee_covered_minutes INTEGER/);
  assert.match(migration.sql, /pickup_time_reference IS NULL OR pickup_time_reference IN \('ALT', 'AGA'\)/);
  assert.match(migration.sql, /pickup_deferred_minutes IS NULL OR pickup_deferred_minutes IN \(0, 15, 30, 45, 60\)/);
  assert.match(migration.sql, /pickup_fee_covered_minutes IS NULL OR pickup_fee_covered_minutes IN \(10, 15, 20, 30, 40, 45, 60\)/);
  assert.doesNotMatch(migration.sql, /DEFAULT\s+'(?:ALT|AGA)'/);
});

test("booking status workflow migrates Scheduled to New and keeps cancellation reasons in an audit log", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0041_booking_status_workflow");
  assert.ok(migration);
  assert.match(migration.sql, /UPDATE customer_bookings SET status = 'New' WHERE status = 'Scheduled'/);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS booking_status_audit/);
  assert.match(migration.sql, /previous_status TEXT NOT NULL/);
  assert.match(migration.sql, /new_status IN \('New', 'Accepted', 'Cancelled'\)/);
  assert.match(migration.sql, /new_status <> 'Cancelled' OR btrim\(COALESCE\(reason, ''\)\) <> ''/);
  assert.match(migration.sql, /actor_user_email TEXT NOT NULL/);
  assert.match(migration.sql, /booking_id TEXT NOT NULL REFERENCES customer_bookings\(id\),/);

  const noShowMigration = MIGRATIONS.find((item) => item.id === "0042_booking_no_show_status");
  assert.ok(noShowMigration);
  assert.match(noShowMigration.sql, /DROP CONSTRAINT IF EXISTS booking_status_audit_new_status_check/);
  assert.match(noShowMigration.sql, /new_status IN \('New', 'Accepted', 'Cancelled', 'No Show'\)/);
});

test("automated booking integrations persist payment, notification, and calendar state", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0044_automated_booking_integrations");
  assert.ok(migration);
  assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT/);
  assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS payment_deadline_at TIMESTAMPTZ/);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS booking_delivery_outbox/);
  assert.match(migration.sql, /UNIQUE \(booking_id, event_type, event_key, recipient_type, channel, recipient_contact\)/);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS stripe_webhook_events/);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS driver_calendar_connections/);
  assert.match(migration.sql, /encrypted_refresh_token TEXT NOT NULL/);
  assert.match(migration.sql, /minimum_online_notice_hours INTEGER NOT NULL DEFAULT 12/);
});

test("WhatsApp messaging switch is persistent, audited, and defaults off", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0049_whatsapp_messaging_switch");
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS whatsapp_messaging_settings/);
  assert.match(migration.sql, /id SMALLINT PRIMARY KEY CHECK \(id = 1\)/);
  assert.match(migration.sql, /enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration.sql, /updated_by_account_id TEXT/);
  assert.match(migration.sql, /VALUES \(1, FALSE\) ON CONFLICT \(id\) DO NOTHING/);
});

test("Stripe credentials and payment email templates have encrypted storage and safe defaults", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0050_stripe_payment_settings");
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS stripe_payment_settings/);
  assert.match(migration.sql, /encrypted_credentials TEXT/);
  assert.match(migration.sql, /encryption_iv TEXT/);
  assert.match(migration.sql, /encryption_auth_tag TEXT/);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS stripe_payment_settings_history/);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS email_messaging_settings/);
  assert.match(migration.sql, /enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS email_templates/);
  assert.match(migration.sql, /'payment_paid'/);
  assert.match(migration.sql, /'payment_link', 'payment_paid', 'payment_cancelled'/);
  assert.doesNotMatch(migration.sql, /sk_live_|sk_test_|whsec_/);
});

test("POI migration keeps fees optional, linked by internal ID, audited, and outside booking pricing", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0029_poi_management");
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS points_of_interest/);
  assert.match(migration.sql, /place_id TEXT NOT NULL/);
  assert.match(migration.sql, /latitude NUMERIC/);
  assert.match(migration.sql, /longitude NUMERIC/);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS poi_fees/);
  assert.match(migration.sql, /poi_id TEXT NOT NULL REFERENCES points_of_interest\(id\) ON DELETE RESTRICT/);
  assert.match(migration.sql, /currency TEXT NOT NULL CHECK \(currency = 'GBP'\)/);
  assert.match(migration.sql, /fee_basis TEXT NOT NULL/);
  assert.match(migration.sql, /trigger_type TEXT NOT NULL CHECK/);
  assert.match(migration.sql, /points_of_interest_audit_append_only/);
  assert.match(migration.sql, /poi_fees_audit_append_only/);
  assert.doesNotMatch(migration.sql, /INSERT INTO (?:points_of_interest|poi_fees)/i);
  assert.doesNotMatch(migration.sql, /Crowne Plaza|Renaissance|customer_bookings|fare_totals|booking_total/i);
});
