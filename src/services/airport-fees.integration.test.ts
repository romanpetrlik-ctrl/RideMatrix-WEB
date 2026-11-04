import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, type TestDatabaseContext } from "../database/test-helper";
import { airportFeeStore, type AirportFeeFormValues } from "./airport-fees";

let context: TestDatabaseContext | undefined;

before(async () => {
  context = await createTestDatabaseContext("test_airport_fee_configurations");
  await context.createAuthTables();
  await initializeDatabase();
});

after(async () => safeCleanupTestDatabase(context));

function validAirport(): AirportFeeFormValues {
  return {
    id: "",
    displayName: "Bournemouth Airport (BOH)",
    dropoffPlaceId: "ChIJ-operational-dropoff",
    dropoffLocationLabel: "Bournemouth Airport Car Park 1",
    dropoffLatitude: "50.7799",
    dropoffLongitude: "-1.8425",
    dropoffFee: "0.00",
    pickupPlaceId: "ChIJ-operational-pickup",
    pickupLocationLabel: "Bournemouth Airport terminal pickup",
    pickupLatitude: "50.7801",
    pickupLongitude: "-1.8420",
    pickupFee: "4.50"
  };
}

test("airport configurations persist independently, edit in place, archive with audit, and do not touch bookings", async () => {
  const actor = { accountId: "system-test-user", email: "system@example.com" };
  const beforeBookings = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM customer_bookings");
  const created = await airportFeeStore.save(null, validAirport(), actor);
  assert.ok(created);
  assert.equal(created.dropoffPlaceId, "ChIJ-operational-dropoff");
  assert.equal(created.pickupPlaceId, "ChIJ-operational-pickup");
  assert.equal(created.dropoffFee, "0.00");
  assert.equal((await airportFeeStore.list()).length, 1);

  const sameOperationalPoint = validAirport();
  sameOperationalPoint.pickupPlaceId = sameOperationalPoint.dropoffPlaceId;
  sameOperationalPoint.pickupLocationLabel = sameOperationalPoint.dropoffLocationLabel;
  sameOperationalPoint.pickupLatitude = sameOperationalPoint.dropoffLatitude;
  sameOperationalPoint.pickupLongitude = sameOperationalPoint.dropoffLongitude;
  sameOperationalPoint.pickupFee = "2.00";
  const updated = await airportFeeStore.save(created.id, sameOperationalPoint, actor);
  assert.ok(updated);
  assert.equal(updated.id, created.id);
  assert.equal(updated.pickupPlaceId, updated.dropoffPlaceId);
  assert.equal((await airportFeeStore.list()).length, 1, "an edit updates its row instead of inserting a duplicate");

  assert.equal(await airportFeeStore.archive(created.id, actor), true);
  assert.equal(await airportFeeStore.get(created.id), null);
  assert.equal((await airportFeeStore.list()).length, 0);
  const archived = await query<{ archived_at: Date | null }>(
    "SELECT archived_at FROM airport_fee_configurations WHERE id = $1",
    [created.id]
  );
  assert.ok(archived.rows[0].archived_at);
  const audit = await query<{ event_type: string }>(
    "SELECT event_type FROM airport_fee_configuration_audit WHERE airport_id = $1 ORDER BY id",
    [created.id]
  );
  assert.deepEqual(audit.rows.map((row) => row.event_type), ["created", "updated", "archived"]);
  const afterBookings = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM customer_bookings");
  assert.equal(afterBookings.rows[0].count, beforeBookings.rows[0].count);
});
