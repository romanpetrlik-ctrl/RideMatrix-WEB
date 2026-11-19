import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, type TestDatabaseContext } from "../database/test-helper";
import { CONFIGURATION_HISTORY_PER_PAGE, RECENT_CONFIGURATION_HISTORY_LIMIT } from "./configuration-history";
import { EMPTY_FARE_SETTINGS, fareSettingsStore } from "./fare-settings";
import { londonFeeScheduleStore } from "./london-fee-schedules";

let context: TestDatabaseContext | undefined;

before(async () => {
  context = await createTestDatabaseContext("test_configuration_history");
  await context.createAuthTables();
  await initializeDatabase();
});

after(async () => safeCleanupTestDatabase(context));

const actor = { accountId: "history-test-user", email: "history@example.com" };
const descending = (from: number, length: number) => Array.from({ length }, (_, index) => from - index);

test("fare settings history is limited and paginated in SQL without changing stored versions", async () => {
  const initial = await fareSettingsStore.load();
  for (let index = 0; index < 45; index += 1) {
    await fareSettingsStore.save(initial.currentVersion + index, {
      ...structuredClone(EMPTY_FARE_SETTINGS),
      deadMileage: { freeRadiusMiles: String(index + 1) }
    }, actor);
  }
  const latestVersion = initial.currentVersion + 45;

  const snapshot = await fareSettingsStore.load();
  assert.equal(snapshot.currentVersion, latestVersion);
  assert.equal(snapshot.historyTotal, 45);
  assert.deepEqual(snapshot.history.map((entry) => entry.version), descending(latestVersion, RECENT_CONFIGURATION_HISTORY_LIMIT));
  assert.equal(snapshot.history[0].actorEmail, actor.email);

  const first = await fareSettingsStore.loadHistoryPage(1);
  assert.equal(first.perPage, CONFIGURATION_HISTORY_PER_PAGE);
  assert.deepEqual([first.page, first.totalPages, first.totalRecords], [1, 3, 45]);
  assert.deepEqual(first.entries.map((entry) => entry.version), descending(latestVersion, 20));
  const third = await fareSettingsStore.loadHistoryPage(3);
  assert.deepEqual(third.entries.map((entry) => entry.version), descending(latestVersion - 40, 5));
  const clamped = await fareSettingsStore.loadHistoryPage(99);
  assert.equal(clamped.page, 3);
  assert.deepEqual(clamped.entries, third.entries);

  const stored = await query<{ version: number }>("SELECT version FROM fare_settings_history ORDER BY version");
  assert.deepEqual(stored.rows.map((row) => row.version), descending(latestVersion, 45).reverse());
});

test("fee schedule history pages are scheme-scoped and deterministic when timestamps tie", async () => {
  const seeded = await londonFeeScheduleStore.load("london-lez");
  // Version 1 is the legacy draft; migration 0035 appended the structured inactive version 2.
  assert.equal(seeded.currentVersion, 2);
  assert.equal(seeded.historyTotal, 2);
  // Append-only rows written with one shared timestamp: ordering must still follow version.
  await query(
    `INSERT INTO london_fee_schedule_versions (id, scheme, version, status, payload, actor_account_id, actor_email, created_at)
     SELECT 'history-test-' || n, scheme, n, status, payload, $2, $3, '2026-11-01T00:00:00Z'
       FROM london_fee_schedule_versions, generate_series(3, 25) AS n
      WHERE scheme = 'london-lez' AND version = $1`,
    [seeded.currentVersion, actor.accountId, actor.email]
  );

  const snapshot = await londonFeeScheduleStore.load("london-lez");
  assert.equal(snapshot.currentVersion, 25);
  assert.equal(snapshot.historyTotal, 25);
  assert.deepEqual(snapshot.history.map((entry) => entry.version), [25, 24, 23]);

  const first = await londonFeeScheduleStore.loadHistoryPage("london-lez", 1);
  assert.deepEqual([first.page, first.totalPages, first.totalRecords], [1, 2, 25]);
  assert.deepEqual(first.entries.map((entry) => entry.version), descending(25, 20));
  const second = await londonFeeScheduleStore.loadHistoryPage("london-lez", 2);
  assert.deepEqual(second.entries.map((entry) => entry.version), [5, 4, 3, 2, 1]);

  const other = await londonFeeScheduleStore.loadHistoryPage("london-ulez", 1);
  assert.deepEqual(other.entries.map((entry) => entry.version), [2, 1], "other schemes are unaffected");

  const amounts = Object.fromEntries(snapshot.schedule.rates.map((rate) => [rate.key, Number(rate.amount).toFixed(2)]));
  await londonFeeScheduleStore.save("london-lez", 25, amounts, actor, { effectiveFrom: "2021-03-01", effectiveUntil: null });
  const afterSave = await londonFeeScheduleStore.load("london-lez");
  assert.equal(afterSave.currentVersion, 26);
  assert.deepEqual(afterSave.history.map((entry) => entry.version), [26, 25, 24]);
  assert.equal(afterSave.historyTotal, 26);
});
