import assert from "node:assert/strict";
import test from "node:test";
import { MIGRATION_ADVISORY_LOCK_KEY, runMigrations } from "./migrations";

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
