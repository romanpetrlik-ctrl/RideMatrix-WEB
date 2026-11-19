import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { createCsrfProtection } from "../middleware/csrf";
import { CSRF_COOKIE_NAME } from "../services/csrf";
import type { SessionAccount } from "../services/api";
import type { AirportFeeRecord } from "../services/airport-fees";
import type { BookingRoute } from "../services/booking-routing";
import { EMPTY_FARE_SETTINGS } from "../services/fare-settings";
import {
  assertQuoteAcknowledged,
  type BookingManagerCandidate,
  type NewBookingDependencies,
  type PricingReferenceData,
  type SavedNewBooking
} from "../services/new-bookings";
import { createBookingsRouter, type BookingsRouterOptions } from "./bookings";

const timestamp = "2026-01-01T00:00:00.000Z";
const airport: AirportFeeRecord = {
  id: "airport-x", displayName: "Airport X", dropoffPlaceId: "d", dropoffLocationLabel: "Departures", dropoffLatitude: 51.47,
  dropoffLongitude: -0.45, dropoffFee: "6.00", pickupPlaceId: "p", pickupLocationLabel: "Arrivals", pickupLatitude: 51.471,
  pickupLongitude: -0.451, pickupFee: "7.00", pickupTimeReference: "ALT", pickupDeferredEnabled: false, pickupDeferredMinutes: null,
  pickupFeeCoveredMinutes: 60, createdAt: timestamp, updatedAt: timestamp
};
const managers: BookingManagerCandidate[] = [
  { customerId: "cust-a", name: "Alex Example", phone: "+44 7700 900001", email: "alex@example.test", company: null, isBusiness: false },
  { customerId: "cust-b", name: "Blair Booker", phone: "+44 7700 900002", email: "blair@example.test", company: "Acme", isBusiness: true }
];

function reference(slabRate = "2.00"): PricingReferenceData {
  return {
    fareSettings: { configuration: { ...EMPTY_FARE_SETTINGS, distanceSlabs: [{ startMiles: "0", endMiles: "", ratePerMile: slabRate }] }, currentVersion: 4, history: [], historyTotal: 0 },
    airports: [airport],
    pois: [],
    poiFees: [],
    operationalBase: null
  };
}

const resolvedRoute: BookingRoute = {
  status: "resolved", provider: "google-routes", distanceMeters: 16093, distanceMiles: "10.000000", durationSeconds: 1500,
  trafficModel: "traffic-aware", path: [{ latitude: 51.471, longitude: -0.451 }, { latitude: 51.5, longitude: -0.12 }],
  tollsReported: false, zones: [], computedAt: timestamp
};

type Saved = Parameters<NonNullable<BookingsRouterOptions["createBooking"]>>;

