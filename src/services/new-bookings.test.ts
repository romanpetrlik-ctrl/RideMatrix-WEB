import assert from "node:assert/strict";
import test from "node:test";
import newBookingClient from "../../public/js/new-booking";
import type { AirportFeeRecord } from "./airport-fees";
import { EMPTY_FARE_SETTINGS } from "./fare-settings";
import type { OperationalPlaceVerification } from "./google-places";
import {
  BOOKING_COUNT_FIELDS,
  cargoSummary,
  defaultServiceDateTime,
  isFiveMinuteTime,
  quoteJourney,
  readNewBookingDraft,
  serviceLocalToUtc,
  serviceTimeOptions,
  validateJourney,
  validateNewBooking,
  type BookingManagerCandidate,
  type PricingReferenceData
} from "./new-bookings";

const timestamp = "2026-01-01T00:00:00.000Z";
const now = new Date("2027-03-10T09:00:00Z");

const airport: AirportFeeRecord = {
  id: "airport-1", displayName: "Airport One", dropoffPlaceId: "drop-place", dropoffLocationLabel: "Departures", dropoffLatitude: 51.47,
  dropoffLongitude: -0.45, dropoffFee: "6.00", pickupPlaceId: "pick-place", pickupLocationLabel: "Arrivals", pickupLatitude: 51.471,
  pickupLongitude: -0.451, pickupFee: "7.00", pickupTimeReference: "ALT", pickupDeferredEnabled: false, pickupDeferredMinutes: null,
  pickupFeeCoveredMinutes: 60, createdAt: timestamp, updatedAt: timestamp
};

const reference: PricingReferenceData = {
  fareSettings: { configuration: { ...EMPTY_FARE_SETTINGS, distanceSlabs: [{ startMiles: "0", endMiles: "", ratePerMile: "2.00" }] }, currentVersion: 3, history: [], historyTotal: 0 },
  airports: [airport],
  pois: [{ id: "poi-1", displayName: "Hotel", category: "Hotel", placeId: "poi-place", locationLabel: "Lobby", latitude: 51.5, longitude: -0.12, notes: "", createdAt: timestamp, updatedAt: timestamp }],
  poiFees: [
    { id: "fee-confirm", poiId: "poi-1", poiDisplayName: "Hotel", action: "Porter", amount: "5.00", currency: "GBP", feeBasis: "", trigger: "confirmation", notes: "", createdAt: timestamp, updatedAt: timestamp },
    { id: "fee-elsewhere", poiId: "poi-2", poiDisplayName: "Other", action: "Porter", amount: "5.00", currency: "GBP", feeBasis: "", trigger: "confirmation", notes: "", createdAt: timestamp, updatedAt: timestamp }
  ],
  operationalBase: null,
  roadChargeSchedules: {}
};

const verifiedPlace = (placeId: string): OperationalPlaceVerification => ({
  status: "verified",
  address: {
    formattedAddress: "1 High Street, Poole BH15 1AA, UK", houseNameNumber: "1", addressLine1: "High Street", addressLine2: null, addressLine3: null,
    cityTown: "Poole", county: null, state: null, postcode: "bh151aa", countryCode: "GB", countryName: "United Kingdom",
    latitude: 50.71, longitude: -1.98, providerName: "google", providerPlaceId: placeId
  }
});
const dependencies = {
  now: () => now,
  verifyPlace: async (placeId: string): Promise<OperationalPlaceVerification> => placeId === "bad" ? { status: "unverified" } : verifiedPlace(placeId)
};

const manager: BookingManagerCandidate = { customerId: "customer-from-store", name: "Store Manager", phone: "+44 7700 900123", email: "manager@example.test", company: null, isBusiness: false };
const loadManager = async (id: string) => id === manager.customerId ? manager : null;

