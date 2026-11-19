import assert from "node:assert/strict";
import test from "node:test";
import type { AirportFeeRecord } from "./airport-fees";
import { priceBooking, type BookingPricingContext, type BookingPricingInputs, type BookingStop, type PriceLine } from "./booking-pricing";
import type { BookingRoute, RoadChargeZoneDetection } from "./booking-routing";
import { EARTH_RADIUS_MILES, type OperationalBase } from "./dead-mileage";
import {
  EMPTY_FARE_SETTINGS,
  type FareSettingsConfiguration,
  type LocationDiscountRule,
  type RadiusLocationDiscountRule
} from "./fare-settings";
import type { PoiFeeRecord, PoiRecord } from "./poi-management";
import { applyRoadChargeActivation, roadChargeScheduleSeeds } from "./road-charge-schedules";

const timestamp = "2026-01-01T00:00:00.000Z";
const slabs = [
  { startMiles: "0", endMiles: "10", ratePerMile: "2.00" },
  { startMiles: "10", endMiles: "30", ratePerMile: "1.50" },
  { startMiles: "30", endMiles: "", ratePerMile: "1.00" }
];

function airport(id: string, overrides: Partial<AirportFeeRecord> = {}): AirportFeeRecord {
  return {
    id,
    displayName: `Airport ${id}`,
    dropoffPlaceId: `${id}-drop`,
    dropoffLocationLabel: "Departures",
    dropoffLatitude: 51.47,
    dropoffLongitude: -0.45,
    dropoffFee: "6.00",
    pickupPlaceId: `${id}-pick`,
    pickupLocationLabel: "Arrivals",
    pickupLatitude: 51.471,
    pickupLongitude: -0.451,
    pickupFee: "7.00",
    pickupTimeReference: "ALT",
    pickupDeferredEnabled: false,
    pickupDeferredMinutes: null,
    pickupFeeCoveredMinutes: 60,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function poi(id: string): PoiRecord {
  return { id, displayName: `POI ${id}`, category: "Hotel", placeId: `${id}-place`, locationLabel: "Front door", latitude: 51.5, longitude: -0.12, notes: "", createdAt: timestamp, updatedAt: timestamp };
}

function poiFee(id: string, poiId: string, overrides: Partial<PoiFeeRecord> = {}): PoiFeeRecord {
  return { id, poiId, poiDisplayName: `POI ${poiId}`, action: "Entry", amount: "4.50", currency: "GBP", feeBasis: "Per entry", trigger: "selection", notes: "", createdAt: timestamp, updatedAt: timestamp, ...overrides };
}

const base: OperationalBase = { operatorId: "op", latitude: 50.8, longitude: -1.9, providerPlaceId: "base", coordinatesVerified: true, updatedAt: timestamp };
const northOfBase = (miles: number) => 50.8 + (miles / EARTH_RADIUS_MILES) * 180 / Math.PI;

function airportStop(id: string): BookingStop {
  return { kind: "airport", managedId: id, placeId: `${id}-pick`, label: `Airport ${id}`, latitude: 51.47, longitude: -0.45, coordinatesVerified: true, postcode: null };
}
function poiStop(id: string, label = `POI ${id}`): BookingStop {
  return { kind: "poi", managedId: id, placeId: `${id}-place`, label, latitude: 51.5, longitude: -0.12, coordinatesVerified: true, postcode: null };
}
function addressStop(latitude: number, postcode: string | null, label = "1 High Street"): BookingStop {
  return { kind: "address", managedId: null, placeId: "place-address", label, latitude, longitude: -1.9, coordinatesVerified: true, postcode };
}

function route(distanceMiles: string, overrides: Partial<Extract<BookingRoute, { status: "resolved" }>> = {}): BookingRoute {
  return {
    status: "resolved",
    provider: "google-routes",
    distanceMeters: Math.round(Number(distanceMiles) * 1609.344),
    distanceMiles,
    durationSeconds: 1800,
    trafficModel: "traffic-aware",
    path: [{ latitude: 51, longitude: -1 }, { latitude: 51.1, longitude: -1.1 }],
    tollsReported: false,
    zones: [],
    tunnelCrossings: [],
    computedAt: timestamp,
    ...overrides
  };
}

function zoneHit(zone: RoadChargeZoneDetection["zone"], label: string): RoadChargeZoneDetection {
  return { zone, label, evidence: { method: "route-polygon-intersection", segmentIndex: 0, firstContact: { latitude: 51.5, longitude: -0.12 }, boundaryDataset: "test" } };
}

function inputs(overrides: Partial<BookingPricingInputs> = {}): BookingPricingInputs {
  return {
    serviceDate: "2027-03-10",
    serviceTime: "10:00",
    stops: { pickup: addressStop(northOfBase(50), null, "Start"), vias: [], dropoff: addressStop(northOfBase(60), null, "End") },
    confirmedPoiFeeIds: [],
    ...overrides
  };
}

function context(overrides: Omit<Partial<BookingPricingContext>, "configuration"> & { configuration?: Partial<FareSettingsConfiguration> } = {}): BookingPricingContext {
  const { configuration, ...rest } = overrides;
  return {
    configuration: { ...EMPTY_FARE_SETTINGS, distanceSlabs: slabs, ...configuration },
    fareSettingsVersion: 7,
    airports: [airport("rm-lhr"), airport("rm-lgw")],
    pois: [poi("poi-a"), poi("poi-b")],
    poiFees: [],
    operationalBase: base,
    route: route("12"),
    roadChargeOptions: { codeCalculationBlockers: () => [] },
    ...rest
  };
}

const lineOf = (lines: PriceLine[], type: PriceLine["type"]) => lines.filter((line) => line.type === type);
const one = (lines: PriceLine[], type: PriceLine["type"]) => {
  const matches = lineOf(lines, type);
  assert.equal(matches.length, 1, `expected exactly one ${type} line`);
  return matches[0];
};
const roadCharge = (lines: PriceLine[], scheme: string) => {
  const matches = lines.filter((line) => line.type === "road-charge" && (line.source as Record<string, unknown>).scheme === scheme);
  assert.equal(matches.length, 1, `expected exactly one ${scheme} road-charge line`);
  return matches[0];
};
const pennies = (amount: string) => Math.round(Number(amount) * 100);

test("ride fare charges each Distance Slab progressively, boundaries belong to the next slab and fractions are rounded once", () => {
  const cases: Array<[string, string]> = [
    ["10", "20.00"],
    ["10.5", "20.75"],
    ["30", "50.00"],
    ["12.345678", "23.52"],
    ["145.333333", "165.33"]
  ];
  for (const [miles, expected] of cases) {
    const price = priceBooking(inputs(), context({ route: route(miles) }));
    const ride = one(price.lines, "ride-fare");
    assert.equal(ride.status, "applied", miles);
    assert.equal(ride.amount, expected, miles);
    assert.match(ride.basis, /standard Distance Slabs/);
  }
});

test("minimum fare applies only to the exact managed airport ID on the pickup or drop-off", () => {
  const configuration = { minimumFareRules: [{ id: "min-lhr", name: "Heathrow minimum", poiId: "rm-lhr", minimumBaseFare: "45.00" }] };
  const atHeathrow = priceBooking(inputs({ stops: { pickup: airportStop("rm-lhr"), vias: [], dropoff: addressStop(51.2, null) } }), context({ configuration }));
  assert.equal(one(atHeathrow.lines, "ride-fare").amount, "45.00");
  assert.match(one(atHeathrow.lines, "ride-fare").basis, /minimum fare rule "Heathrow minimum"/);

  const dropoffHeathrow = priceBooking(inputs({ stops: { pickup: addressStop(51.2, null), vias: [], dropoff: airportStop("rm-lhr") } }), context({ configuration }));
  assert.equal(one(dropoffHeathrow.lines, "ride-fare").amount, "45.00");

  const otherAirport = priceBooking(inputs({ stops: { pickup: airportStop("rm-lgw"), vias: [], dropoff: addressStop(51.2, null) } }), context({ configuration }));
  assert.equal(one(otherAirport.lines, "ride-fare").amount, "23.00");

  const viaOnly = priceBooking(inputs({ stops: { pickup: addressStop(51.2, null), vias: [airportStop("rm-lhr")], dropoff: addressStop(51.3, null) } }), context({ configuration }));
  assert.equal(one(viaOnly.lines, "ride-fare").amount, "23.00");

  const sameLabelDifferentId = priceBooking(
    inputs({ stops: { pickup: { ...airportStop("rm-lgw"), label: "Airport rm-lhr" }, vias: [], dropoff: addressStop(51.2, null) } }),
    context({ configuration })
  );
  assert.equal(one(sameLabelDifferentId.lines, "ride-fare").amount, "23.00");

  const longTrip = priceBooking(inputs({ stops: { pickup: airportStop("rm-lhr"), vias: [], dropoff: addressStop(51.2, null) } }), context({ configuration, route: route("40") }));
  assert.equal(one(longTrip.lines, "ride-fare").amount, "60.00");
  assert.match(one(longTrip.lines, "ride-fare").basis, /not reached/);
});

test("airport pick-up and drop-off fees are separate lines matched by exact airport ID; £0.00 and missing records stay distinct", () => {
  const price = priceBooking(
    inputs({ stops: { pickup: airportStop("rm-lhr"), vias: [], dropoff: airportStop("rm-lgw") } }),
    context({ airports: [airport("rm-lhr"), airport("rm-lgw", { dropoffFee: "0.00" })] })
  );
  const pickup = one(price.lines, "airport-pickup-fee");
  const dropoff = one(price.lines, "airport-dropoff-fee");
  assert.equal(pickup.status, "applied");
  assert.equal(pickup.amount, "7.00");
  assert.match(pickup.label, /Airport rm-lhr/);
  assert.equal(pickup.source.airportId, "rm-lhr");
  assert.equal(dropoff.status, "zero");
  assert.equal(dropoff.amount, "0.00");
  assert.match(dropoff.label, /Airport rm-lgw/);
  assert.equal(one(price.lines, "ride-fare").amount, "23.00", "airport fees are never folded into the ride fare");
  assert.equal(price.total, "30.00");

  const missing = priceBooking(
    inputs({ stops: { pickup: airportStop("rm-retired"), vias: [], dropoff: addressStop(51.2, null) } }),
    context()
  );
  assert.equal(one(missing.lines, "airport-pickup-fee").status, "unresolved");
  assert.equal(one(missing.lines, "airport-pickup-fee").amount, null);
  assert.equal(one(missing.lines, "airport-dropoff-fee").status, "not-applicable");
  assert.equal(missing.status, "incomplete");
  assert.equal(missing.total, null);
});

test("POI fees match only the selected POI ID; confirmation fees require explicit confirmation", () => {
  const poiFees = [
    poiFee("fee-entry", "poi-a"),
    poiFee("fee-valet", "poi-a", { action: "Valet", amount: "12.00", trigger: "confirmation" }),
    poiFee("fee-free", "poi-a", { action: "Drop zone", amount: "0.00" }),
    poiFee("fee-other", "poi-b", { amount: "99.00" })
  ];
  const stops = { pickup: poiStop("poi-a", "POI poi-b"), vias: [], dropoff: addressStop(51.2, null) };
  const unconfirmed = priceBooking(inputs({ stops }), context({ poiFees }));
  const fees = lineOf(unconfirmed.lines, "poi-fee");
  assert.deepEqual(fees.map((line) => [line.source.poiFeeId, line.status, line.amount]), [
    ["fee-entry", "applied", "4.50"],
    ["fee-valet", "not-applicable", null],
    ["fee-free", "zero", "0.00"]
  ]);
  assert.ok(!fees.some((line) => line.source.poiFeeId === "fee-other"), "never matched by label");

  const confirmed = priceBooking(inputs({ stops, confirmedPoiFeeIds: ["fee-valet"] }), context({ poiFees }));
  const valet = lineOf(confirmed.lines, "poi-fee").find((line) => line.source.poiFeeId === "fee-valet")!;
  assert.equal(valet.status, "applied");
  assert.equal(valet.amount, "12.00");
  assert.equal(confirmed.total, "39.50");

  const noFees = priceBooking(inputs({ stops: { pickup: poiStop("poi-b"), vias: [], dropoff: addressStop(51.2, null) } }), context());
  assert.equal(one(noFees.lines, "poi-fee").status, "not-applicable");
});

test("radius discount takes exclusive precedence for its location, never falls back to postcode rules and never stacks", () => {
  const radius: RadiusLocationDiscountRule = {
    id: "radius-lhr", name: "Local radius", location: { type: "airport", id: "rm-lhr" }, radiusMiles: "10", discountPercentage: "10",
    startDate: "", endDate: "", enabled: true, radiusCentre: "operational-base", discountBasis: "standard-distance-slabs-base-fare"
  };
  const postcode = (id: string, airportId: string): LocationDiscountRule => ({
    id, name: `Postcode ${id}`, location: { type: "airport", id: airportId }, postcodePrecision: "outward", postcodes: ["BH21"],
    discountPercentage: "25", startDate: "", endDate: "", enabled: true, discountBasis: "standard-distance-slabs-base-fare"
  });
  const configuration = { radiusLocationDiscounts: [radius], locationDiscounts: [postcode("pc-lhr", "rm-lhr"), postcode("pc-lgw", "rm-lgw")] };
  const journey = (airportId: string, milesFromBase: number) => inputs({
    stops: { pickup: addressStop(northOfBase(milesFromBase), "BH21 1AA"), vias: [], dropoff: airportStop(airportId) }
  });

  const within = priceBooking(journey("rm-lhr", 3), context({ configuration, route: route("40") }));
  const withinDiscounts = lineOf(within.lines, "location-discount");
  assert.equal(withinDiscounts.length, 1);
  assert.equal(withinDiscounts[0].status, "applied");
  assert.equal(withinDiscounts[0].source.ruleId, "radius-lhr");
  assert.equal(withinDiscounts[0].amount, "-6.00", "10% of the £60.00 ride fare only");
  assert.equal(within.total, "60.00", "60.00 ride − 6.00 discount + 6.00 airport drop-off fee");

  const outside = priceBooking(journey("rm-lhr", 25), context({ configuration, route: route("40") }));
  assert.equal(one(outside.lines, "location-discount").status, "not-applicable");
  assert.equal(one(outside.lines, "location-discount").amount, null);
  assert.match(one(outside.lines, "location-discount").basis, /postcode rules are not used/);
  assert.equal(outside.total, "66.00");

  const otherLocation = priceBooking(journey("rm-lgw", 25), context({ configuration, route: route("40") }));
  assert.equal(one(otherLocation.lines, "location-discount").source.ruleId, "pc-lgw");
  assert.equal(one(otherLocation.lines, "location-discount").amount, "-15.00");
});

test("discount applies to the minimum-raised ride fare and never to fees", () => {
  const radius: RadiusLocationDiscountRule = {
    id: "radius-lhr", name: "Local radius", location: { type: "airport", id: "rm-lhr" }, radiusMiles: "10", discountPercentage: "20",
    startDate: "", endDate: "", enabled: true, radiusCentre: "operational-base", discountBasis: "standard-distance-slabs-base-fare"
  };
  const price = priceBooking(
    inputs({ stops: { pickup: addressStop(northOfBase(2), null), vias: [], dropoff: airportStop("rm-lhr") } }),
    context({ configuration: { radiusLocationDiscounts: [radius], minimumFareRules: [{ id: "m", name: "Min", poiId: "rm-lhr", minimumBaseFare: "50.00" }] } })
  );
  assert.equal(one(price.lines, "ride-fare").amount, "50.00");
  assert.equal(one(price.lines, "location-discount").amount, "-10.00");
  assert.equal(one(price.lines, "airport-dropoff-fee").amount, "6.00");
  assert.equal(price.total, "46.00");
});

test("every component is its own line and the total equals the sum of resolved lines", () => {
  const price = priceBooking(
    inputs({ stops: { pickup: airportStop("rm-lhr"), vias: [poiStop("poi-a")], dropoff: addressStop(51.2, null) } }),
    context({ poiFees: [poiFee("fee-entry", "poi-a")] })
  );
  assert.equal(price.status, "complete");
  const types = price.lines.map((line) => line.type);
  for (const type of ["ride-fare", "location-discount", "airport-pickup-fee", "airport-dropoff-fee", "poi-fee", "toll", "road-charge", "time-surcharge", "fixed-fare", "dead-mileage"] as const) {
    assert.ok(types.includes(type), type);
  }
  assert.ok(!types.includes("parking" as never), "parking is never a dispatcher price line");
  assert.ok(!types.includes("extra-waiting" as never), "extra waiting is never a dispatcher price line");
  const sum = price.lines.reduce((total, line) => total + (line.amount === null ? 0 : pennies(line.amount)), 0);
  assert.equal(pennies(price.total!), sum);
  assert.equal(price.total, "34.50");
  assert.equal(price.fareSettingsVersion, 7);
});

test("unresolved route, tolls, zones, parking and waiting make the price incomplete without a total", () => {
  const noRoute = priceBooking(inputs(), context({ route: { status: "unresolved", reason: "routing-not-configured", message: "Routing off." } }));
  assert.equal(noRoute.status, "incomplete");
  assert.equal(noRoute.total, null);
  assert.equal(one(noRoute.lines, "ride-fare").status, "unresolved");
  assert.match(one(noRoute.lines, "ride-fare").basis, /Routing off/);
  assert.equal(one(noRoute.lines, "toll").status, "unresolved");

  const charges = priceBooking(
    inputs(),
    context({ route: route("12", { tollsReported: true, zones: [zoneHit("london-ulez", "London ULEZ"), zoneHit("london-congestion-charge", "Congestion Charge zone")] }) })
  );
  assert.equal(one(charges.lines, "ride-fare").amount, "23.00");
  assert.equal(one(charges.lines, "toll").status, "unresolved");
  assert.equal(roadCharge(charges.lines, "london-lez").status, "not-applicable", "the default standard car is not charged by LEZ");
  assert.equal(roadCharge(charges.lines, "london-ulez").status, "zero", "the default standard car is ULEZ-compliant");
  assert.equal(roadCharge(charges.lines, "london-ulez").amount, "0.00");
  assert.equal((roadCharge(charges.lines, "london-ulez").source.vehicleInput as Record<string, unknown>).vehicleAssigned, false);
  assert.equal(roadCharge(charges.lines, "london-congestion-charge").status, "unresolved", "an inactive CC schedule cannot confirm a detected charge");
  assert.ok(charges.lines.every((line) => line.status !== "unresolved" || line.amount === null), "unresolved lines never carry invented amounts");
  assert.equal(charges.unresolvedCount, 2);
  assert.equal(charges.total, null);

  const noSlabs = priceBooking(inputs(), context({ configuration: { distanceSlabs: [] } }));
  assert.equal(one(noSlabs.lines, "ride-fare").status, "unresolved");
  assert.match(one(noSlabs.lines, "ride-fare").basis, /No valid Distance Slabs/);
});

test("the default standard-car profile is not recorded as an assigned vehicle", () => {
  const price = priceBooking(
    inputs(),
    context({
      route: route("12", {
        zones: [zoneHit("london-lez", "London Low Emission Zone (LEZ)")],
        tunnelCrossings: [{
          tunnel: "blackwall", label: "Blackwall Tunnel", direction: "northbound", segmentIndex: 0,
          point: { latitude: 51.504, longitude: -0.003 }, geometry: { verified: true, provenance: "fixture" }
        }]
      })
    })
  );
  const zone = roadCharge(price.lines, "london-lez");
  assert.equal((zone.source.vehicleInput as Record<string, unknown>).vehicleAssigned, false);
  const tunnel = one(price.lines, "tunnel-charge");
  assert.equal((tunnel.source.vehicleInput as Record<string, unknown>).vehicleAssigned, false);
});

test("enabled surcharges and matching fixed fares are surfaced as unresolved rather than ignored", () => {
  const price = priceBooking(
    inputs({ serviceTime: "23:30", stops: { pickup: poiStop("poi-a"), vias: [], dropoff: poiStop("poi-b") } }),
    context({
      configuration: {
        dailySurcharge: { enabled: true, percentage: "20", startTime: "22:00", endTime: "06:00" },
        fixedFares: [{ id: "ff", name: "A to B", origin: { type: "poi", poiId: "poi-a" }, destination: { type: "poi", poiId: "poi-b" }, baseFare: "80.00" }]
      }
    })
  );
  assert.equal(one(price.lines, "time-surcharge").status, "unresolved");
  assert.equal(one(price.lines, "fixed-fare").status, "unresolved");
  assert.equal(price.total, null);
});

test("unknown postcodes keep potentially matching fixed fares unresolved", () => {
  const fixedFares = [{
    id: "postcode-fare",
    name: "BH15 to DT1",
    origin: { type: "postcode" as const, postcode: "BH15", scope: "outward" as const },
    destination: { type: "postcode" as const, postcode: "DT1 1AA", scope: "full" as const },
    baseFare: "80.00"
  }];
  for (const postcode of [null, "not a postcode"]) {
    const price = priceBooking(inputs({
      stops: {
        pickup: addressStop(50.7, "BH15 1AA"),
        vias: [],
        dropoff: addressStop(50.8, postcode)
      }
    }), context({ configuration: { fixedFares } }));
    assert.equal(one(price.lines, "fixed-fare").status, "unresolved", String(postcode));
    assert.match(one(price.lines, "fixed-fare").basis, /postcode is unavailable/);
    assert.equal(price.total, null);
  }

  const definiteMismatch = priceBooking(inputs({
    stops: {
      pickup: addressStop(50.7, "BH14 1AA"),
      vias: [],
      dropoff: addressStop(50.8, null)
    }
  }), context({ configuration: { fixedFares } }));
  assert.equal(one(definiteMismatch.lines, "fixed-fare").status, "not-applicable");
});

test("an active LEZ does not charge the default standard car, and fare discounts never reduce road charges", () => {
  const schedule = applyRoadChargeActivation(roadChargeScheduleSeeds["london-lez"], { action: "enable", verifiedOn: "2026-11-19", sourcesConfirmed: true }, { accountId: "u", email: "a@example.com" }, new Date("2026-11-20T00:00:00Z"));
  const roadChargeSchedules = { "london-lez": { scheme: "london-lez" as const, version: 3, status: "active", schedule } };
  const radius: RadiusLocationDiscountRule = {
    id: "radius-lhr", name: "Local radius", location: { type: "airport", id: "rm-lhr" }, radiusMiles: "10", discountPercentage: "50",
    startDate: "", endDate: "", enabled: true, radiusCentre: "operational-base", discountBasis: "standard-distance-slabs-base-fare"
  };
  const journey = { stops: { pickup: addressStop(northOfBase(2), null), vias: [], dropoff: airportStop("rm-lhr") } };
  const lezRoute = route("12", { zones: [zoneHit("london-lez", "London Low Emission Zone (LEZ)")] });
  const price = priceBooking(inputs(journey), context({ route: lezRoute, roadChargeSchedules, configuration: { radiusLocationDiscounts: [radius] } }));
  assert.equal(one(price.lines, "ride-fare").amount, "23.00");
  assert.equal(one(price.lines, "location-discount").amount, "-11.50", "the discount is calculated on the ride fare only");
  const charge = roadCharge(price.lines, "london-lez");
  assert.equal(charge.status, "not-applicable", "the default standard car is not charged by LEZ");
  assert.equal(charge.amount, null);
  assert.equal(price.status, "complete");
  assert.equal(price.total, "17.50", "23.00 ride fare less the 50% discount, plus the £6.00 airport drop-off fee; the £0.00 ULEZ line adds nothing");

  const inactive = priceBooking(inputs(journey), context({ route: lezRoute }));
  assert.equal(roadCharge(inactive.lines, "london-lez").status, "not-applicable", "the default car exemption does not need a loaded schedule");
  assert.equal(inactive.total, "29.00", "without the radius discount: 23.00 ride fare plus the £6.00 airport drop-off fee");
});
