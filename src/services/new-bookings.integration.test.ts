import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, type TestDatabaseContext } from "../database/test-helper";
import { airportFeeStore } from "./airport-fees";
import type { BookingRouteProvider } from "./booking-routing";
import { createCustomer } from "./customers";
import { EMPTY_FARE_SETTINGS, fareSettingsStore } from "./fare-settings";
import {
  BookingPriceChangedError,
  createNewBooking,
  getBookingManagerCandidate,
  getNewBooking,
  listBookingManagerCandidates,
  loadPricingReferenceData,
  quoteJourney,
  readNewBookingDraft,
  validateNewBooking
} from "./new-bookings";

let context: TestDatabaseContext | undefined;

before(async () => {
  context = await createTestDatabaseContext("test_new_bookings");
  await context.createAuthTables();
  await initializeDatabase();
});

after(async () => safeCleanupTestDatabase(context));

const actor = { accountId: "dispatcher-1", email: "dispatcher@example.test" };
const now = new Date("2027-03-10T09:00:00Z");
const route: BookingRouteProvider = async () => ({
  status: "resolved", provider: "google-routes", distanceMeters: 16093.44, distanceMiles: "10.000000", durationSeconds: 1500,
  trafficModel: "traffic-aware", path: [], tollsReported: false, zones: [], computedAt: now.toISOString()
});
const dependencies = { now: () => now, verifyPlace: async () => ({ status: "unverified" as const }) };

async function priceFor(customerId: string, airportId: string, extra: Record<string, unknown> = {}) {
  const manager = await getBookingManagerCandidate(customerId);
  assert.ok(manager);
  const draft = readNewBookingDraft({
    customerId, managerName: manager.name, managerPhone: manager.phone, managerEmail: manager.email, passengerIsManager: "yes",
    serviceDate: "2027-03-10", serviceTime: "12:05", pickupKind: "airport", pickupAirportId: airportId,
    dropoffKind: "airport", dropoffAirportId: airportId, adults: "2", xlBaggage: "1", parkingRequired: "no", extraWaitingMinutes: "0", ...extra
  });
  const reference = await loadPricingReferenceData();
  const { errors, booking } = await validateNewBooking(draft, reference, dependencies, getBookingManagerCandidate);
  assert.deepEqual(errors, []);
  assert.ok(booking);
  return { draft, booking, quote: await quoteJourney(booking, reference, route) };
}

