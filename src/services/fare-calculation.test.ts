import assert from "node:assert/strict";
import test from "node:test";
import { EARTH_RADIUS_MILES, type GeoPoint, type OperationalBase } from "./dead-mileage";
import {
  calculateJourneyFare,
  geodesicDistanceMiles,
  resolveJourneyLocationDiscount,
  type JourneyEndpoint,
  type JourneyFareInput
} from "./fare-calculation";
import {
  EMPTY_FARE_SETTINGS,
  type FareSettingsConfiguration,
  type LocationDiscountRule,
  type RadiusLocationDiscountRule
} from "./fare-settings";

const base: OperationalBase = {
  operatorId: "operator-1",
  latitude: 50.8,
  longitude: -1.9,
  providerPlaceId: "place-base",
  coordinatesVerified: true,
  updatedAt: "2026-01-01T00:00:00.000Z"
};
const baseCentre: GeoPoint = { latitude: 50.8, longitude: -1.9 };
const heathrow = { type: "airport" as const, id: "rm-lhr" };
const gatwick = { type: "airport" as const, id: "rm-lgw" };
const serviceDate = "2027-03-10";

/** Point due north of the base at exactly the given geodesic distance. */
function northOfBase(miles: number): GeoPoint {
  return { latitude: baseCentre.latitude + (miles / EARTH_RADIUS_MILES) * 180 / Math.PI, longitude: baseCentre.longitude };
}

const baseArea: JourneyEndpoint = { coordinates: northOfBase(3), postcode: "BH21 1AA" };
const dorchester: JourneyEndpoint = { coordinates: { latitude: 50.7154, longitude: -2.4371 }, postcode: "DT1 1AA" };
const heathrowEndpoint: JourneyEndpoint = { managedLocation: heathrow, coordinates: { latitude: 51.47, longitude: -0.4543 }, postcode: "TW6 1AA" };
const gatwickEndpoint: JourneyEndpoint = { managedLocation: gatwick, coordinates: { latitude: 51.1537, longitude: -0.1821 }, postcode: "RH6 0NP" };

function radiusRule(id: string, overrides: Partial<RadiusLocationDiscountRule> = {}): RadiusLocationDiscountRule {
  return {
    id,
    name: `Radius ${id}`,
    location: heathrow,
    radiusMiles: "10",
    discountPercentage: "15",
    startDate: "",
    endDate: "",
    enabled: true,
    radiusCentre: "operational-base",
    discountBasis: "standard-distance-slabs-base-fare",
    ...overrides
  };
}

function postcodeRule(id: string, overrides: Partial<LocationDiscountRule> = {}): LocationDiscountRule {
  return {
    id,
    name: `Postcode ${id}`,
    location: heathrow,
    postcodePrecision: "outward",
    postcodes: ["DT1", "BH21"],
    discountPercentage: "25",
    startDate: "",
    endDate: "",
    enabled: true,
    discountBasis: "standard-distance-slabs-base-fare",
    ...overrides
  };
}

function resolve(origin: JourneyEndpoint, destination: JourneyEndpoint, options: {
  radiusRules?: RadiusLocationDiscountRule[];
  postcodeRules?: LocationDiscountRule[];
  operationalBase?: OperationalBase | null;
  date?: string;
} = {}) {
  return resolveJourneyLocationDiscount({
    radiusRules: options.radiusRules ?? [radiusRule("radius")],
    postcodeRules: options.postcodeRules ?? [],
    origin,
    destination,
    serviceDate: options.date ?? serviceDate,
    operationalBase: options.operationalBase === undefined ? base : options.operationalBase
  });
}

test("radius discounts match the exact managed location ID in either direction", () => {
  const outbound = resolve(baseArea, heathrowEndpoint);
  assert.equal(outbound.status, "matched");
  assert.equal(outbound.status === "matched" && outbound.source, "operational-base-radius");
  assert.equal(outbound.status === "matched" && outbound.direction, "base-area-to-location");
  assert.equal(outbound.status === "matched" && outbound.rule.id, "radius");

  const inbound = resolve(heathrowEndpoint, baseArea);
  assert.equal(inbound.status === "matched" && inbound.direction, "location-to-base-area");
  assert.equal(inbound.status === "matched" && inbound.discountPercentage, "15");
});

