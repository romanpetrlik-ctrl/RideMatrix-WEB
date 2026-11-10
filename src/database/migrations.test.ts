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
