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
import type { BookingDashboardRecord, BookingDashboardView, BookingWorkflowStatus } from "../services/booking-dashboard";
import { EMPTY_FARE_SETTINGS } from "../services/fare-settings";
import {
  assertQuoteAcknowledged,
  NEW_CUSTOMER_SELECTION_VALUE,
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
    operationalBase: null,
    roadChargeSchedules: {},
    vehicleClasses: [{ key: "standard_sedan_hatchback", label: "Standard Sedan / Hatchback" }]
  };
}

const resolvedRoute: BookingRoute = {
  status: "resolved", provider: "google-routes", distanceMeters: 16093, distanceMiles: "10.000000", durationSeconds: 1500,
  trafficModel: "traffic-aware", path: [{ latitude: 51.471, longitude: -0.451 }, { latitude: 51.5, longitude: -0.12 }],
  tollsReported: false, zones: [], tunnelCrossings: [], computedAt: timestamp
};

type Saved = Parameters<NonNullable<BookingsRouterOptions["createBooking"]>>;

async function withApp(
  options: {
    roles?: string[] | null;
    route?: BookingRoute;
    reference?: () => PricingReferenceData;
    csrf?: boolean;
    booking?: SavedNewBooking;
    listDashboardBookings?: (view: BookingDashboardView, search: string) => Promise<BookingDashboardRecord[]>;
    archiveBooking?: (input: { bookingId: string; reason: string; actorId: string; actorEmail: string }) => Promise<"archived" | "not-found" | "already-archived">;
    changeBookingStatus?: (input: {
      bookingId: string;
      status: BookingWorkflowStatus;
      reason?: string;
      actorId: string;
      actorEmail: string;
    }) => Promise<"updated" | "unchanged" | "not-found" | "not-changeable">;
  } = {},
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
    getBooking: async (id) => id === "booking-uuid" ? options.booking ?? savedBooking : null,
    listIntegrationAlerts: async () => [],
    resolveIntegrationAlert: async () => true,
    ...(options.listDashboardBookings ? { listDashboardBookings: options.listDashboardBookings } : {}),
    ...(options.archiveBooking ? { archiveBooking: options.archiveBooking } : {}),
    ...(options.changeBookingStatus ? { changeBookingStatus: options.changeBookingStatus } : {}),
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
    vehicleClassKey: "standard_sedan_hatchback", paymentMethod: "payment-link",
    pickupKind: "airport", pickupAirportId: "airport-x", dropoffKind: "airport", dropoffAirportId: "airport-x",
    adults: "2", children: "0", xlBaggage: "1", childSeatRequired: "no", boosterRequired: "no",
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
  vehicleClassKey: "standard_sedan_hatchback", vehicleClassLabel: "Standard Sedan / Hatchback", paymentMethod: "payment-link",
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
    assert.match(html, new RegExp(`<option value="${NEW_CUSTOMER_SELECTION_VALUE}" data-create-new-customer[^>]*>Create new customer</option>`));
    assert.doesNotMatch(html, /type="radio" name="customerMode"/);
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

test("booking rows expand to expose assignment, status, cancellation, and archive controls", async () => {
  const listed: Array<[BookingDashboardView, string]> = [];
  const row: BookingDashboardRecord = {
    id: "booking-uuid",
    customerId: "cust-b",
    reference: "RMB-000042",
    serviceDate: "2026-03-10",
    serviceTime: "14:30",
    customerName: "Blair Booker",
    pickup: "Airport X",
    dropoff: "1 High Street",
    status: "New",
    assignmentStatus: "assigned",
    driverId: "driver-7",
    driverName: "Casey Driver",
    vehicleRegistration: "AB12 CDE",
    isTestBooking: true,
    canMarkNoShow: true
  };
  await withApp({
    listDashboardBookings: async (view, search) => {
      listed.push([view, search]);
      return [row];
    }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/bookings?view=upcoming&search=RMB-000042`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.deepEqual(listed, [["upcoming", "RMB-000042"]]);
    assert.match(html, /Upcoming bookings/);
    assert.match(html, /context-bar__action--primary/);
    assert.match(html, /href="\/bookings\/new"/);
    assert.match(html, />New booking<\/a>/);
    assert.doesNotMatch(html, /booking-dashboard__results-heading[\s\S]*New booking/);
    assert.match(html, /RMB-000042/);
    assert.match(html, /Blair Booker/);
    assert.match(html, /New/);
    assert.match(html, /TEST/);
    assert.match(html, /Casey Driver · AB12 CDE/);
    assert.match(html, />All<\/a>/);
    assert.match(html, />Finished<\/a>/);
    assert.match(html, />Cancelled<\/a>/);
    assert.match(html, />Archived<\/a>/);
    assert.match(html, />No show<\/a>/);
    assert.match(html, /Cancelled means the customer cancelled the booking/);
    assert.match(html, /archiving is not permanent deletion/);
    assert.match(html, />Driver<\/a>/);
    assert.match(html, /Remove driver/);
    assert.match(html, /<details class="booking-dashboard__details">/);
    assert.match(html, /<summary class="booking-dashboard__summary"/);
    assert.match(html, />Accept<\/button>/);
    assert.match(html, /name="status" value="Cancelled"/);
    assert.match(html, /name="status" value="No Show"/);
    assert.match(html, />No show<\/button>/);
    assert.match(html, /placeholder="Cancellation reason"/);
    assert.match(html, /placeholder="Archive reason"/);
    assert.doesNotMatch(html, /booking-dashboard__action-label|booking-dashboard__expanded-heading/);
    const expandedStart = html.indexOf('class="booking-dashboard__expanded"');
    const expandedEnd = html.indexOf("</details>", expandedStart);
    assert.ok(expandedStart >= 0 && expandedEnd > expandedStart);
    assert.doesNotMatch(html.slice(expandedStart, expandedEnd), /<strong>RMB-000042<\/strong>/);
    assert.match(html, />Details<\/a>/);
    assert.match(html, /name="reason" type="text" maxlength="500" placeholder="[^"]+" required/);
    assert.doesNotMatch(html, />Actions<\/summary>/);
    const summary = html.match(/<summary[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? "";
    assert.ok(summary);
    const summaryContent = summary.replace(/^<summary[^>]*>/, "");
    assert.equal((summaryContent.match(/class="booking-dashboard__/g) ?? []).length, 6);
    assert.doesNotMatch(summary, /<a /);
    assert.match(html, /<\/details>\s*<\/td>\s*<\/tr>/);
    assert.doesNotMatch(html, /name="customerMode"/);
  });
});

test("booking board accepts each supported filter and preserves the selected view", async () => {
  const requestedViews: BookingDashboardView[] = [];
  await withApp({
    listDashboardBookings: async (view) => {
      requestedViews.push(view);
      return [];
    }
  }, async (baseUrl) => {
    const views: Array<[BookingDashboardView, string]> = [
      ["today", "Today&#39;s bookings"],
      ["upcoming", "Upcoming bookings"],
      ["all", "All bookings"],
      ["finished", "Finished bookings"],
      ["cancelled", "Cancelled bookings"],
      ["archived", "Archived bookings"],
      ["no-show", "No-show bookings"]
    ];
    for (const [view, heading] of views) {
      const response = await fetch(`${baseUrl}/bookings?view=${view}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(heading));
    }
    assert.deepEqual(requestedViews, views.map(([view]) => view));
  });
});

