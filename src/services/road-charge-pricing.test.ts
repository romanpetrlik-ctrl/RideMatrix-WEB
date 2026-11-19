import assert from "node:assert/strict";
import test from "node:test";
import type { PriceLine } from "./booking-pricing";
import type { BookingRoute, RoadChargeZoneDetection, TunnelCrossing } from "./booking-routing";
import { journeyWindow, roadChargeLines, type RoadChargeScheduleSet } from "./road-charge-pricing";
import {
  DEFAULT_STANDARD_CAR_PROFILE,
  NO_CHARGE,
  roadChargeScheduleSeeds,
  ULEZ_COMPLIANT,
  type RoadChargeProfile,
  type RoadChargeScheme
} from "./road-charge-schedules";

// Route geometry provenance is enforced separately (see the "production gate" test); these tests isolate the rules.
const verifiedGeometry = { codeCalculationBlockers: () => [] };
const EMPTY_PROFILE: RoadChargeProfile = { lez: "", ulez: "", congestionCharge: "", tunnelVehicleClass: "", tunnelAutoPay: "" };

function activeSet(...schemes: RoadChargeScheme[]): RoadChargeScheduleSet {
  return Object.fromEntries(schemes.map((scheme) => [scheme, {
    scheme,
    version: 3,
    status: "active",
    schedule: {
      ...structuredClone(roadChargeScheduleSeeds[scheme]),
      status: "active",
      active: true,
      bookingPriceUsage: "new-booking-quotes",
      verification: { verifiedOn: "2026-11-19", verifiedByEmail: "admin@example.com", verifiedByAccountId: "u-1", recordedAt: "2026-11-19T10:00:00.000Z", sourcesConfirmed: true }
    }
  }]));
}

const ALL = activeSet("london-lez", "london-ulez", "london-congestion-charge", "blackwall-silvertown-tunnels");

function zone(id: RoadChargeZoneDetection["zone"]): RoadChargeZoneDetection {
  return { zone: id, label: id, evidence: { method: "route-polygon-intersection", segmentIndex: 1, firstContact: { latitude: 51.5, longitude: -0.1 }, boundaryDataset: "fixture" } };
}

function crossing(tunnel: "blackwall" | "silvertown", direction: "northbound" | "southbound", verified = true): TunnelCrossing {
  return {
    tunnel,
    label: tunnel === "blackwall" ? "Blackwall Tunnel" : "Silvertown Tunnel",
    direction,
    segmentIndex: 4,
    point: { latitude: 51.504, longitude: tunnel === "blackwall" ? -0.003 : 0.008 },
    geometry: { verified, provenance: "fixture" }
  };
}

function route(overrides: Partial<Extract<BookingRoute, { status: "resolved" }>> = {}): BookingRoute {
  return {
    status: "resolved",
    provider: "google-routes",
    distanceMeters: 10000,
    distanceMiles: "6.213712",
    durationSeconds: 1800,
    trafficModel: "traffic-aware",
    path: [{ latitude: 51.5, longitude: -0.2 }, { latitude: 51.5, longitude: 0.1 }],
    tollsReported: false,
    zones: [],
    tunnelCrossings: [],
    computedAt: "2026-11-19T00:00:00.000Z",
    ...overrides
  };
}

const profile = (overrides: Partial<RoadChargeProfile>): RoadChargeProfile => ({ ...EMPTY_PROFILE, ...overrides });

function zoneLineOf(lines: PriceLine[], scheme: RoadChargeZoneDetection["zone"]): PriceLine {
  const matching = lines.filter((line) => line.type === "road-charge" && (line.source as Record<string, unknown>).scheme === scheme);
  assert.equal(matching.length, 1, `exactly one ${scheme} line`);
  return matching[0];
}

function zoneCharge(scheme: RoadChargeZoneDetection["zone"], date: string, time: string, declared: Partial<RoadChargeProfile>, schedules = ALL, durationSeconds = 1800): PriceLine {
  const lines = roadChargeLines(date, time, profile(declared), route({ zones: [zone(scheme)], durationSeconds }), schedules, verifiedGeometry);
  return zoneLineOf(lines, scheme);
}

