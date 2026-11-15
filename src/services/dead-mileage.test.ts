import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDeadMileage,
  isOperationalBaseVerified,
  measureRouteOutsideRadiusMiles,
  type DeadMileageInput
} from "./dead-mileage";
import { calculateDistanceSlabFare, validateDeadMileageRadius } from "./fare-settings";
import { MIGRATIONS } from "../database/migrations";

const base: NonNullable<DeadMileageInput["base"]> = {
  operatorId: "operator-1",
  latitude: 0,
  longitude: 0,
  providerPlaceId: "verified-operational-point",
  coordinatesVerified: true,
  updatedAt: "2026-11-15T12:00:00.000Z"
};
const slabs = [
  { startMiles: "0", endMiles: "1", ratePerMile: "3.00" },
  { startMiles: "1", endMiles: "", ratePerMile: "2.70" }
];
const outward = {
  source: "route-provider",
  routeId: "route-outward",
  points: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.03 }]
};
const returnRoute = {
  source: "route-provider",
  routeId: "route-return",
  points: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: -0.03 }]
};

function calculate(overrides: Partial<DeadMileageInput> = {}) {
  return calculateDeadMileage({
    base,
    freeRadiusMiles: "1",
    distanceSlabs: slabs,
    distanceSlabsVersion: 8,
    vehicleDispatchedFromBase: true,
    returnToBaseAfterDropoff: false,
    baseToPickup: outward,
    ...overrides
  });
}

test("booking flags independently select the base-to-pickup and dropoff-to-base deadhead legs", () => {
  const combinations = [
    { first: false, second: false, legs: [] },
    { first: true, second: false, legs: ["base-to-pickup"] },
    { first: false, second: true, legs: ["dropoff-to-base"] },
    { first: true, second: true, legs: ["base-to-pickup", "dropoff-to-base"] }
  ] as const;
  for (const combination of combinations) {
    const result = calculate({
      vehicleDispatchedFromBase: combination.first,
      returnToBaseAfterDropoff: combination.second,
      baseToPickup: outward,
      dropoffToBase: returnRoute
    });
    assert.equal(result.status, "complete");
    if (result.status === "complete") {
      assert.deepEqual(Object.keys(result.snapshot.routes), combination.legs);
      assert.deepEqual(result.contributingLegs, combination.legs);
    }
  }
});

test("route distance inside the circle is free and fully outside route distance is chargeable", () => {
  const inside = measureRouteOutsideRadiusMiles({
    source: "route-provider", routeId: "inside",
    points: [{ latitude: 0, longitude: 0.001 }, { latitude: 0, longitude: 0.003 }]
  }, { latitude: 0, longitude: 0 }, "1");
  assert.equal(inside, "0");

  const outside = measureRouteOutsideRadiusMiles({
    source: "route-provider", routeId: "outside",
    points: [{ latitude: 0, longitude: 0.03 }, { latitude: 0, longitude: 0.04 }]
  }, { latitude: 0, longitude: 0 }, "0.1");
  assert.ok(Number(outside) > 0.6 && Number(outside) < 0.8, outside);
});

test("boundary crossings charge only the outside arc and sum a route that exits and re-enters repeatedly", () => {
  const crossing = measureRouteOutsideRadiusMiles({
    source: "route-provider", routeId: "crossing",
    points: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.03 }]
  }, { latitude: 0, longitude: 0 }, "1");
  assert.ok(Number(crossing) > 1 && Number(crossing) < 1.2, crossing);

  const repeated = measureRouteOutsideRadiusMiles({
    source: "route-provider", routeId: "repeated-crossing",
    points: [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.03 },
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: -0.03 }
    ]
  }, { latitude: 0, longitude: 0 }, "1");
  assert.ok(Number(repeated) > 3 && Number(repeated) < 3.3, repeated);
});