test("display names, nearby locations and airport postcodes never substitute for the managed ID", () => {
  const nameOnly = { coordinates: heathrowEndpoint.coordinates, postcode: "TW6 1AA", label: "Heathrow Airport" } as JourneyEndpoint;
  assert.equal(resolve(baseArea, nameOnly).status, "no-match", "same coordinates and postcode without the managed ID");
  assert.equal(resolve(baseArea, { managedLocation: { type: "airport", id: "Heathrow Airport" } }).status, "no-match");
  assert.equal(resolve(baseArea, { managedLocation: { type: "poi", id: "rm-lhr" } }).status, "no-match", "the location type is part of the ID");
  assert.equal(resolve(baseArea, { managedLocation: { type: "airport", id: "rm-lhr-t5" }, coordinates: { latitude: 51.4723, longitude: -0.4885 } }).status,
    "no-match", "a nearby managed location does not match");
  assert.equal(resolve(baseArea, gatwickEndpoint).status, "no-match");
});

test("points inside or exactly on the radius boundary qualify; points outside do not", () => {
  const exact = northOfBase(10);
  assert.ok(Math.abs(geodesicDistanceMiles(baseCentre, exact) - 10) < 1e-9);
  assert.equal(resolve({ coordinates: northOfBase(9.99) }, heathrowEndpoint).status, "matched");
  const boundary = resolve({ coordinates: exact }, heathrowEndpoint);
  assert.equal(boundary.status, "matched", "the boundary is inclusive");
  assert.equal(boundary.status === "matched" && boundary.source === "operational-base-radius" && boundary.endpointDistanceMiles, "10");
  assert.equal(resolve({ coordinates: northOfBase(10.001) }, heathrowEndpoint).status, "no-match");
  assert.equal(resolve(heathrowEndpoint, { coordinates: northOfBase(10.001) }).status, "no-match");
});

test("an active radius rule governs its location exclusively: Dorchester–Heathrow gets no discount", () => {
  const postcodeRules = [postcodeRule("heathrow-postcode")];
  for (const [origin, destination] of [[dorchester, heathrowEndpoint], [heathrowEndpoint, dorchester]]) {
    const result = resolve(origin, destination, { postcodeRules });
    assert.deepEqual(result, {
      status: "no-match",
      precedence: { governingRadiusRuleIds: ["radius"], supersededPostcodeRuleIds: ["heathrow-postcode"] }
    });
  }
  const withoutRadius = resolve(dorchester, heathrowEndpoint, { postcodeRules, radiusRules: [] });
  assert.equal(withoutRadius.status === "matched" && withoutRadius.source, "postcode", "the postcode rule matches when no radius rule governs");
});

test("a qualifying Heathrow journey uses only the radius discount; discounts never stack", () => {
  const result = resolve(baseArea, heathrowEndpoint, { postcodeRules: [postcodeRule("heathrow-postcode")] });
  assert.equal(result.status, "matched");
  assert.equal(result.status === "matched" && result.source, "operational-base-radius");
  assert.equal(result.status === "matched" && result.discountPercentage, "15");
  assert.deepEqual(result.status === "matched" && result.precedence.supersededPostcodeRuleIds, ["heathrow-postcode"]);
});

test("postcode discounts for other locations are unchanged and still never stack with a radius discount", () => {
  const gatwickRule = postcodeRule("gatwick-postcode", { location: gatwick, discountPercentage: "5" });
  const gatwickTrip = resolve(dorchester, gatwickEndpoint, { postcodeRules: [gatwickRule] });
  assert.equal(gatwickTrip.status === "matched" && gatwickTrip.source, "postcode");
  assert.equal(gatwickTrip.status === "matched" && gatwickTrip.rule.id, "gatwick-postcode");
  assert.deepEqual(gatwickTrip.status === "matched" && gatwickTrip.precedence, { governingRadiusRuleIds: [], supersededPostcodeRuleIds: [] });

  const both = resolve(gatwickEndpoint, heathrowEndpoint, {
    postcodeRules: [postcodeRule("gatwick-heathrow", { location: gatwick, postcodes: ["TW6"] })],
    radiusRules: [radiusRule("radius", { radiusMiles: "100" })]
  });
  assert.equal(both.status, "unresolved", "two different matching discounts are reported, not stacked or chosen");
  assert.equal(both.status === "unresolved" && both.reason, "ambiguous-rules");
});