function tunnelCharges(date: string, time: string, declared: Partial<RoadChargeProfile>, crossings: TunnelCrossing[], extra: Partial<Extract<BookingRoute, { status: "resolved" }>> = {}): PriceLine[] {
  return roadChargeLines(date, time, profile(declared), route({ tunnelCrossings: crossings, ...extra }), ALL, verifiedGeometry);
}

test("journey windows use the Europe/London service date/time with a duration-based buffer", () => {
  const summer = journeyWindow("2027-07-01", "10:00", 1800);
  assert.equal(summer.startUtc, "2027-07-01T09:00:00.000Z", "BST is UTC+1");
  assert.equal(summer.bufferMinutes, 15);
  assert.equal(summer.endUtc, "2027-07-01T09:45:00.000Z");
  const winter = journeyWindow("2027-01-15", "10:00", 7200);
  assert.equal(winter.startUtc, "2027-01-15T10:00:00.000Z", "GMT is UTC+0");
  assert.equal(winter.bufferMinutes, 30);
  assert.deepEqual(journeyWindow("2027-03-10", "23:50", 1800).segments.map((segment) => segment.date), ["2027-03-10", "2027-03-11"]);
});

test("LEZ charges its daily rate every day including Christmas, and distinguishes no-charge from not stated", () => {
  const weekday = zoneCharge("london-lez", "2027-03-10", "10:00", { lez: "lez-vans-specialist-minibuses" });
  assert.equal(weekday.status, "applied");
  assert.equal(weekday.amount, "100.00");
  assert.equal(weekday.label, "London LEZ daily charge — Wed, 10 Mar 2027");
  const source = weekday.source as Record<string, any>;
  assert.equal(source.schedule.version, 3);
  assert.equal(source.schedule.verifiedOn, "2026-11-19");
  assert.equal(source.matchingBasis.method, "route-polygon-intersection");
  assert.equal(source.vehicleInput.value, "lez-vans-specialist-minibuses");
  assert.equal(source.rate.amount, "100.00");
  assert.equal(source.chargingDay, "2027-03-10");

  assert.equal(zoneCharge("london-lez", "2027-12-25", "03:00", { lez: "lez-heavy-below-euro-iv-pm" }).amount, "300.00");
  assert.equal(zoneCharge("london-lez", "2027-03-13", "10:00", { lez: "lez-heavy-euro-iv-pm" }).amount, "100.00");

  const compliant = zoneCharge("london-lez", "2027-03-10", "10:00", { lez: NO_CHARGE });
  assert.equal(compliant.status, "not-applicable");
  assert.equal(compliant.amount, null);
  const unstated = zoneCharge("london-lez", "2027-03-10", "10:00", {});
  assert.equal(unstated.status, "unresolved");
  assert.match(unstated.basis, /LEZ position is not recorded/);
  assert.equal(unstated.amount, null);
});