test("a new booking persists its stops and itemized price snapshot transactionally and keeps it after settings edits", async () => {
  const customer = await createCustomer({ givenName: "Morgan", surname: "Manager", email: "morgan@example.test", phone: "+44 7911 123456" } as Parameters<typeof createCustomer>[0]);
  assert.ok((await listBookingManagerCandidates()).some((candidate) => candidate.customerId === customer.id));

  await fareSettingsStore.save(0, { ...EMPTY_FARE_SETTINGS, distanceSlabs: [{ startMiles: "0", endMiles: "", ratePerMile: "2.00" }] }, actor);
  const airport = await airportFeeStore.save(null, {
    id: "", displayName: "Test Airport", dropoffPlaceId: "drop-place", dropoffLocationLabel: "Departures", dropoffLatitude: "51.47",
    dropoffLongitude: "-0.45", dropoffFee: "0.00", pickupPlaceId: "pick-place", pickupLocationLabel: "Arrivals", pickupLatitude: "51.471",
    pickupLongitude: "-0.451", pickupFee: "7.00", pickupTimeReference: "ALT", pickupDeferredPolicy: "no", pickupDeferredMinutes: "0",
    pickupFeeCoveredMinutes: "60"
  }, actor);
  assert.ok(airport);

  const { draft, booking, quote } = await priceFor(customer.id, airport.id);
  assert.equal(quote.price.status, "complete");
  assert.equal(quote.price.total, "27.00");

  // An unseen quote is rejected without writing anything.
  const countBookings = async () => Number((await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM customer_bookings")).rows[0].count);
  const beforeCount = await countBookings();
  await assert.rejects(
    createNewBooking(booking, quote, { ...draft, quotedStatus: "complete", quotedTotal: "26.00" }, actor, now),
    BookingPriceChangedError
  );
  assert.equal(await countBookings(), beforeCount);

  const saved = await createNewBooking(booking, quote, { ...draft, quotedStatus: "complete", quotedTotal: "27.00" }, actor, now);
  const second = await createNewBooking(booking, quote, { ...draft, quotedStatus: "complete", quotedTotal: "27.00" }, actor, now);
  assert.notEqual(saved.reference, second.reference, "booking IDs are unique");

  const loaded = await getNewBooking(saved.id);
  assert.ok(loaded?.price);
  assert.equal(loaded.reference, saved.reference);
  assert.equal(loaded.createdAt, now.toISOString());
  assert.equal(loaded.createdByEmail, actor.email);
  assert.equal(loaded.counts.adults, 2);
  assert.equal(loaded.counts.xlBaggage, 1);
  assert.deepEqual(loaded.stops.map((stop) => [stop.stopType, stop.managedId]), [["pickup", airport.id], ["dropoff", airport.id]]);
  const quotedLines = loaded.price.lines.map((line) => [line.type, line.status, line.amount]);
  assert.deepEqual(quotedLines.slice(0, 4), [
    ["ride-fare", "applied", "20.00"],
    ["location-discount", "not-applicable", null],
    ["airport-pickup-fee", "applied", "7.00"],
    ["airport-dropoff-fee", "zero", "0.00"]
  ]);
  assert.equal(loaded.price.total, "27.00");
  assert.equal(loaded.price.fareSettingsVersion, 1);

  // Editing settings changes new quotes but never the stored snapshot.
  await fareSettingsStore.save(1, { ...EMPTY_FARE_SETTINGS, distanceSlabs: [{ startMiles: "0", endMiles: "", ratePerMile: "9.00" }] }, actor);
  await airportFeeStore.save(airport.id, {
    id: airport.id, displayName: "Test Airport", dropoffPlaceId: "drop-place", dropoffLocationLabel: "Departures", dropoffLatitude: "51.47",
    dropoffLongitude: "-0.45", dropoffFee: "3.00", pickupPlaceId: "pick-place", pickupLocationLabel: "Arrivals", pickupLatitude: "51.471",
    pickupLongitude: "-0.451", pickupFee: "11.00", pickupTimeReference: "ALT", pickupDeferredPolicy: "no", pickupDeferredMinutes: "0",
    pickupFeeCoveredMinutes: "60"
  }, actor);
  assert.equal((await priceFor(customer.id, airport.id)).quote.price.total, "104.00");
  const reloaded = await getNewBooking(saved.id);
  assert.deepEqual(reloaded?.price?.lines.map((line) => [line.type, line.status, line.amount]), quotedLines);
  assert.equal(reloaded?.price?.total, "27.00");

  // The snapshot and line items are immutable at the database level.
  await assert.rejects(query("UPDATE booking_price_snapshots SET total_amount = 1 WHERE booking_id = $1", [saved.id]), /immutable/);
  await assert.rejects(query("UPDATE booking_price_line_items SET amount = 1 WHERE line_type = 'ride-fare'"), /immutable/);
});

test("an unresolved price is stored as incomplete without a total only when acknowledged", async () => {
  const customer = await createCustomer({ givenName: "Una", surname: "Resolved", email: "una@example.test", phone: "+44 7911 123457" } as Parameters<typeof createCustomer>[0]);
  const airport = (await airportFeeStore.list())[0];
  const { draft, booking, quote } = await priceFor(customer.id, airport.id, { parkingRequired: "yes" });
  assert.equal(quote.price.status, "incomplete");
  assert.equal(quote.price.total, null);
  const saved = await createNewBooking(booking, quote, { ...draft, quotedStatus: "incomplete", quotedTotal: "", saveWithUnresolvedPrice: true }, actor, now);
  const loaded = await getNewBooking(saved.id);
  assert.equal(loaded?.price?.status, "incomplete");
  assert.equal(loaded?.price?.total, null);
  assert.ok(loaded?.price?.lines.some((line) => line.type === "parking" && line.status === "unresolved" && line.amount === null));
  const row = await query<{ total_fare_amount: string | null; price_status: string }>("SELECT total_fare_amount, price_status FROM customer_bookings WHERE id = $1", [saved.id]);
  assert.deepEqual(row.rows[0], { total_fare_amount: null, price_status: "incomplete" });
});
