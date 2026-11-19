import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, type TestDatabaseContext } from "../database/test-helper";
import { londonFeeScheduleStore } from "./london-fee-schedules";

let context: TestDatabaseContext | undefined;

before(async () => {
  context = await createTestDatabaseContext("test_road_charge_schedules");
  await context.createAuthTables();
  await initializeDatabase();
});

after(async () => safeCleanupTestDatabase(context));

const actor = { accountId: "admin-1", email: "admin@example.test" };
const now = new Date("2026-11-20T00:00:00Z");

test("migration preserves legacy drafts and seeds structured schedules inactive", async () => {
  const rows = await query<{ scheme: string; version: number; status: string; active: string; usage: string }>(
    `SELECT scheme, version, status, payload->>'active' AS active, payload->>'bookingPriceUsage' AS usage
       FROM london_fee_schedule_versions ORDER BY scheme, version`
  );
  const byScheme = (scheme: string) => rows.rows.filter((row) => row.scheme === scheme).map((row) => [row.version, row.status]);
  assert.deepEqual(byScheme("dartford-crossing"), [[1, "draft_inactive"]], "Dartford is untouched");
  for (const scheme of ["london-lez", "london-ulez", "blackwall-silvertown-tunnels"]) {
    assert.deepEqual(byScheme(scheme), [[1, "draft_inactive"], [2, "inactive"]], `${scheme} keeps its legacy draft`);
  }
  assert.ok(rows.rows.every((row) => row.active === "false" && row.usage === "never"), "nothing is live after migration");

  const pricing = await londonFeeScheduleStore.loadPricingSchedules();
  assert.deepEqual(Object.keys(pricing).sort(), ["blackwall-silvertown-tunnels", "london-congestion-charge", "london-lez", "london-ulez"]);
  assert.ok(Object.values(pricing).every((record) => record?.schedule?.status === "inactive"));
});

test("activation is gated, actor-attributed and append-only", async () => {
  const lez = await londonFeeScheduleStore.load("london-lez");
  await londonFeeScheduleStore.setActivation("london-lez", lez.currentVersion, { action: "enable", verifiedOn: "2026-11-19", sourcesConfirmed: true }, actor, now);
  let latest = await query<{ version: number; status: string; actor_email: string; payload: Record<string, any> }>(
    "SELECT version, status, actor_email, payload FROM london_fee_schedule_versions WHERE scheme = 'london-lez' ORDER BY version DESC LIMIT 1"
  );
  assert.deepEqual([latest.rows[0].version, latest.rows[0].status, latest.rows[0].actor_email], [lez.currentVersion + 1, "active", actor.email]);
  assert.equal(latest.rows[0].payload.verification.verifiedOn, "2026-11-19");
  assert.equal((await londonFeeScheduleStore.loadPricingSchedules())["london-lez"]?.version, lez.currentVersion + 1);

  await assert.rejects(
    londonFeeScheduleStore.setActivation("london-lez", lez.currentVersion, { action: "disable" }, actor, now),
    /changed|version/i,
    "stale versions are rejected"
  );
  await londonFeeScheduleStore.setActivation("london-lez", lez.currentVersion + 1, { action: "disable" }, actor, now);
  latest = await query("SELECT version, status, actor_email, payload FROM london_fee_schedule_versions WHERE scheme = 'london-lez' ORDER BY version DESC LIMIT 1");
  assert.equal(latest.rows[0].status, "inactive");
  assert.equal(latest.rows[0].payload.verification, null);

  for (const scheme of ["london-ulez", "london-congestion-charge", "blackwall-silvertown-tunnels"] as const) {
    const current = await londonFeeScheduleStore.load(scheme);
    await assert.rejects(
      londonFeeScheduleStore.setActivation(scheme, current.currentVersion, { action: "enable", verifiedOn: "2026-11-19", sourcesConfirmed: true }, actor, now),
      Error,
      `${scheme} cannot be enabled while blockers remain`
    );
  }
  const dartford = await londonFeeScheduleStore.load("dartford-crossing");
  await assert.rejects(londonFeeScheduleStore.setActivation("dartford-crossing", dartford.currentVersion, { action: "enable", verifiedOn: "2026-11-19", sourcesConfirmed: true }, actor, now));

  await assert.rejects(query("UPDATE london_fee_schedule_versions SET actor_email = 'x' WHERE scheme = 'london-lez'"));
  await assert.rejects(query("DELETE FROM london_fee_schedule_versions WHERE scheme = 'london-lez'"));
});

test("the database rejects active rows that bypass the activation gate", async () => {
  const row = await query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM london_fee_schedule_versions WHERE scheme = 'london-ulez' ORDER BY version DESC LIMIT 1"
  );
  const forged = { ...row.rows[0].payload, status: "active", active: true, bookingPriceUsage: "new-booking-quotes" };
  await assert.rejects(
    query("INSERT INTO london_fee_schedule_versions (id, scheme, version, status, payload, actor_email) VALUES ('forged', 'london-ulez', 99, 'active', $1, 'x')", [forged]),
    /payload_check/
  );
  await assert.rejects(
    query("INSERT INTO london_fee_schedule_versions (id, scheme, version, status, payload, actor_email) VALUES ('forged2', 'london-ulez', 99, 'live', $1, 'x')", [row.rows[0].payload]),
    /check/
  );
});
