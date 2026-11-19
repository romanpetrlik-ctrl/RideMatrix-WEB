import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, type TestDatabaseContext } from "../database/test-helper";
import { airportFeeStore } from "./airport-fees";
import { detectRoadChargeZones, type BookingRouteProvider } from "./booking-routing";
import { anonymizeCustomer, createCustomer, purgeCustomer } from "./customers";
import { EMPTY_FARE_SETTINGS, fareSettingsStore } from "./fare-settings";
import { londonFeeScheduleStore } from "./london-fee-schedules";
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
import { roadChargeScheduleSeeds } from "./road-charge-schedules";

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
  trafficModel: "traffic-aware", path: [], tollsReported: false, zones: [], tunnelCrossings: [], computedAt: now.toISOString()
});
const dependencies = { now: () => now, verifyPlace: async () => ({ status: "unverified" as const }) };

async function priceFor(customerId: string, airportId: string, extra: Record<string, unknown> = {}) {
  const manager = await getBookingManagerCandidate(customerId);
  assert.ok(manager);
  const draft = readNewBookingDraft({
    customerId, managerName: manager.name, managerPhone: manager.phone, managerEmail: manager.email, passengerIsManager: "yes",
    serviceDate: "2027-03-10", serviceTime: "12:05", pickupKind: "airport", pickupAirportId: airportId,
    dropoffKind: "airport", dropoffAirportId: airportId, adults: "2", xlBaggage: "1", ...extra
  });
  const reference = await loadPricingReferenceData();
  const { errors, booking } = await validateNewBooking(draft, reference, dependencies, getBookingManagerCandidate);
  assert.deepEqual(errors, []);
  assert.ok(booking);
  return { draft, booking, reference, quote: await quoteJourney(booking, reference, route) };
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

  const { draft, booking, reference, quote } = await priceFor(customer.id, airport.id);
  assert.equal(quote.price.status, "complete");
  assert.equal(quote.price.total, "27.00");

  // An unseen quote is rejected without writing anything.
  const countBookings = async () => Number((await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM customer_bookings")).rows[0].count);
  const beforeCount = await countBookings();
  await assert.rejects(
    createNewBooking(booking, quote, {
      ...draft, quotedStatus: "complete", quotedTotal: "26.00", quotedFingerprint: quote.fingerprint
    }, actor, now),
    BookingPriceChangedError
  );
  assert.equal(await countBookings(), beforeCount);

  const changedReference = {
    ...reference,
    fareSettings: {
      ...reference.fareSettings,
      currentVersion: reference.fareSettings.currentVersion + 1,
      configuration: {
        ...reference.fareSettings.configuration,
        distanceSlabs: [{ startMiles: "0", endMiles: "", ratePerMile: "2.10" }]
      }
    },
    airports: reference.airports.map((record) => ({ ...record, pickupFee: "6.00" }))
  };
  const changedQuote = await quoteJourney(booking, changedReference, route);
  assert.equal(changedQuote.price.status, quote.price.status);
  assert.equal(changedQuote.price.total, quote.price.total, "line-item changes cancel out in the total");
  assert.notEqual(changedQuote.fingerprint, quote.fingerprint);
  await assert.rejects(
    createNewBooking(booking, changedQuote, {
      ...draft, quotedStatus: "complete", quotedTotal: "27.00", quotedFingerprint: quote.fingerprint
    }, actor, now),
    BookingPriceChangedError
  );

  const acknowledgedDraft = {
    ...draft, quotedStatus: "complete", quotedTotal: "27.00", quotedFingerprint: quote.fingerprint
  };
  const saved = await createNewBooking(booking, quote, acknowledgedDraft, actor, now);
  const second = await createNewBooking(booking, quote, acknowledgedDraft, actor, now);
  assert.notEqual(saved.reference, second.reference, "booking IDs are unique");
  const customerBookingAt = await query<{ last_booking_at: string }>("SELECT last_booking_at FROM customers WHERE id = $1", [customer.id]);
  assert.equal(customerBookingAt.rows[0].last_booking_at, "2027-03-10T12:05:00.000Z");

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
  await assert.rejects(query("DELETE FROM booking_price_line_items WHERE snapshot_id = (SELECT id FROM booking_price_snapshots WHERE booking_id = $1)", [saved.id]), /authorized retention cleanup/);
  await assert.rejects(query("DELETE FROM booking_price_snapshots WHERE booking_id = $1", [saved.id]), /authorized retention cleanup/);
});

test("an unresolved price is stored as incomplete without a total only when acknowledged", async () => {
  const customer = await createCustomer({ givenName: "Una", surname: "Resolved", email: "una@example.test", phone: "+44 7911 123457" } as Parameters<typeof createCustomer>[0]);
  const airport = (await airportFeeStore.list())[0];
  const { draft, booking, reference } = await priceFor(customer.id, airport.id);
  const quote = await quoteJourney(booking, reference, async () => ({ status: "unresolved", reason: "provider-error", message: "Routing temporarily unavailable." }));
  assert.equal(quote.price.status, "incomplete");
  assert.equal(quote.price.total, null);
  const unresolvedRouteQuote = await quoteJourney(booking, {
    ...reference,
    airports: reference.airports.map((record) => ({ ...record, pickupFee: "8.00" }))
  }, async () => ({ status: "unresolved", reason: "provider-error", message: "Routing temporarily unavailable." }));
  assert.equal(unresolvedRouteQuote.price.status, "incomplete");
  assert.equal(unresolvedRouteQuote.price.total, null);
  assert.notEqual(unresolvedRouteQuote.fingerprint, quote.fingerprint);
  await assert.rejects(
    createNewBooking(booking, unresolvedRouteQuote, {
      ...draft, quotedStatus: "incomplete", quotedTotal: "", quotedFingerprint: quote.fingerprint, saveWithUnresolvedPrice: true
    }, actor, now),
    BookingPriceChangedError
  );
  const saved = await createNewBooking(booking, quote, {
    ...draft, quotedStatus: "incomplete", quotedTotal: "", quotedFingerprint: quote.fingerprint, saveWithUnresolvedPrice: true
  }, actor, now);
  const loaded = await getNewBooking(saved.id);
  assert.equal(loaded?.price?.status, "incomplete");
  assert.equal(loaded?.price?.total, null);
  assert.ok(loaded?.price?.lines.some((line) => line.type === "ride-fare" && line.status === "unresolved" && line.amount === null));
  const row = await query<{ total_fare_amount: string | null; price_status: string }>("SELECT total_fare_amount, price_status FROM customer_bookings WHERE id = $1", [saved.id]);
  assert.deepEqual(row.rows[0], { total_fare_amount: null, price_status: "incomplete" });
});

test("customer anonymization redacts the new booking copies and removes its immutable price snapshot", async () => {
  const customer = await createCustomer({ givenName: "Casey", surname: "Passenger", email: "casey.passenger@example.test", phone: "+44 7911 123458" } as Parameters<typeof createCustomer>[0]);
  const airport = (await airportFeeStore.list())[0];
  const { draft, booking, quote } = await priceFor(customer.id, airport.id);
  const saved = await createNewBooking(booking, quote, {
    ...draft, quotedStatus: quote.price.status, quotedTotal: quote.price.total ?? "", quotedFingerprint: quote.fingerprint
  }, actor, now);
  await query("UPDATE customers SET purge_after = '2020-01-01T00:00:00.000Z' WHERE id = $1", [customer.id]);

  assert.equal(await anonymizeCustomer(customer.id), true);
  const anonymized = await getNewBooking(saved.id);
  assert.ok(anonymized);
  assert.equal(anonymized.managerName, "Anonymized Customer");
  assert.equal(anonymized.managerPhone, null);
  assert.equal(anonymized.managerEmail, null);
  assert.equal(anonymized.passengerName, "Anonymized Customer");
  assert.equal(anonymized.passengerPhone, null);
  assert.ok(anonymized.stops.every((stop) =>
    stop.label === "[anonymized]" && stop.latitude === null && stop.longitude === null && stop.postcode === null
      && stop.placeId === null && stop.managedId === null && !stop.coordinatesVerified
  ));
  assert.equal(anonymized.price, null);
  assert.equal((await query(
    `SELECT snapshot_id FROM booking_price_line_items
     WHERE snapshot_id IN (SELECT id FROM booking_price_snapshots WHERE booking_id = $1)`,
    [saved.id]
  )).rowCount, 0);
});

test("authorized retention purge can remove bookings and their snapshots", async () => {
  const customer = await createCustomer({ givenName: "Riley", surname: "Purger", email: "riley.purger@example.test", phone: "+44 7911 123459" } as Parameters<typeof createCustomer>[0]);
  const airport = (await airportFeeStore.list())[0];
  const { draft, booking, quote } = await priceFor(customer.id, airport.id);
  const saved = await createNewBooking(booking, quote, {
    ...draft, quotedStatus: quote.price.status, quotedTotal: quote.price.total ?? "", quotedFingerprint: quote.fingerprint
  }, actor, now);
  await query("UPDATE customers SET purge_after = '2020-01-01T00:00:00.000Z' WHERE id = $1", [customer.id]);

  assert.equal(await purgeCustomer(customer.id), true);
  assert.equal((await query("SELECT id FROM customer_bookings WHERE id = $1", [saved.id])).rowCount, 0);
  assert.equal((await query("SELECT id FROM booking_price_snapshots WHERE booking_id = $1", [saved.id])).rowCount, 0);
});

test("road charges are quoted from the active schedule and the saved snapshot keeps them after schedule edits", async () => {
  const customer = await createCustomer({ givenName: "Riley", surname: "Road", email: "riley@example.test", phone: "+44 7911 123457" } as Parameters<typeof createCustomer>[0]);
  const fare = await fareSettingsStore.load();
  await fareSettingsStore.save(fare.currentVersion, { ...EMPTY_FARE_SETTINGS, distanceSlabs: [{ startMiles: "0", endMiles: "", ratePerMile: "2.00" }] }, actor);
  const airport = await airportFeeStore.save(null, {
    id: "", displayName: "Road Charge Airport", dropoffPlaceId: "rc-drop", dropoffLocationLabel: "Departures", dropoffLatitude: "51.47",
    dropoffLongitude: "-0.45", dropoffFee: "0.00", pickupPlaceId: "rc-pick", pickupLocationLabel: "Arrivals", pickupLatitude: "51.471",
    pickupLongitude: "-0.451", pickupFee: "0.00", pickupTimeReference: "ALT", pickupDeferredPolicy: "no", pickupDeferredMinutes: "0",
    pickupFeeCoveredMinutes: "60"
  }, actor);
  assert.ok(airport);

  // A real route segment across the LEZ boundary (outer west London), detected by polygon intersection.
  const lezRoute: BookingRouteProvider = async () => {
    const path = [{ latitude: 51.47, longitude: -0.6 }, { latitude: 51.47, longitude: -0.44 }];
    return {
      status: "resolved", provider: "google-routes", distanceMeters: 16093.44, distanceMiles: "10.000000", durationSeconds: 1500,
      trafficModel: "traffic-aware", path, tollsReported: false, zones: detectRoadChargeZones(path).filter((zone) => zone.zone === "london-lez"),
      tunnelCrossings: [], computedAt: now.toISOString()
    };
  };
  const quoteWith = async () => {
    const manager = await getBookingManagerCandidate(customer.id);
    assert.ok(manager);
    const draft = readNewBookingDraft({
      customerId: customer.id, managerName: manager.name, managerPhone: manager.phone, managerEmail: manager.email, passengerIsManager: "yes",
      serviceDate: "2027-03-10", serviceTime: "12:05", pickupKind: "airport", pickupAirportId: airport.id,
      dropoffKind: "airport", dropoffAirportId: airport.id, adults: "1"
    });
    const reference = await loadPricingReferenceData();
    const { errors, booking } = await validateNewBooking(draft, reference, dependencies, getBookingManagerCandidate);
    assert.deepEqual(errors, []);
    assert.ok(booking);
    return { draft, booking, quote: await quoteJourney(booking, reference, lezRoute) };
  };
  const lezLine = (lines: Array<{ type: string; status: string; amount: string | null; label: string }>) => lines.filter((line) => line.type === "road-charge");

  // No vehicle is assigned at quote time, so zone charges stay unresolved while the schedule is inactive or active.
  const inactive = await quoteWith();
  assert.deepEqual(lezLine(inactive.quote.price.lines).map((line) => line.status), ["unresolved"]);
  assert.equal(inactive.quote.price.total, null);

  const lez = await londonFeeScheduleStore.load("london-lez");
  await londonFeeScheduleStore.setActivation("london-lez", lez.currentVersion, { action: "enable", verifiedOn: "2026-11-19", sourcesConfirmed: true }, actor, new Date("2026-11-20T00:00:00Z"));
  const enabledVersion = lez.currentVersion + 1;

  const { draft, booking, quote } = await quoteWith();
  assert.deepEqual(lezLine(quote.price.lines).map((line) => [line.status, line.amount]), [["unresolved", null]]);
  assert.equal(quote.price.status, "incomplete");
  assert.equal(quote.price.total, null);
  const saved = await createNewBooking(booking, quote, { ...draft, quotedStatus: "incomplete", quotedTotal: "", quotedFingerprint: quote.fingerprint, saveWithUnresolvedPrice: true }, actor, now);

  // Editing the schedule (and re-enabling it) changes new quotes but never the saved snapshot.
  const amounts = Object.fromEntries(roadChargeScheduleSeeds["london-lez"].rates.map((rate) => [rate.key, rate.amount]));
  await londonFeeScheduleStore.save("london-lez", enabledVersion, { ...amounts, "lez-vans-specialist-minibuses": "150.00" }, actor, { effectiveFrom: "2021-03-01", effectiveUntil: null });
  await londonFeeScheduleStore.setActivation("london-lez", enabledVersion + 1, { action: "enable", verifiedOn: "2026-11-19", sourcesConfirmed: true }, actor, new Date("2026-11-20T00:00:00Z"));
  assert.deepEqual(lezLine((await quoteWith()).quote.price.lines).map((line) => line.status), ["unresolved"]);

  const reloaded = await getNewBooking(saved.id);
  assert.deepEqual(lezLine(reloaded!.price!.lines).map((line) => [line.status, line.amount]), [["unresolved", null]]);
  assert.equal(reloaded?.price?.total, null);
  const stored = await query<{ calculation: Record<string, any> }>(
    `SELECT s.calculation FROM booking_price_snapshots s WHERE s.booking_id = $1`,
    [saved.id]
  );
  assert.equal(stored.rows[0].calculation.roadChargeSchedules["london-lez"].version, enabledVersion);
  await londonFeeScheduleStore.setActivation("london-lez", enabledVersion + 2, { action: "disable" }, actor, new Date("2026-11-20T00:00:00Z"));
});