function body(overrides: Record<string, unknown> = {}) {
  return {
    customerId: manager.customerId,
    managerName: manager.name,
    managerPhone: manager.phone,
    managerEmail: manager.email,
    passengerIsManager: "yes",
    serviceDate: "2027-03-10",
    serviceTime: "12:05",
    pickupKind: "airport",
    pickupAirportId: "airport-1",
    dropoffKind: "address",
    dropoffLabel: "1 High Street",
    dropoffPlaceId: "place-1",
    adults: "1",
    parkingRequired: "no",
    extraWaitingMinutes: "0",
    ...overrides
  };
}

test("time options are 24-hour HH:mm in five-minute steps, in the service timezone", () => {
  const options = serviceTimeOptions();
  assert.equal(options.length, 288);
  assert.equal(options[0], "00:00");
  assert.equal(options[1], "00:05");
  assert.equal(options[156], "13:00");
  assert.equal(options.at(-1), "23:55");
  assert.ok(options.every(isFiveMinuteTime));
  for (const invalid of ["10:07", "24:00", "9:00", "1:00 PM", "12:60"]) assert.equal(isFiveMinuteTime(invalid), false, invalid);
  assert.equal(serviceLocalToUtc("2027-01-15", "10:00").toISOString(), "2027-01-15T10:00:00.000Z");
  assert.equal(serviceLocalToUtc("2027-07-15", "10:00").toISOString(), "2027-07-15T09:00:00.000Z");
  assert.deepEqual(defaultServiceDateTime(new Date("2027-07-15T09:01:30Z")), { date: "2027-07-15", time: "10:05" });
});

test("passenger is synchronized with the booking manager on the server when the checkbox is ticked", async () => {
  const synced = await validateNewBooking(readNewBookingDraft(body({ passengerName: "Stale Name", passengerPhone: "000" })), reference, dependencies, loadManager);
  assert.deepEqual(synced.errors, []);
  assert.equal(synced.booking!.passengerName, "Store Manager");
  assert.equal(synced.booking!.passengerPhone, "+44 7700 900123");
  assert.equal(synced.booking!.passengerIsManager, true);

  const independent = await validateNewBooking(readNewBookingDraft(body({ passengerIsManager: "", passengerName: "Pat Passenger", passengerPhone: "+44 7700 900456" })), reference, dependencies, loadManager);
  assert.equal(independent.booking!.passengerName, "Pat Passenger");
  assert.equal(independent.booking!.passengerPhone, "+44 7700 900456");
  assert.equal(independent.booking!.passengerIsManager, false);

  const missing = await validateNewBooking(readNewBookingDraft(body({ passengerIsManager: "" })), reference, dependencies, loadManager);
  assert.deepEqual(missing.errors.map((error) => error.field).sort(), ["passengerName", "passengerPhone"]);
});

test("booking manager must be an existing active customer and contact details are validated", async () => {
  const unknown = await validateNewBooking(readNewBookingDraft(body({ customerId: "not-a-customer" })), reference, dependencies, loadManager);
  assert.ok(unknown.errors.some((error) => error.field === "customerId"));
  const invalid = await validateNewBooking(readNewBookingDraft(body({ managerName: "", managerPhone: "abc", managerEmail: "nope" })), reference, dependencies, loadManager);
  assert.deepEqual(invalid.errors.map((error) => error.field).sort(), ["managerEmail", "managerName", "managerPhone"]);
});

test("passenger and luggage counts default to 0, accept 0–7 and reject anything else", async () => {
  const defaults = await validateNewBooking(readNewBookingDraft(body()), reference, dependencies, loadManager);
  assert.deepEqual(defaults.booking!.counts, { adults: 1, children: 0, sportsEquipment: 0, xlBaggage: 0, lBaggage: 0, cabinHandBags: 0, backpacks: 0 });
  const max = Object.fromEntries(BOOKING_COUNT_FIELDS.map(([field]) => [field, "7"]));
  assert.deepEqual((await validateNewBooking(readNewBookingDraft(body(max)), reference, dependencies, loadManager)).errors, []);
  for (const bad of ["8", "-1", "1.5", "two"]) {
    const result = await validateNewBooking(readNewBookingDraft(body({ xlBaggage: bad })), reference, dependencies, loadManager);
    assert.deepEqual(result.errors.map((error) => error.field), ["xlBaggage"], bad);
  }
  const nobody = await validateNewBooking(readNewBookingDraft(body({ adults: "0" })), reference, dependencies, loadManager);
  assert.deepEqual(nobody.errors.map((error) => error.field), ["adults"]);
  const seat = await validateNewBooking(readNewBookingDraft(body({ childSeatRequired: "maybe" })), reference, dependencies, loadManager);
  assert.deepEqual(seat.errors.map((error) => error.field), ["childSeatRequired"]);
});