async function withApp(
  options: { roles?: string[] | null; route?: BookingRoute; reference?: () => PricingReferenceData; csrf?: boolean } = {},
  run: (baseUrl: string, saved: Saved[]) => Promise<void>
) {
  const saved: Saved[] = [];
  const roles = options.roles === undefined ? ["admin"] : options.roles;
  const session: SessionAccount = roles ? { authenticated: true, user: { id: "acct-7", email: "dispatcher@example.test", roles } } : { authenticated: false };
  const dependencies: Partial<NewBookingDependencies> = {
    loadReferenceData: async () => (options.reference ?? (() => reference()))(),
    verifyPlace: async () => ({ status: "unverified" }),
    computeRoute: async () => options.route ?? resolvedRoute,
    now: () => new Date("2027-03-10T09:00:00Z")
  };
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/views"));
  app.use(rateLimit({ windowMs: 60_000, limit: 1_000, standardHeaders: true, legacyHeaders: false }));
  app.use(express.urlencoded({ extended: true }));
  if (options.csrf) app.use(createCsrfProtection({ appTitle: "Test" }));
  app.use(createBookingsRouter({
    appTitle: "Test",
    loadSession: async () => session,
    dependencies,
    listManagers: async () => managers,
    getManager: async (id) => managers.find((manager) => manager.customerId === id) ?? null,
    createBooking: async (...args) => {
      assertQuoteAcknowledged(args[1].price, args[1].fingerprint, args[2]);
      saved.push(args);
      return { id: "booking-uuid", reference: "RMB-000042", customerId: args[0].customerId };
    },
    getBooking: async (id) => id === "booking-uuid" ? savedBooking : null,
    mapConfiguration: () => ({})
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`, saved);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function form(fields: Record<string, string | string[]> = {}) {
  const params = new URLSearchParams();
  const all: Record<string, string | string[]> = {
    customerId: "cust-b", managerName: "Blair Booker", managerPhone: "+44 7700 900002", managerEmail: "blair@example.test",
    passengerIsManager: "yes", serviceDate: "2027-03-10", serviceTime: "14:30",
    pickupKind: "airport", pickupAirportId: "airport-x", dropoffKind: "airport", dropoffAirportId: "airport-x",
    adults: "2", children: "0", xlBaggage: "1", childSeatRequired: "no", boosterRequired: "no", parkingRequired: "no", extraWaitingMinutes: "0",
    ...fields
  };
  for (const [key, value] of Object.entries(all)) for (const entry of [value].flat()) params.append(key, entry);
  return params;
}
const post = (url: string, params: URLSearchParams, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", body: params, redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });
async function quoteFingerprint(baseUrl: string, params = form(), headers: Record<string, string> = {}): Promise<string> {
  const response = await post(`${baseUrl}/bookings/quote`, params, headers);
  assert.equal(response.status, 200);
  return ((await response.json()) as { fingerprint: string }).fingerprint;
}

const savedBooking: SavedNewBooking = {
  id: "booking-uuid", customerId: "cust-b", reference: "RMB-000042", createdAt: "2027-03-10T09:00:00.000Z", createdByEmail: "dispatcher@example.test",
  serviceDate: "2027-03-10", serviceTime: "14:30", serviceTimezone: "Europe/London", status: "Scheduled",
  managerName: "Blair Booker", managerPhone: "+44 7700 900002", managerEmail: "blair@example.test", passengerIsManager: true,
  passengerName: "Blair Booker", passengerPhone: "+44 7700 900002",
  counts: { adults: 2, children: 0, sportsEquipment: 0, xlBaggage: 1, lBaggage: 0, cabinHandBags: 0, backpacks: 0 },
  childSeatRequired: false, boosterRequired: false,
  stops: [],
  price: {
    status: "complete", total: "33.00", fareSettingsVersion: 4, route: resolvedRoute, createdAt: "2027-03-10T09:00:00.000Z", createdByEmail: "dispatcher@example.test",
    lines: [
      { type: "ride-fare", label: "Ride fare", status: "applied", amount: "20.00", basis: "10 mi", source: {} },
      { type: "airport-pickup-fee", label: "Airport pick-up fee — Airport X", status: "applied", amount: "7.00", basis: "", source: {} },
      { type: "airport-dropoff-fee", label: "Airport drop-off fee — Airport X", status: "applied", amount: "6.00", basis: "", source: {} }
    ]
  }
};

test("New Booking is admin-only and keeps unauthenticated users out", async () => {
  await withApp({ roles: null }, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/bookings/new`, { redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/access");
    assert.equal((await post(`${baseUrl}/bookings/quote`, form())).status, 401);
    assert.equal((await post(`${baseUrl}/bookings`, form())).status, 401);
  });
  await withApp({ roles: ["staff", "driver"] }, async (baseUrl, saved) => {
    assert.equal((await fetch(`${baseUrl}/bookings/new`)).status, 403);
    assert.equal((await post(`${baseUrl}/bookings`, form({ quotedStatus: "complete", quotedTotal: "33.00" }))).status, 403);
    assert.equal((await fetch(`${baseUrl}/bookings/booking-uuid`)).status, 403);
    assert.equal(saved.length, 0);
  });
});

test("new booking page shows the assigned-on-save reference, five blocks and existing customers", async () => {
  await withApp({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/bookings/new?customerId=cust-b`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const html = await response.text();
    assert.match(html, /data-booking-id><em>Assigned on save/);
    assert.match(html, /dispatcher@example\.test <em>\(recorded on save\)/);
    for (const heading of ["1. Booking reference", "2. Booking manager and passenger", "3. Journey details and map", "4. Passengers and luggage", "5. Fare and itemized breakdown"]) {
      assert.ok(html.includes(heading), heading);
    }
    assert.match(html, /<option value="cust-b"[^>]*data-manager-name="Blair Booker"[^>]*selected>/);
    assert.match(html, /<option value="cust-a"[^>]*data-manager-email="alex@example\.test"/);
    assert.match(html, /id="managerName"[^>]*value="Blair Booker"/);
    assert.match(html, /id="passengerName"[^>]*value="Blair Booker" readonly/);
    assert.match(html, /<option value="00:00"[^>]*>00:00<\/option>\s*<option value="00:05"/);
    assert.match(html, /<option value="23:55"/);
    assert.doesNotMatch(html, /value="(?:\d\d):(?:\d[1-46-9])"/);
    assert.match(html, /<option value="09:00" selected>09:00<\/option>/, "defaults to now (rounded up to five minutes) in Europe/London");
    for (const field of ["adults", "children", "sportsEquipment", "xlBaggage", "lBaggage", "cabinHandBags", "backpacks"]) {
      const select = new RegExp(`<select id="${field}"[\\s\\S]*?</select>`).exec(html)![0];
      assert.match(select, /<option value="0" selected>0<\/option>/, field);
      assert.equal((select.match(/<option /g) ?? []).length, 8, field);
    }
    assert.match(html, /data-stop="via1"[^>]*hidden/);
    assert.match(html, /data-stop="via2"[^>]*hidden/);
    assert.match(html, /Map unavailable/);
    assert.match(html, /Select pickup, drop-off/);

    const unknown = await (await fetch(`${baseUrl}/bookings/new?customerId=missing`)).text();
    assert.match(unknown, /not an active booking manager/);
  });
});

test("quote returns separately itemized lines, ordered stops and route summary data", async () => {
  await withApp({}, async (baseUrl) => {
    const response = await post(`${baseUrl}/bookings/quote`, form());
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; fingerprint: string; stops: Array<{ type: string }>; route: { status: string; path: number[][]; distanceMiles: string }; price: { status: string; total: string; lines: Array<{ type: string; amount: string | null }> } };
    assert.equal(body.ok, true);
    assert.deepEqual(body.stops.map((stop) => stop.type), ["pickup", "dropoff"]);
    assert.equal(body.route.distanceMiles, "10.000000");
    assert.deepEqual(body.route.path[0], [51.471, -0.451]);
    assert.equal(body.price.status, "complete");
    assert.deepEqual(body.price.lines.filter((line) => line.amount !== null).map((line) => [line.type, line.amount]), [
      ["ride-fare", "20.00"], ["airport-pickup-fee", "7.00"], ["airport-dropoff-fee", "6.00"]
    ]);
    assert.equal(body.price.total, "33.00");
    assert.match(body.fingerprint, /^[a-f0-9]{64}$/);

    const withVias = await (await post(`${baseUrl}/bookings/quote`, form({ via1Active: "yes", via1Kind: "airport", via1AirportId: "airport-x", via2Active: "yes", via2Kind: "address", via2Label: "Typed only" }))).json() as { stops: Array<{ type: string; coordinatesVerified: boolean }>; route: { status: string }; price: { status: string; total: null } };
    assert.deepEqual(withVias.stops.map((stop) => stop.type), ["pickup", "via", "via", "dropoff"]);
    assert.equal(withVias.stops[2].coordinatesVerified, false);
    assert.equal(withVias.route.status, "unresolved");
    assert.equal(withVias.price.status, "incomplete");
    assert.equal(withVias.price.total, null);

    const invalid = await post(`${baseUrl}/bookings/quote`, form({ serviceTime: "14:32" }));
    assert.equal(invalid.status, 422);
  });
});

test("saving records the actor and redirects; a price the dispatcher did not see is never saved", async () => {
  await withApp({}, async (baseUrl, saved) => {
    const unseen = await post(`${baseUrl}/bookings`, form());
    assert.equal(unseen.status, 409);
    const html = await unseen.text();
    assert.match(html, /The price changed/);
    assert.match(html, /name="quotedStatus" value="complete"/);
    assert.match(html, /name="quotedTotal" value="33.00"/);
    assert.match(html, /data-price-line="ride-fare"/);
    assert.equal(saved.length, 0);

    const fingerprint = await quoteFingerprint(baseUrl);
    const stale = await post(`${baseUrl}/bookings`, form({ quotedStatus: "complete", quotedTotal: "30.00", quotedFingerprint: fingerprint }));
    assert.equal(stale.status, 409);
    assert.equal(saved.length, 0);

    const ok = await post(`${baseUrl}/bookings`, form({
      quotedStatus: "complete", quotedTotal: "33.00", quotedFingerprint: fingerprint,
      passengerName: "stale", passengerPhone: "1"
    }));
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get("location"), "/bookings/booking-uuid?notice=created");
    assert.equal(saved.length, 1);
    const [booking, quote, , actor] = saved[0];
    assert.deepEqual(actor, { accountId: "acct-7", email: "dispatcher@example.test" });
    assert.equal(booking.customerId, "cust-b");
    assert.equal(booking.passengerName, "Blair Booker");
    assert.equal(booking.counts.xlBaggage, 1);
    assert.equal(quote.price.total, "33.00");
  });
});

test("an incomplete price saves only with explicit acknowledgement and never with a total", async () => {
  const unresolved: BookingRoute = { status: "unresolved", reason: "routing-not-configured", message: "Routing is not configured." };
  await withApp({ route: unresolved }, async (baseUrl, saved) => {
    const fingerprint = await quoteFingerprint(baseUrl);
    const noAck = await post(`${baseUrl}/bookings`, form({ quotedStatus: "incomplete", quotedFingerprint: fingerprint }));
    assert.equal(noAck.status, 409);
    const html = await noAck.text();
    assert.match(html, /Save with price unresolved/);
    assert.match(html, /Not confirmed/);
    assert.doesNotMatch(html, /data-unresolved-ack hidden/);
    assert.equal(saved.length, 0);

    const ack = await post(`${baseUrl}/bookings`, form({
      quotedStatus: "incomplete", quotedFingerprint: fingerprint, saveWithUnresolvedPrice: "yes"
    }));
    assert.equal(ack.status, 303);
    assert.equal(saved[0][1].price.status, "incomplete");
    assert.equal(saved[0][1].price.total, null);
  });
});

test("server validation re-renders with field errors and does not save", async () => {
  await withApp({}, async (baseUrl, saved) => {
    const response = await post(`${baseUrl}/bookings`, form({ customerId: "", adults: "9", serviceTime: "14:31", quotedStatus: "complete", quotedTotal: "33.00" }));
    assert.equal(response.status, 422);
    const html = await response.text();
    assert.match(html, /href="#customerId"/);
    assert.match(html, /href="#adults"/);
    assert.match(html, /href="#serviceTime"/);
    assert.match(html, /id="adults-error"/);
    assert.equal(saved.length, 0);
  });
});

test("booking detail shows the saved reference, actor and snapshot lines with Total payable last", async () => {
  await withApp({}, async (baseUrl) => {
    const html = await (await fetch(`${baseUrl}/bookings/booking-uuid?notice=created`)).text();
    assert.match(html, /data-booking-id>RMB-000042/);
    assert.match(html, /data-booking-created>2027-03-10 09:00 \(Europe\/London\)/);
    assert.match(html, /data-booking-created-by>dispatcher@example\.test/);
    assert.match(html, /Fare Settings version 4/);
    assert.ok(html.lastIndexOf("data-price-line=") < html.indexOf("Total payable"));
    assert.match(html, /£33\.00/);
    assert.match(html, /\/customers\/cust-b\/bookings\/booking-uuid\/assignment/);
    assert.equal((await fetch(`${baseUrl}/bookings/unknown`)).status, 404);
  });
});

test("booking POSTs are CSRF protected", async () => {
  await withApp({ csrf: true }, async (baseUrl, saved) => {
    const forged = await post(`${baseUrl}/bookings`, form({ quotedStatus: "complete", quotedTotal: "33.00" }));
    assert.equal(forged.status, 403);
    assert.equal((await post(`${baseUrl}/bookings/quote`, form())).status, 403);
    assert.equal(saved.length, 0);

    const page = await fetch(`${baseUrl}/bookings/new`);
    const cookie = page.headers.getSetCookie().find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`))!.split(";")[0];
    const token = /name="_csrf" value="([^"]+)"/.exec(await page.text())![1];
    const headers = { cookie };
    const fingerprint = await quoteFingerprint(baseUrl, form({ _csrf: token }), headers);
    const accepted = await post(
      `${baseUrl}/bookings`,
      form({ _csrf: token, quotedStatus: "complete", quotedTotal: "33.00", quotedFingerprint: fingerprint }),
      headers
    );
    assert.equal(accepted.status, 303);
    assert.equal(saved.length, 1);
  });
});