test("archived bookings are shown as retained history without operational actions", async () => {
  const archived: BookingDashboardRecord = {
    id: "booking-archived",
    customerId: "cust-b",
    reference: "RMB-000043",
    serviceDate: "2026-03-10",
    serviceTime: "14:30",
    customerName: "Blair Booker",
    pickup: "Airport X",
    dropoff: "1 High Street",
    status: "Cancelled",
    assignmentStatus: "unassigned",
    driverId: null,
    driverName: null,
    vehicleRegistration: null,
    isTestBooking: false,
    archivedAt: "2026-03-11T09:00:00.000Z",
    archiveReason: "Duplicate booking"
  };
  await withApp({
    listDashboardBookings: async () => [archived]
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/bookings?view=archived`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Previously: Cancelled/);
    assert.match(html, /Archived booking — retained for records, not permanently deleted\. Reason: Duplicate booking/);
    assert.doesNotMatch(html, />Driver<\/a>|No show<\/button>|>Archive<\/button>/);
  });
});

test("booking archive requires CSRF and a reason, then redirects to the selected dashboard view", async () => {
  let archivedInput: { bookingId: string; reason: string; actorId: string; actorEmail: string } | undefined;
  await withApp({
    csrf: true,
    listDashboardBookings: async () => [],
    archiveBooking: async (input) => {
      archivedInput = input;
      return "archived";
    }
  }, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/bookings?view=today`);
    const html = await page.text();
    const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
    const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    assert.ok(token);
    assert.ok(cookie);

    const params = new URLSearchParams({
      _csrf: token,
      view: "upcoming",
      search: "RMB-000042",
      reason: "Duplicate booking created during testing"
    });
    const response = await fetch(`${baseUrl}/bookings/booking-uuid/archive`, {
      method: "POST",
      body: params,
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" }
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/bookings?view=upcoming&search=RMB-000042&notice=archived");
    assert.deepEqual(archivedInput, {
      bookingId: "booking-uuid",
      reason: "Duplicate booking created during testing",
      actorId: "acct-7",
      actorEmail: "dispatcher@example.test"
    });

    const missingReason = await fetch(`${baseUrl}/bookings/booking-uuid/archive`, {
      method: "POST",
      body: new URLSearchParams({ _csrf: token, view: "today", reason: "" }),
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" }
    });
    assert.equal(missingReason.headers.get("location"), "/bookings?view=today&error=archive-reason-required");
  });
});

test("booking status changes require CSRF and cancellation reason, then preserve dashboard filters", async () => {
  const changed: Array<{
    bookingId: string;
    status: BookingWorkflowStatus;
    reason?: string;
    actorId: string;
    actorEmail: string;
  }> = [];
  await withApp({
    csrf: true,
    listDashboardBookings: async () => [],
    changeBookingStatus: async (input) => {
      changed.push(input);
      return "updated";
    }
  }, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/bookings?view=upcoming`);
    const html = await page.text();
    const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
    const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    assert.ok(token);
    assert.ok(cookie);

    const withoutCsrf = await post(`${baseUrl}/bookings/booking-uuid/status`, new URLSearchParams({
      status: "Accepted"
    }));
    assert.equal(withoutCsrf.status, 403);

    const missingReason = await post(`${baseUrl}/bookings/booking-uuid/status`, new URLSearchParams({
      _csrf: token, status: "Cancelled", view: "upcoming"
    }), { cookie });
    assert.equal(missingReason.status, 303);
    assert.equal(missingReason.headers.get("location"), "/bookings?view=upcoming&error=cancel-reason-required");
    assert.equal(changed.length, 0);

    const tooLongReason = await post(`${baseUrl}/bookings/booking-uuid/status`, new URLSearchParams({
      _csrf: token, status: "Cancelled", reason: "x".repeat(501), view: "upcoming"
    }), { cookie });
    assert.equal(tooLongReason.status, 303);
    assert.equal(tooLongReason.headers.get("location"), "/bookings?view=upcoming&error=cancel-reason-too-long");
    assert.equal(changed.length, 0);

    const accepted = await post(`${baseUrl}/bookings/booking-uuid/status`, new URLSearchParams({
      _csrf: token, status: "Accepted", view: "upcoming", search: "RMB-000042"
    }), { cookie });
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get("location"), "/bookings?view=upcoming&search=RMB-000042&notice=status-updated");

    const cancelled = await post(`${baseUrl}/bookings/booking-uuid/status`, new URLSearchParams({
      _csrf: token, status: "Cancelled", reason: "Customer requested cancellation", view: "upcoming"
    }), { cookie });
    assert.equal(cancelled.status, 303);
    const noShow = await post(`${baseUrl}/bookings/booking-uuid/status`, new URLSearchParams({
      _csrf: token, status: "No Show", view: "upcoming"
    }), { cookie });
    assert.equal(noShow.status, 303);
    assert.deepEqual(changed, [
      {
        bookingId: "booking-uuid",
        status: "Accepted",
        reason: "",
        actorId: "acct-7",
        actorEmail: "dispatcher@example.test"
      },
      {
        bookingId: "booking-uuid",
        status: "Cancelled",
        reason: "Customer requested cancellation",
        actorId: "acct-7",
        actorEmail: "dispatcher@example.test"
      },
      {
        bookingId: "booking-uuid",
        status: "No Show",
        reason: "",
        actorId: "acct-7",
        actorEmail: "dispatcher@example.test"
      }
    ]);
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
    assert.equal(body.price.status, "complete", "the selected standard car and verified route data produce a complete quote");
    assert.deepEqual(body.price.lines.filter((line) => line.amount !== null && line.type !== "road-charge").map((line) => [line.type, line.amount]), [
      ["ride-fare", "20.00"], ["airport-pickup-fee", "7.00"], ["airport-dropoff-fee", "6.00"]
    ]);
    assert.ok(body.price.lines.some((line) => line.type === "road-charge" && line.amount === "0.00"), "the default ULEZ-compliant car shows an explicit £0 ULEZ line");
    assert.equal(body.price.total, "33.00");
    assert.match(body.fingerprint, /^[a-f0-9]{64}$/);

    const newCustomerQuote = await post(`${baseUrl}/bookings/quote`, form({
      customerId: NEW_CUSTOMER_SELECTION_VALUE,
      newCustomerGivenName: "Taylor",
      newCustomerSurname: "Passenger",
      newCustomerPhone: "+44 7700 900123",
      newCustomerEmail: "taylor@example.test"
    }));
    assert.equal(newCustomerQuote.status, 200, "the customer dropdown selection derives new-customer mode on the server");

    const withVias = await (await post(`${baseUrl}/bookings/quote`, form({ via1Active: "yes", via1Kind: "airport", via1AirportId: "airport-x", via2Active: "yes", via2Kind: "address", via2Label: "Typed only", via2HouseNameNumber: "2" }))).json() as { stops: Array<{ type: string; coordinatesVerified: boolean }>; route: { status: string }; price: { status: string; total: null } };
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
    assert.equal(quote.price.status, "complete");
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

function customerQuoteSection(html: string): string {
  const start = html.indexOf('aria-labelledby="detail-customer-quote-title"');
  assert.ok(start > 0, "customer quote preview section is rendered");
  return html.slice(start, html.indexOf("</section>", start));
}

const detailedSnapshotBooking: SavedNewBooking = {
  ...savedBooking,
  price: {
    ...savedBooking.price!,
    total: "32.50",
    lines: [
      { type: "ride-fare", label: "Ride fare", status: "applied", amount: "25.00", basis: "12.50 mi on standard Distance Slabs = £25.00.", source: { fareSettingsVersion: 4 } },
      { type: "location-discount", label: "Location discount: BH internal radius rule", status: "applied", amount: "-2.50", basis: "Operational-base radius discount (10%)", source: { ruleId: "disc-rule-uuid" } },
      { type: "airport-pickup-fee", label: "Airport pick-up fee — Airport X", status: "applied", amount: "10.00", basis: "Airport Fees record pick-up fee.", source: { airportId: "airport-x" } },
      { type: "airport-dropoff-fee", label: "Airport drop-off fee", status: "not-applicable", amount: null, basis: "The drop-off is not a managed airport.", source: {} },
      { type: "poi-fee", label: "POI fee — Stadium: drop-off", status: "zero", amount: "0.00", basis: "Configured POI fee", source: { poiFeeId: "poi-fee-uuid" } },
      { type: "toll", label: "Toll charges", status: "not-applicable", amount: null, basis: "No tolls reported on this route.", source: {} },
      { type: "dead-mileage", label: "Dead mileage", status: "not-applicable", amount: null, basis: "Recorded on assignment.", source: {} }
    ]
  }
};

test("booking detail adds a customer-safe quote preview from the saved snapshot alongside the staff breakdown", async () => {
  await withApp({ booking: detailedSnapshotBooking }, async (baseUrl) => {
    const html = await (await fetch(`${baseUrl}/bookings/booking-uuid`)).text();
    // The full diagnostic breakdown remains for authorized staff.
    assert.match(html, /data-price-line-status="not-applicable"/);
    assert.match(html, /12\.50 mi on standard Distance Slabs/);
    assert.match(html, /Fare Settings version 4/);

    const preview = customerQuoteSection(html);
    assert.match(preview, /Preview only — this has not been sent to the customer/);
    assert.doesNotMatch(preview, /<form|<button|type="submit"/);
    assert.match(preview, /data-customer-quote-status="confirmed"/);
    const rows = [...preview.matchAll(/<tr data-customer-quote-line>\s*<th scope="row">([^<]+)<\/th>\s*<td[^>]*>([^<]+)<\/td>/g)].map((match) => [match[1], match[2]]);
    assert.deepEqual(rows, [
      ["Ride fare", "£25.00"],
      ["Location discount", "−£2.50"],
      ["Airport pick-up fee — Airport X", "£10.00"],
      ["Location fee — Stadium: drop-off", "£0.00"]
    ]);
    assert.match(preview, /Total payable<\/th>\s*<td class="booking-price__amount"><strong>£32\.50<\/strong>/);
    for (const hidden of [/Not applicable/, /Unresolved/i, /Applied/, /Configured £0\.00/, /Distance Slabs/, /radius/i, /disc-rule-uuid|poi-fee-uuid|airport-x/, /version 4/i, /Parking|Dead mileage|Toll/]) {
      assert.doesNotMatch(preview.replace(/<p class="form-hint">[\s\S]*?<\/p>/, ""), hidden);
    }
  });
});

test("customer quote preview for an incomplete snapshot shows no payable total and is marked not confirmed", async () => {
  const incomplete: SavedNewBooking = {
    ...detailedSnapshotBooking,
    price: {
      ...detailedSnapshotBooking.price!,
      status: "incomplete",
      total: null,
      lines: [
        ...detailedSnapshotBooking.price!.lines,
        { type: "road-charge", label: "Road charge — London ULEZ", status: "unresolved", amount: null, basis: "Draft London fee schedules.", source: { zone: "ulez" } }
      ]
    }
  };
  await withApp({ booking: incomplete }, async (baseUrl) => {
    const preview = customerQuoteSection(await (await fetch(`${baseUrl}/bookings/booking-uuid`)).text());
    assert.match(preview, /data-customer-quote-status="not-confirmed"/);
    assert.match(preview, /Quote not yet confirmed/);
    assert.match(preview, /must not be sent/);
    assert.match(preview, /Not yet confirmed<\/strong>/);
    assert.doesNotMatch(preview, /Total payable/);
    assert.doesNotMatch(preview, /£32\.50/);
    assert.doesNotMatch(preview, /Unresolved|Draft London|ulez/i);
    assert.doesNotMatch(preview, /<form|<button/);
  });
});

test("customer quote preview renders the historical snapshot unchanged after fare settings change", async () => {
  let referenceLoads = 0;
  const changedSettings = () => {
    referenceLoads += 1;
    return reference("9.99");
  };
  await withApp({ booking: detailedSnapshotBooking, reference: changedSettings }, async (baseUrl) => {
    const preview = customerQuoteSection(await (await fetch(`${baseUrl}/bookings/booking-uuid`)).text());
    assert.match(preview, /Ride fare<\/th>\s*<td class="booking-price__amount">£25\.00/);
    assert.match(preview, /<strong>£32\.50<\/strong>/);
    assert.equal(referenceLoads, 0);
  });
});

test("customer quote preview and diagnostic breakdown are unavailable to non-admin staff and signed-out users", async () => {
  await withApp({ roles: ["staff", "driver"], booking: detailedSnapshotBooking }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/bookings/booking-uuid`);
    assert.equal(response.status, 403);
    const html = await response.text();
    assert.doesNotMatch(html, /data-customer-quote|data-price-line|£32\.50/);
  });
  await withApp({ roles: null, booking: detailedSnapshotBooking }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/bookings/booking-uuid`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
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
    const quoteResponse = await post(`${baseUrl}/bookings/quote`, form({ _csrf: token }), headers);
    assert.equal(quoteResponse.status, 200);
    const quote = await quoteResponse.json() as { fingerprint: string; price: { status: string; total: string | null } };
    const accepted = await post(
      `${baseUrl}/bookings`,
      form({ _csrf: token, quotedStatus: quote.price.status, quotedTotal: quote.price.total ?? "", quotedFingerprint: quote.fingerprint }),
      headers
    );
    assert.equal(accepted.status, 303);
    assert.equal(saved.length, 1);
  });
});
