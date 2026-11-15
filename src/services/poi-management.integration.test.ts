import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, type TestDatabaseContext } from "../database/test-helper";
import { poiManagementStore, type PoiFeeFormValues, type PoiFormValues } from "./poi-management";

let context: TestDatabaseContext | undefined;

before(async () => {
  context = await createTestDatabaseContext("test_poi_management");
  await context.createAuthTables();
  await initializeDatabase();
});

after(async () => safeCleanupTestDatabase(context));

function poiValues(displayName: string, placeId: string): PoiFormValues {
  return {
    id: "",
    displayName,
    category: "hotel",
    placeId,
    locationLabel: `${displayName} operational entrance`,
    latitude: "51.4701",
    longitude: "-0.4543",
    notes: ""
  };
}

function feeValues(poiId: string, action: string, amount: string, feeBasis: string, trigger: "selection" | "confirmation"): PoiFeeFormValues {
  return { id: "", poiId, action, amount, feeBasis, trigger, notes: "" };
}

test("POIs persist without default fees; multiple linked fees audit separately and do not touch bookings", async () => {
  const actor = { accountId: "poi-system-test-user", email: "poi-system@example.com" };
  const beforeBookings = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM customer_bookings");
  const initialPois = await poiManagementStore.listPois();
  assert.equal(initialPois.length, 0, "test database starts without sample POIs");
  assert.equal((await poiManagementStore.listFees()).length, 0, "test database starts without default fees");

  const poi = await poiManagementStore.savePoi(null, poiValues("Integration Hotel", "ChIJ-integration-hotel"), actor);
  const poiWithoutFee = await poiManagementStore.savePoi(null, poiValues("Integration Station", "ChIJ-integration-station"), actor);
  assert.ok(poi);
  assert.ok(poiWithoutFee);
  assert.equal(poi.placeId, "ChIJ-integration-hotel");
  assert.equal(poi.latitude, 51.4701);
  assert.equal(poi.longitude, -0.4543);
  assert.equal((await poiManagementStore.listFees()).length, 0, "creating POIs does not create fee records");

  const dropoff = await poiManagementStore.saveFee(
    null,
    feeValues(poi.id, "Drop-off", "6.00", "per visit", "selection"),
    actor
  );
  const parking = await poiManagementStore.saveFee(
    null,
    feeValues(poi.id, "Parking", "18.50", "per hour", "confirmation"),
    actor
  );
  assert.ok(dropoff);
  assert.ok(parking);
  assert.equal(dropoff.poiId, poi.id);
  assert.equal(dropoff.poiDisplayName, "Integration Hotel");
  assert.equal(parking.poiId, poi.id);
  assert.equal((await poiManagementStore.listFees()).length, 2, "multiple fee records may link to one POI");
  assert.equal(await poiManagementStore.deletePoi(poi.id, actor), "has-fees");

  assert.equal(await poiManagementStore.deletePoi(poiWithoutFee.id, actor), "deleted");
  assert.equal(await poiManagementStore.getPoi(poiWithoutFee.id), null);
  assert.equal(await poiManagementStore.deleteFee(dropoff.id, actor), true);
  assert.equal(await poiManagementStore.deleteFee(parking.id, actor), true);
  assert.equal(await poiManagementStore.deletePoi(poi.id, actor), "deleted");
  assert.equal(await poiManagementStore.getPoi(poi.id), null);
  assert.equal((await poiManagementStore.listFees()).length, 0);

  const poiAudit = await query<{ event_type: string }>(
    "SELECT event_type FROM points_of_interest_audit WHERE poi_id = $1 ORDER BY id",
    [poi.id]
  );
  assert.deepEqual(poiAudit.rows.map((row) => row.event_type), ["created", "deleted"]);
  const feeAudit = await query<{ event_type: string }>(
    "SELECT event_type FROM poi_fees_audit WHERE poi_fee_id = ANY($1::text[]) ORDER BY id",
    [[dropoff.id, parking.id]]
  );
  assert.deepEqual(feeAudit.rows.map((row) => row.event_type), ["created", "created", "deleted", "deleted"]);
  const afterBookings = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM customer_bookings");
  assert.equal(afterBookings.rows[0].count, beforeBookings.rows[0].count);
});