test("cargo summary is identical on the server and in the browser", () => {
  const cases = [
    [{ adults: 0, children: 0, sportsEquipment: 0, xlBaggage: 0, lBaggage: 0, cabinHandBags: 0, backpacks: 0 }, false, false],
    [{ adults: 2, children: 1, sportsEquipment: 1, xlBaggage: 2, lBaggage: 1, cabinHandBags: 3, backpacks: 1 }, true, true],
    [{ adults: 1, children: 0, sportsEquipment: 7, xlBaggage: 0, lBaggage: 0, cabinHandBags: 1, backpacks: 0 }, false, true]
  ] as const;
  for (const [counts, childSeat, booster] of cases) {
    assert.equal(newBookingClient.cargoSummary({ ...counts }, childSeat, booster), cargoSummary({ ...counts }, childSeat, booster));
  }
  assert.equal(
    cargoSummary(cases[1][0], true, true),
    "3 passengers (2 adults, 1 child) · 7 bags (XL 2, L 1, CB/HB 3, BP 1) · 1 sports item · Requires child seat and booster"
  );
});

test("journey keeps structured stop IDs, ordered vias and rejects invalid date/time or via order", async () => {
  const draft = readNewBookingDraft(body({
    via1Active: "yes", via1Kind: "poi", via1PoiId: "poi-1",
    via2Active: "yes", via2Kind: "address", via2Label: "Unverified Lane", via2PlaceId: "bad"
  }));
  const journey = await validateJourney(draft, reference, dependencies, []);
  assert.ok(journey);
  assert.equal(journey.stops.pickup.managedId, "airport-1");
  assert.equal(journey.stops.pickup.latitude, 51.471, "pickup side coordinates of the exact airport record");
  assert.deepEqual(journey.stops.vias.map((stop) => [stop.kind, stop.managedId, stop.coordinatesVerified]), [["poi", "poi-1", true], ["address", null, false]]);
  assert.equal(journey.stops.dropoff.postcode, "BH15 1AA");
  assert.equal(journey.stops.dropoff.placeId, "place-1");

  let routed = false;
  const quote = await quoteJourney(journey, reference, async () => { routed = true; throw new Error("must not route"); });
  assert.equal(routed, false, "an unverified stop is never routed by guessing");
  assert.equal(quote.route.status, "unresolved");
  assert.equal(quote.price.status, "incomplete");
  assert.equal(quote.price.total, null);

  const errors: Array<{ field: string; message: string }> = [];
  assert.equal(await validateJourney(readNewBookingDraft(body({ via2Active: "yes", via2Kind: "poi", via2PoiId: "poi-1" })), reference, dependencies, errors), null);
  assert.ok(errors.some((error) => error.field === "via1Kind"));

  for (const [field, overrides] of [
    ["serviceTime", { serviceTime: "12:03" }],
    ["serviceTime", { serviceTime: "08:00" }],
    ["serviceDate", { serviceDate: "2027-02-30" }],
    ["serviceTime", { serviceDate: "2027-03-28", serviceTime: "01:30" }],
    ["extraWaitingMinutes", { extraWaitingMinutes: "7" }],
    ["pickupKind", { pickupAirportId: "unknown-airport" }],
    ["confirmedPoiFeeIds", { confirmedPoiFeeIds: ["fee-unknown"] }]
  ] as const) {
    const fieldErrors: Array<{ field: string; message: string }> = [];
    assert.equal(await validateJourney(readNewBookingDraft(body(overrides)), reference, dependencies, fieldErrors), null, field);
    assert.ok(fieldErrors.some((error) => error.field === field), `${field}: ${JSON.stringify(fieldErrors)}`);
  }
});