test("zone charges are unresolved when the schedule is missing, inactive, out of period or the day is ambiguous", () => {
  const declared = { lez: "lez-vans-specialist-minibuses" };
  const missing = zoneCharge("london-lez", "2027-03-10", "10:00", declared, {});
  assert.equal(missing.status, "unresolved");
  assert.match(missing.basis, /No London LEZ fee schedule is configured/);

  const inactive = zoneCharge("london-lez", "2027-03-10", "10:00", declared, {
    "london-lez": { scheme: "london-lez", version: 2, status: "inactive", schedule: structuredClone(roadChargeScheduleSeeds["london-lez"]) }
  });
  assert.equal(inactive.status, "unresolved");
  assert.match(inactive.basis, /not active for booking prices/);

  const legacy = zoneCharge("london-lez", "2027-03-10", "10:00", declared, { "london-lez": { scheme: "london-lez", version: 1, status: "draft_inactive", schedule: null } });
  assert.match(legacy.basis, /legacy draft/);

  const beforeEffective = zoneCharge("london-lez", "2020-06-01", "10:00", declared);
  assert.equal(beforeEffective.status, "unresolved");
  assert.match(beforeEffective.basis, /outside the schedule's effective period/);

  const overMidnight = zoneCharge("london-lez", "2027-03-10", "23:50", declared);
  assert.equal(overMidnight.status, "unresolved");
  assert.match(overMidnight.basis, /crosses midnight/);
});

test("ULEZ charges cars, vans and motorcycles daily but not on Christmas Day", () => {
  assert.equal(zoneCharge("london-ulez", "2027-03-10", "10:00", { ulez: "ulez-cars" }).amount, "12.50");
  assert.equal(zoneCharge("london-ulez", "2027-03-10", "10:00", { ulez: "ulez-vans-specialist-minibuses" }).amount, "12.50");
  assert.equal(zoneCharge("london-ulez", "2027-03-14", "02:00", { ulez: "ulez-motorcycles-and-l-category" }).amount, "12.50");
  const christmas = zoneCharge("london-ulez", "2027-12-25", "10:00", { ulez: "ulez-cars" });
  assert.equal(christmas.status, "not-applicable");
  assert.equal(christmas.amount, null);
  const christmasEve = zoneCharge("london-ulez", "2027-12-24", "23:50", { ulez: "ulez-cars" });
  assert.equal(christmasEve.status, "unresolved", "a window from 24 into 25 December cannot be resolved to one charging day");
});

test("Congestion Charge applies hours, weekends, bank holidays, the Christmas closure and its discounts", () => {
  const cc = (date: string, time: string, value = "cc-standard", durationSeconds = 1800) =>
    zoneCharge("london-congestion-charge", date, time, { congestionCharge: value }, ALL, durationSeconds);

  assert.equal(cc("2027-03-10", "10:00").amount, "21.00", "the conservative £21 default approved for New Booking quotes");
  assert.equal(cc("2027-03-10", "10:00").status, "applied");
  assert.equal(cc("2027-03-10", "06:00").status, "not-applicable", "06:00–06:45 is before the 07:00 weekday start");
  assert.equal(cc("2027-03-10", "06:40").status, "unresolved", "the window straddles 07:00");
  assert.equal(cc("2027-03-10", "17:50").status, "unresolved", "the window straddles 18:00");
  assert.equal(cc("2027-03-10", "18:00").status, "not-applicable");
  assert.equal(cc("2027-03-13", "10:00").status, "not-applicable", "Saturday charging starts at 12:00");
  assert.equal(cc("2027-03-13", "13:00").amount, "21.00");
  assert.equal(cc("2027-05-03", "10:00").status, "not-applicable", "the early May bank holiday uses weekend hours");
  assert.equal(cc("2027-05-03", "13:00").amount, "21.00");
  assert.equal(cc("2026-12-29", "13:00").status, "not-applicable", "no charge between Christmas Day and New Year's Day");
  assert.equal(cc("2025-12-29", "13:00").status, "unresolved", "before the schedule's effective date");
  const beyond = cc("2028-02-01", "10:00");
  assert.equal(beyond.status, "unresolved");
  assert.match(beyond.basis, /bank-holiday calendar/);

  assert.equal(cc("2027-03-10", "10:00", "cc-cvd-electric-car-autopay").amount, "13.50");
  assert.equal(cc("2027-03-10", "10:00", "cc-cvd-electric-van-hgv-quadricycle-autopay").amount, "9.00");
  const registered = cc("2027-03-10", "10:00", "cc-registered-100-percent-discount");
  assert.equal(registered.status, "zero");
  assert.equal(registered.amount, "0.00", "a configured £0.00 is a resolved zero charge");
  const exempt = cc("2027-03-10", "10:00", NO_CHARGE);
  assert.equal(exempt.status, "not-applicable");
  assert.equal(exempt.amount, null);
  assert.equal(cc("2027-03-10", "10:00", "").status, "unresolved");
});

test("each zone yields one daily line however often the route enters it; LEZ, ULEZ and CC are itemized separately", () => {
  const lines = roadChargeLines("2027-03-10", "10:00", profile({ lez: "lez-vans-specialist-minibuses", ulez: "ulez-vans-specialist-minibuses", congestionCharge: "cc-standard" }),
    route({ zones: [zone("london-lez"), zone("london-ulez"), zone("london-congestion-charge"), zone("london-congestion-charge")] }), ALL, verifiedGeometry);
  assert.deepEqual(lines.map((line) => [line.type, line.label.split(" —")[0], line.amount]), [
    ["road-charge", "London LEZ daily charge", "100.00"],
    ["road-charge", "London ULEZ daily charge", "12.50"],
    ["road-charge", "London Congestion Charge daily charge", "21.00"],
    ["tunnel-charge", "Blackwall and Silvertown tunnels", null],
    ["toll", "Other tolls", null]
  ]);
  assert.equal(lines[3].status, "not-applicable");

  const defaultOutside = roadChargeLines("2027-03-10", "10:00", DEFAULT_STANDARD_CAR_PROFILE, route(), ALL, verifiedGeometry);
  assert.deepEqual(defaultOutside.map((line) => [line.type, line.status]), [["road-charge", "not-applicable"], ["road-charge", "zero"], ["road-charge", "not-applicable"], ["tunnel-charge", "not-applicable"], ["toll", "not-applicable"]]);
});

test("production gate: ULEZ stays unresolved while its geometry is unverified; verified CC and tunnel data can price", () => {
  const lines = roadChargeLines("2027-03-10", "10:00", profile({ ulez: "ulez-cars", congestionCharge: "cc-standard", tunnelVehicleClass: "cars-and-small-vans", tunnelAutoPay: "yes" }),
    route({ zones: [zone("london-ulez"), zone("london-congestion-charge")], tunnelCrossings: [crossing("blackwall", "northbound")] }), ALL);
  assert.deepEqual(lines.map((line) => line.status), ["unresolved", "unresolved", "applied", "applied", "not-applicable"]);
  assert.match(lines[1].basis, /boundary dataset/);
  assert.equal(lines[2].amount, "21.00");
  assert.doesNotMatch(lines[2].basis, /boundary dataset|geometry/);
  assert.equal(lines[3].amount, "1.55");
  assert.ok(lines.filter((line) => line.status === "unresolved").every((line) => line.amount === null));
});

test("tunnel crossings price by tunnel, direction, time band, vehicle class and Auto Pay", () => {
  const car = { tunnelVehicleClass: "cars-and-small-vans", tunnelAutoPay: "yes" };
  const priced = (date: string, time: string, declared: Partial<RoadChargeProfile>, cross: TunnelCrossing) => {
    const lines = tunnelCharges(date, time, declared, [cross]).filter((line) => line.type === "tunnel-charge");
    assert.equal(lines.length, 1);
    return lines[0];
  };
  // Wednesday 10 March 2027.
  const northPeak = priced("2027-03-10", "07:00", car, crossing("blackwall", "northbound"));
  assert.equal(northPeak.amount, "4.20");
  assert.equal(northPeak.label, "Blackwall Tunnel — northbound crossing 1");
  assert.equal((northPeak.source as Record<string, any>).rate.key, "tunnel-cars-and-small-vans-autopay-peak");
  assert.equal((northPeak.source as Record<string, any>).tunnel, "blackwall");
  assert.equal(priced("2027-03-10", "07:00", car, crossing("silvertown", "southbound")).amount, "1.55", "southbound is off-peak in the morning");
  assert.equal(priced("2027-03-10", "07:00", car, crossing("silvertown", "southbound")).label, "Silvertown Tunnel — southbound crossing 1");
  assert.equal(priced("2027-03-10", "16:30", car, crossing("silvertown", "southbound")).amount, "4.20");
  assert.equal(priced("2027-03-10", "16:30", car, crossing("blackwall", "northbound")).amount, "1.55");
  assert.equal(priced("2027-03-10", "09:50", car, crossing("blackwall", "northbound")).status, "unresolved", "window straddles the 10:00 peak end");
  assert.equal(priced("2027-03-13", "07:00", car, crossing("blackwall", "northbound")).amount, "1.55", "weekends are off-peak");

  assert.equal(priced("2027-03-10", "11:00", { ...car, tunnelAutoPay: "no" }, crossing("blackwall", "southbound")).amount, "4.20", "without Auto Pay the phone/online rate applies");
  assert.equal(priced("2027-03-10", "07:00", { tunnelVehicleClass: "heavy-goods-vehicles", tunnelAutoPay: "yes" }, crossing("blackwall", "northbound")).amount, "10.50");
  assert.equal(priced("2027-03-10", "11:00", { tunnelVehicleClass: "large-vans", tunnelAutoPay: "yes" }, crossing("blackwall", "northbound")).amount, "2.60");
  assert.equal(priced("2027-03-10", "11:00", { tunnelVehicleClass: "motorcycles-mopeds-motor-tricycles", tunnelAutoPay: "no" }, crossing("blackwall", "northbound")).amount, "2.60");

  assert.equal(priced("2027-03-10", "22:00", car, crossing("blackwall", "northbound")).status, "not-applicable", "free 22:00–06:00");
  assert.equal(priced("2027-03-10", "05:50", car, crossing("blackwall", "northbound")).status, "unresolved", "window straddles 06:00");
  assert.equal(priced("2027-12-25", "12:00", car, crossing("blackwall", "northbound")).status, "not-applicable", "no charge on Christmas Day");
  const bankHoliday = priced("2027-05-03", "11:00", car, crossing("blackwall", "northbound"));
  assert.equal(bankHoliday.status, "unresolved");
  assert.match(bankHoliday.basis, /weekday bank holiday/);
  assert.equal(priced("2027-05-03", "11:00", { ...car, tunnelAutoPay: "no" }, crossing("blackwall", "northbound")).amount, "4.20");
  assert.equal(priced("2026-09-01", "11:00", car, crossing("blackwall", "northbound")).status, "unresolved", "before charging starts on 21 September 2026");

  assert.equal(priced("2027-03-10", "11:00", { tunnelAutoPay: "yes" }, crossing("blackwall", "northbound")).status, "unresolved");
  assert.equal(priced("2027-03-10", "11:00", { tunnelVehicleClass: "cars-and-small-vans" }, crossing("blackwall", "northbound")).status, "unresolved");
  assert.equal(priced("2027-03-10", "11:00", car, crossing("blackwall", "northbound", false)).status, "unresolved");
});

test("repeated tunnel crossings are each itemized and known tunnels are not double counted as unidentified tolls", () => {
  const car = { tunnelVehicleClass: "cars-and-small-vans", tunnelAutoPay: "yes" };
  const lines = tunnelCharges("2027-03-10", "11:00", car, [crossing("blackwall", "northbound"), crossing("silvertown", "southbound")], { tollsReported: true });
  const tunnels = lines.filter((line) => line.type === "tunnel-charge");
  assert.deepEqual(tunnels.map((line) => [line.label, line.amount]), [
    ["Blackwall Tunnel — northbound crossing 1", "1.55"],
    ["Silvertown Tunnel — southbound crossing 2", "1.55"]
  ]);
  const tolls = lines.filter((line) => line.type === "toll");
  assert.equal(tolls.length, 1);
  assert.equal(tolls[0].label, "Other tolls");
  assert.equal(tolls[0].status, "unresolved", "the provider's toll flag cannot be attributed beyond the identified tunnels");
  assert.equal(tolls[0].amount, null);
  assert.match(tolls[0].basis, /itemized separately and not counted here/);
  assert.equal((tolls[0].source as Record<string, unknown>).tunnelCrossingsExcluded, true);

  const noTolls = tunnelCharges("2027-03-10", "11:00", car, [crossing("blackwall", "northbound")]).find((line) => line.type === "toll");
  assert.equal(noTolls?.status, "not-applicable");
});

test("an unresolved route leaves every road-charge category unresolved", () => {
  const lines = roadChargeLines("2027-03-10", "10:00", profile({ lez: NO_CHARGE }), { status: "unresolved", reason: "provider-error", message: "down" }, ALL);
  assert.deepEqual(lines.map((line) => [line.type, line.status, line.amount]), [
    ["road-charge", "unresolved", null],
    ["road-charge", "unresolved", null],
    ["road-charge", "unresolved", null],
    ["tunnel-charge", "unresolved", null],
    ["toll", "unresolved", null]
  ]);
});

test("zone charges stay unresolved when no vehicle is assigned at quote time", () => {
  const lines = roadChargeLines("2027-03-10", "10:00", null, route({ zones: [zone("london-lez"), zone("london-ulez")] }), ALL, verifiedGeometry);
  assert.deepEqual(lines.filter((line) => line.type === "road-charge").map((line) => [line.status, line.amount]), [["unresolved", null], ["unresolved", null], ["unresolved", null]]);
});

test("the default standard car profile gives explicit ULEZ £0, LEZ not charged, CC £21 and the standard tunnel car rate", () => {
  const lines = roadChargeLines("2027-03-10", "11:00", DEFAULT_STANDARD_CAR_PROFILE,
    route({ zones: [zone("london-lez"), zone("london-ulez"), zone("london-congestion-charge")], tunnelCrossings: [crossing("blackwall", "northbound")] }), ALL, verifiedGeometry);
  assert.equal(zoneLineOf(lines, "london-lez").status, "not-applicable");
  const ulez = zoneLineOf(lines, "london-ulez");
  assert.equal(ulez.status, "zero");
  assert.equal(ulez.amount, "0.00");
  assert.equal(zoneLineOf(lines, "london-congestion-charge").amount, "21.00");
  const tunnel = lines.find((line) => line.type === "tunnel-charge");
  assert.equal(tunnel?.amount, "4.20", "standard car rate without Auto Pay");
  assert.equal((tunnel?.source as Record<string, any>).rate.key, "tunnel-cars-and-small-vans-phone-online");
});

test("a vehicle with an unknown ULEZ emission class is never assumed compliant", () => {
  const lines = roadChargeLines("2027-03-10", "11:00", profile({ lez: NO_CHARGE, ulez: "", congestionCharge: "cc-standard" }),
    route({ zones: [zone("london-ulez")] }), ALL, verifiedGeometry);
  const ulez = zoneLineOf(lines, "london-ulez");
  assert.equal(ulez.status, "unresolved");
  assert.equal(ulez.amount, null);
  assert.match(ulez.basis, /is not recorded/);
});

test("assigning or changing a vehicle recalculates dependent charges and leaves the earlier quote unchanged", () => {
  const quoteRoute = route({ zones: [zone("london-ulez")] });
  const defaultQuote = roadChargeLines("2027-03-10", "11:00", DEFAULT_STANDARD_CAR_PROFILE, quoteRoute, ALL, verifiedGeometry);
  const snapshot = structuredClone(defaultQuote);
  assert.equal(zoneLineOf(defaultQuote, "london-ulez").amount, "0.00");

  const assigned = roadChargeLines("2027-03-10", "11:00", profile({ lez: NO_CHARGE, ulez: ULEZ_COMPLIANT, congestionCharge: "cc-standard", tunnelVehicleClass: "cars-and-small-vans", tunnelAutoPay: "no" }),
    quoteRoute, ALL, verifiedGeometry);
  assert.equal(zoneLineOf(assigned, "london-ulez").status, "zero");

  const changed = roadChargeLines("2027-03-10", "11:00", profile({ lez: NO_CHARGE, ulez: "", congestionCharge: "cc-standard" }), quoteRoute, ALL, verifiedGeometry);
  assert.equal(zoneLineOf(changed, "london-ulez").status, "unresolved");
  assert.deepEqual(defaultQuote, snapshot, "the earlier quote is not mutated by recalculation");
});