test("postcode fallback is preserved when the radius rule is disabled, expired or not yet effective", () => {
  const postcodeRules = [postcodeRule("heathrow-postcode")];
  for (const rule of [
    radiusRule("disabled", { enabled: false }),
    radiusRule("expired", { endDate: "2027-03-09" }),
    radiusRule("future", { startDate: "2027-03-11" })
  ]) {
    const result = resolve(dorchester, heathrowEndpoint, { postcodeRules, radiusRules: [rule] });
    assert.equal(result.status === "matched" && result.source, "postcode", rule.id);
    assert.deepEqual(result.status === "matched" && result.precedence.governingRadiusRuleIds, [], rule.id);
  }
  const onLastDay = resolve(dorchester, heathrowEndpoint, { postcodeRules, radiusRules: [radiusRule("ends", { endDate: serviceDate })] });
  assert.equal(onLastDay.status, "no-match", "validity dates are inclusive");
});

test("missing or invalid coordinates, an unverified base or an invalid date never produce a match", () => {
  for (const coordinates of [undefined, null, { latitude: NaN, longitude: -1.9 }, { latitude: 91, longitude: 0 }, { latitude: 50, longitude: 181 }]) {
    const result = resolve({ coordinates, postcode: "BH21 1AA" }, heathrowEndpoint, { postcodeRules: [postcodeRule("heathrow-postcode")] });
    assert.equal(result.status, "unresolved", JSON.stringify(coordinates));
    assert.equal(result.status === "unresolved" && result.reason, "missing-endpoint-coordinates");
    assert.match(result.status === "unresolved" ? result.message : "", /missing or invalid coordinates/);
  }
  for (const operationalBase of [null, { ...base, coordinatesVerified: false }, { ...base, latitude: null }, { ...base, providerPlaceId: null }]) {
    const result = resolve(baseArea, heathrowEndpoint, { operationalBase });
    assert.equal(result.status === "unresolved" && result.reason, "operational-base-unverified");
  }
  assert.equal(resolve(baseArea, heathrowEndpoint, { date: "2027-02-30" }).status, "unresolved");
  assert.equal(resolve({}, gatwickEndpoint).status, "no-match", "coordinates are only required when a radius rule governs the location");
});

test("overlapping active radius rules for one location are reported, not chosen", () => {
  const result = resolve(baseArea, heathrowEndpoint, { radiusRules: [radiusRule("a"), radiusRule("b", { radiusMiles: "20" })] });
  assert.deepEqual(result.status === "unresolved" && result.ruleIds, ["a", "b"]);
  assert.equal(result.status === "unresolved" && result.reason, "ambiguous-rules");
});

const configuration: FareSettingsConfiguration = {
  ...EMPTY_FARE_SETTINGS,
  distanceSlabs: [{ startMiles: "0", endMiles: "", ratePerMile: "2.00" }],
  deadMileage: { enabled: false, freeRadiusMiles: "4", ratePerMile: "" },
  locationDiscounts: [postcodeRule("heathrow-postcode"), postcodeRule("gatwick-postcode", { location: gatwick, discountPercentage: "5" })],
  radiusLocationDiscounts: [radiusRule("radius")]
};
const charges: JourneyFareInput["separateCharges"] = [
  { type: "airport-fee", label: "Heathrow drop-off fee", amount: "7.00" },
  { type: "toll", label: "M6 toll", amount: "3.10" },
  { type: "dead-mileage", label: "Dead mileage", amount: "12.00" }
];

function fare(origin: JourneyEndpoint, destination: JourneyEndpoint, overrides: Partial<JourneyFareInput> = {}) {
  return calculateJourneyFare({
    configuration,
    fareSettingsVersion: 4,
    distanceMiles: "50",
    serviceDate,
    origin,
    destination,
    operationalBase: base,
    separateCharges: charges,
    ...overrides
  });
}