test("confirmed POI fees are kept only for POIs selected in the journey", async () => {
  const journey = await validateJourney(readNewBookingDraft(body({
    dropoffKind: "poi", dropoffPoiId: "poi-1", confirmedPoiFeeIds: ["fee-confirm", "fee-elsewhere"]
  })), reference, dependencies, []);
  assert.deepEqual(journey!.pricingInputs.confirmedPoiFeeIds, ["fee-confirm"]);
});

test("browser passenger sync, via ordering and route summary helpers", () => {
  const managerValues = { name: "Manager", phone: "0123" };
  const own = { name: "Pat", phone: "0456" };
  assert.deepEqual(newBookingClient.passengerState(managerValues, own, true), { name: "Manager", phone: "0123", readOnly: true });
  assert.deepEqual(newBookingClient.passengerState({ name: "Renamed", phone: "0999" }, own, true), { name: "Renamed", phone: "0999", readOnly: true });
  assert.deepEqual(newBookingClient.passengerState(managerValues, own, false), { name: "Pat", phone: "0456", readOnly: false });

  assert.equal(newBookingClient.nextViaToAdd({ via1: false, via2: false }), "via1");
  assert.equal(newBookingClient.nextViaToAdd({ via1: true, via2: false }), "via2");
  assert.equal(newBookingClient.nextViaToAdd({ via1: true, via2: true }), null);
  assert.deepEqual(newBookingClient.removeVia({ via1: true, via2: true }, "via1"), { via1: true, via2: false, shiftVia2IntoVia1: true });
  assert.deepEqual(newBookingClient.removeVia({ via1: true, via2: true }, "via2"), { via1: true, via2: false, shiftVia2IntoVia1: false });
  assert.deepEqual(newBookingClient.activeStopKeys({ via1: true, via2: false }), ["pickup", "via1", "dropoff"]);

  assert.deepEqual(newBookingClient.routeSummary({ status: "unresolved", message: "No key" }), { distance: "Unresolved", duration: "Unresolved", charges: "Unresolved", message: "No key" });
  assert.deepEqual(
    newBookingClient.routeSummary({ status: "resolved", distanceMiles: "20.123456", durationSeconds: 4500, tollsReported: true, zones: [{ label: "London ULEZ" }] }),
    { distance: "20.12 miles", duration: "1 h 15 min", charges: "Tolls reported on route; Enters London ULEZ", message: "" }
  );
});

test("browser price breakdown escapes labels, keeps lines separate and shows Total payable last", () => {
  const html = newBookingClient.priceBreakdownHtml({
    status: "complete",
    total: "27.50",
    lines: [
      { type: "ride-fare", label: "Ride fare", status: "applied", amount: "25.00", basis: "12 mi" },
      { type: "location-discount", label: "Location discount", status: "applied", amount: "-2.50", basis: "10%" },
      { type: "poi-fee", label: "POI fee — <b>Hotel</b>", status: "applied", amount: "5.00", basis: "Porter" }
    ]
  });
  assert.equal((html.match(/data-price-line=/g) ?? []).length, 3);
  assert.match(html, /&lt;b&gt;Hotel&lt;\/b&gt;/);
  assert.match(html, /−£2\.50/);
  assert.ok(html.lastIndexOf("data-price-line=") < html.indexOf("Total payable"));
  const incomplete = newBookingClient.priceBreakdownHtml({ status: "incomplete", total: null, lines: [{ type: "parking", label: "Parking", status: "unresolved", amount: null, basis: "" }] });
  assert.match(incomplete, /Not confirmed/);
  assert.match(incomplete, /1 item unresolved/);
});