test("only selected deadhead routes are included, combined miles use progressive slabs, and snapshot retains source values", () => {
  const result = calculate({
    vehicleDispatchedFromBase: true,
    returnToBaseAfterDropoff: true,
    baseToPickup: outward,
    dropoffToBase: returnRoute
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(Object.keys(result.snapshot.routes), ["base-to-pickup", "dropoff-to-base"]);
  assert.equal(result.fareBreakdown?.label, "Dead mileage");
  assert.deepEqual(result.fareBreakdown?.legs, ["base-to-pickup", "dropoff-to-base"]);
  assert.equal(
    result.amount,
    calculateDistanceSlabFare(slabs, result.combinedOutsideRadiusMiles)
  );
  assert.equal(result.snapshot.freeRadiusMiles, "1");
  assert.equal(result.snapshot.operationalBase?.providerPlaceId, "verified-operational-point");
  assert.equal(result.snapshot.operationalBase?.updatedAt, base.updatedAt);
  assert.deepEqual(result.snapshot.bookingFlags, {
    vehicleDispatchedFromBase: true,
    returnToBaseAfterDropoff: true
  });
  assert.equal(result.snapshot.distanceSlabsVersion, 8);
  assert.deepEqual(result.snapshot.distanceSlabs, slabs);
  assert.ok(Number(result.snapshot.routes["base-to-pickup"]?.routeMiles) >
    Number(result.snapshot.routes["base-to-pickup"]?.outsideRadiusMiles ?? "0"));
  assert.equal(result.snapshot.routes["base-to-pickup"]?.routeId, "route-outward");

  const onlyReturn = calculate({
    vehicleDispatchedFromBase: false,
    returnToBaseAfterDropoff: true,
    baseToPickup: null,
    dropoffToBase: returnRoute
  });
  assert.equal(onlyReturn.status, "complete");
  if (onlyReturn.status === "complete") {
    assert.deepEqual(Object.keys(onlyReturn.snapshot.routes), ["dropoff-to-base"]);
  }
});

test("missing operational coordinates, applicable route geometry, booking flags, or slab settings are incomplete", () => {
  const missingBase = calculate({ base: { ...base, latitude: null } });
  assert.equal(missingBase.status, "incomplete");
  if (missingBase.status === "incomplete") assert.match(missingBase.reasons.join(" "), /verified coordinates/);

  const unverifiedBase = { ...base, coordinatesVerified: false };
  assert.equal(isOperationalBaseVerified(unverifiedBase), false);
  const unverifiedResult = calculate({ base: unverifiedBase });
  assert.equal(unverifiedResult.status, "incomplete");
  if (unverifiedResult.status === "incomplete") {
    assert.match(unverifiedResult.reasons.join(" "), /verified coordinates/);
  }

  const missingRoute = calculate({ baseToPickup: null });
  assert.equal(missingRoute.status, "incomplete");
  if (missingRoute.status === "incomplete") assert.match(missingRoute.reasons.join(" "), /road-route geometry/);

  const missingFlags = calculate({ vehicleDispatchedFromBase: null });
  assert.equal(missingFlags.status, "incomplete");
  if (missingFlags.status === "incomplete") assert.match(missingFlags.reasons.join(" "), /both dead-mileage booking flags/);

  const missingSlabs = calculate({ distanceSlabs: [] });
  assert.equal(missingSlabs.status, "incomplete");
  if (missingSlabs.status === "incomplete") assert.match(missingSlabs.reasons.join(" "), /Distance Slabs/);
});

test("radius server validation rejects missing, non-positive, malformed, and out-of-range values", () => {
  for (const freeRadiusMiles of ["", "0", "-1", "NaN", "1e2", "13000"]) {
    assert.ok(validateDeadMileageRadius({ freeRadiusMiles }).errors.freeRadiusMiles, freeRadiusMiles);
  }
  assert.deepEqual(validateDeadMileageRadius({ freeRadiusMiles: "5.25" }).errors, {});
});

test("dead-mileage migration adds nullable explicit flags and append-only flag audit without changing fee rules", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0030_dead_mileage");
  assert.ok(migration);
  assert.match(migration.sql, /vehicle_dispatched_from_base BOOLEAN/);
  assert.match(migration.sql, /return_to_base_after_dropoff BOOLEAN/);
  assert.match(migration.sql, /booking_dead_mileage_flag_audit_append_only/);
  assert.match(migration.sql, /deadMileage/);
  assert.doesNotMatch(migration.sql, /airport_fee|poi_fees|minimumFareRules|customer_bookings.*total_fare_amount/i);
});

test("operational coordinates require an explicit verification flag before enabling dead mileage", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0031_verified_operational_coordinates");
  assert.ok(migration);
  assert.match(migration.sql, /coordinates_verified BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.equal(isOperationalBaseVerified(base), true);
});