test("the radius discount applies to the Distance Slabs base fare only and is recorded in the breakdown and snapshot", () => {
  const result = fare(baseArea, heathrowEndpoint);
  assert.equal(result.status, "calculated");
  if (result.status !== "calculated") return;
  assert.equal(result.standardBaseFare, "100.00");
  assert.equal(result.discountAmount, "15.00");
  assert.equal(result.discountedBaseFare, "85.00");
  assert.equal(result.total, "107.10", "fees, tolls and dead mileage are added undiscounted");
  assert.deepEqual(result.fareBreakdown, [
    { type: "base-fare", label: "Base fare (Distance Slabs)", distanceMiles: "50", amount: "100.00" },
    { type: "location-discount", label: "Operational-base radius discount: Radius radius (15%)", source: "operational-base-radius", ruleId: "radius", discountPercentage: "15", amount: "-15.00" },
    { type: "airport-fee", label: "Heathrow drop-off fee", amount: "7.00" },
    { type: "toll", label: "M6 toll", amount: "3.10" },
    { type: "dead-mileage", label: "Dead mileage", amount: "12.00" }
  ]);
  assert.equal(result.snapshot.discount?.ruleId, "radius");
  assert.equal(result.snapshot.discount?.amount, "15.00");
  assert.equal(result.snapshot.discount?.appliesTo, "standard-distance-slabs-base-fare");
  assert.deepEqual(result.snapshot.discount?.radius, {
    radiusMiles: "10",
    endpointDistanceMiles: "3",
    operationalBase: { operatorId: "operator-1", latitude: 50.8, longitude: -1.9, providerPlaceId: "place-base", updatedAt: "2026-01-01T00:00:00.000Z" }
  });
  assert.deepEqual(result.snapshot.precedence, { governingRadiusRuleIds: ["radius"], supersededPostcodeRuleIds: ["heathrow-postcode"] });
  assert.deepEqual(result.snapshot.separateCharges, charges);
  assert.equal(result.snapshot.total, result.total);
  assert.equal(result.snapshot.fareSettingsVersion, 4);
});

test("Dorchester–Heathrow is priced without any discount; unrelated postcode discounts still apply", () => {
  const dorchesterHeathrow = fare(dorchester, heathrowEndpoint);
  assert.equal(dorchesterHeathrow.status === "calculated" && dorchesterHeathrow.discountAmount, "0.00");
  assert.equal(dorchesterHeathrow.status === "calculated" && dorchesterHeathrow.total, "122.10");
  assert.equal(dorchesterHeathrow.status === "calculated" && dorchesterHeathrow.snapshot.discount, null);
  assert.ok(dorchesterHeathrow.status === "calculated" && !dorchesterHeathrow.fareBreakdown.some((item) => item.type === "location-discount"));

  const dorchesterGatwick = fare(dorchester, gatwickEndpoint);
  assert.equal(dorchesterGatwick.status === "calculated" && dorchesterGatwick.discountAmount, "5.00");
  assert.equal(dorchesterGatwick.status === "calculated" && dorchesterGatwick.snapshot.discount?.source, "postcode");
  assert.equal(dorchesterGatwick.status === "calculated" && dorchesterGatwick.total, "117.10");
});

test("discounts round to the nearest penny and unresolved discounts produce no price", () => {
  const rounded = fare(baseArea, heathrowEndpoint, {
    distanceMiles: "1.235",
    configuration: { ...configuration, radiusLocationDiscounts: [radiusRule("radius", { discountPercentage: "12.5" })] },
    separateCharges: []
  });
  assert.equal(rounded.status === "calculated" && rounded.standardBaseFare, "2.47");
  assert.equal(rounded.status === "calculated" && rounded.discountAmount, "0.31", "12.5% of 2.47 = 0.30875");

  const unresolved = fare({ postcode: "BH21 1AA" }, heathrowEndpoint);
  assert.equal(unresolved.status, "unresolved");
  assert.match(unresolved.status === "unresolved" ? unresolved.reasons.join(" ") : "", /missing or invalid coordinates/);
  assert.ok(!("total" in unresolved), "no partial price is returned");
});

test("fare calculation leaves the dead-mileage free radius configuration untouched", () => {
  const before = JSON.stringify(configuration);
  fare(baseArea, heathrowEndpoint);
  assert.equal(JSON.stringify(configuration), before);
  assert.deepEqual(configuration.deadMileage, { enabled: false, freeRadiusMiles: "4", ratePerMile: "" });
});
