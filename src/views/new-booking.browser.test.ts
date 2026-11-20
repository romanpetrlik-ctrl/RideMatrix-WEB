import assert from "node:assert/strict";
import ejs from "ejs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { BOOKING_COUNT_FIELDS, BOOKING_COUNT_MAX, cargoSummary, serviceTimeOptions } from "../services/new-bookings";

const ORIGIN = "http://booking.test";

async function renderNewBooking(): Promise<string> {
  const emptyStop = { kind: "", managedId: "", placeId: "", label: "", houseNameNumber: "" };
  return ejs.renderFile(path.join(process.cwd(), "src/views/pages/bookings/new.ejs"), {
    title: "New Booking",
    appTitle: "RideMatrix Test",
    email: "dispatcher@example.test",
    draft: {
      customerMode: "existing",
      customerId: "", managerName: "", managerPhone: "", managerEmail: "", passengerIsManager: true, passengerName: "", passengerPhone: "",
      serviceDate: "2027-03-10", serviceTime: "14:30",
      vehicleClassKey: "standard_sedan_hatchback", paymentMethod: "card-online",
      newCustomerGivenName: "", newCustomerSurname: "", newCustomerPhone: "", newCustomerEmail: "",
      stops: { pickup: { ...emptyStop }, via1: { ...emptyStop }, via2: { ...emptyStop }, dropoff: { ...emptyStop } },
      viaActive: { via1: false, via2: false },
      counts: Object.fromEntries(BOOKING_COUNT_FIELDS.map(([field]) => [field, "0"])),
      childSeatRequired: "no", boosterRequired: "no",
      confirmedPoiFeeIds: [], saveWithUnresolvedPrice: false, quotedTotal: "", quotedStatus: "", quotedFingerprint: ""
    },
    errors: [],
    formError: "",
    managers: [
      { customerId: "cust-a", name: "Alex Example", phone: "+44 7700 900001", email: "alex@example.test", company: null },
      { customerId: "cust-b", name: "Blair Booker", phone: "+44 7700 900002", email: "blair@example.test", company: "Acme" }
    ],
    vehicleClasses: [
      { key: "standard_sedan_hatchback", label: "Standard Sedan / Hatchback" },
      { key: "minibus", label: "Minibus" }
    ],
    paymentMethods: [
      { value: "card-online", label: "Card / online payment" },
      { value: "bank-transfer", label: "Bank transfer" },
      { value: "card", label: "Card" },
      { value: "payment-link", label: "Payment link" }
    ],
    airports: [{ id: "airport-x", displayName: "Airport X" }],
    pois: [{ id: "poi-1", displayName: "Hotel One", category: "Hotel" }],
    confirmationFees: [{ id: "fee-1", poiId: "poi-1", poiDisplayName: "Hotel One", action: "Porter", amount: "5.00", feeBasis: "" }],
    stopKeys: ["pickup", "via1", "via2", "dropoff"],
    countFields: BOOKING_COUNT_FIELDS,
    countMax: BOOKING_COUNT_MAX,
    timeOptions: serviceTimeOptions(),
    serviceTimezone: "Europe/London",
    cargoSummaryText: cargoSummary({ adults: 0, children: 0, sportsEquipment: 0, xlBaggage: 0, lBaggage: 0, cabinHandBags: 0, backpacks: 0 }, false, false),
    createdByEmail: "dispatcher@example.test",
    mapsBrowserApiKey: "",
    mapsMapId: "",
    quote: null,
    csrfField: '<input type="hidden" name="_csrf" value="token-1">'
  });
}

const resolvedQuote = {
  ok: true,
  errors: [],
  fingerprint: "a".repeat(64),
  stops: [
    { type: "pickup", label: "Airport X — Arrivals", latitude: 51.47, longitude: -0.45, coordinatesVerified: true },
    { type: "via", label: "Airport X — Departures", latitude: 51.47, longitude: -0.45, coordinatesVerified: true },
    { type: "via", label: "Typed Lane", latitude: null, longitude: null, coordinatesVerified: false },
    { type: "dropoff", label: "Hotel One — Lobby", latitude: 51.5, longitude: -0.12, coordinatesVerified: true }
  ],
  route: { status: "resolved", distanceMiles: "18.400000", durationSeconds: 3900, tollsReported: false, zones: [{ zone: "london-ulez", label: "London ULEZ" }], path: [[51.47, -0.45], [51.5, -0.12]] },
  price: {
    status: "complete",
    total: "41.80",
    lines: [
      { type: "ride-fare", label: "Ride fare", status: "applied", amount: "36.80", basis: "18.40 mi", source: {} },
      { type: "airport-pickup-fee", label: "Airport pick-up fee — Airport X", status: "applied", amount: "7.00", basis: "", source: {} },
      { type: "location-discount", label: "Location discount", status: "applied", amount: "-2.00", basis: "", source: {} },
      { type: "airport-dropoff-fee", label: "Airport drop-off fee", status: "not-applicable", amount: null, basis: "", source: {} }
    ]
  }
};
const unresolvedQuote = {
  ok: true,
  errors: [],
  fingerprint: "b".repeat(64),
  stops: resolvedQuote.stops.filter((_, index) => index !== 1),
  route: { status: "unresolved", reason: "missing-stops", message: "One or more stops is an unverified address without coordinates." },
  price: {
    status: "incomplete",
    total: null,
    lines: [{ type: "ride-fare", label: "Ride fare", status: "unresolved", amount: null, basis: "Route distance unavailable", source: {} }]
  }
};

test("New Booking page keeps passengers in sync, orders vias and renders server quotes", async (t) => {
  const executablePath = process.env.CHROMIUM_PATH
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    t.skip("Chromium executable not found");
    return;
  }
  const html = await renderNewBooking();
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const quoteRequests: URLSearchParams[] = [];
    let delayNextQuote = false;
    let releaseDelayedQuote = () => {};
    let delayedQuoteStarted: (() => void) | null = null;
    const delayedQuoteReady = new Promise<void>((resolve) => { delayedQuoteStarted = resolve; });
    let nextQuote: unknown = resolvedQuote;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === "/bookings/new") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/bookings/quote") {
        quoteRequests.push(new URLSearchParams(route.request().postData() ?? ""));
        if (delayNextQuote) {
          delayNextQuote = false;
          delayedQuoteStarted?.();
          await new Promise<void>((resolve) => { releaseDelayedQuote = resolve; });
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(nextQuote) });
      }
      const file = path.join(process.cwd(), "public", url.pathname);
      if (url.pathname.startsWith("/js/") || url.pathname.startsWith("/css/")) return route.fulfill({ path: file });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/bookings/new`);
    await page.waitForFunction(() => Boolean((window as unknown as { RideMatrixNewBooking?: unknown }).RideMatrixNewBooking));

    assert.deepEqual(pageErrors, []);
    const value = (selector: string) => page.locator(selector).inputValue();

    // Existing customer data selection fills the booking manager, and the passenger follows it.
    await page.selectOption("#customerId", "cust-b");
    assert.equal(await value("#managerName"), "Blair Booker");
    assert.equal(await value("#managerEmail"), "blair@example.test");
    assert.equal(await value("#passengerName"), "Blair Booker");
    assert.equal(await value("#passengerPhone"), "+44 7700 900002");
    assert.equal(await page.locator("#passengerName").getAttribute("readonly"), "");

    await page.fill("#managerName", "Blair B. Booker");
    assert.equal(await value("#passengerName"), "Blair B. Booker", "passenger never goes stale while synced");
    await page.selectOption("#customerId", "cust-a");
    assert.equal(await value("#passengerPhone"), "+44 7700 900001");

    await page.uncheck("#passengerIsManager");
    assert.equal(await page.locator("#passengerName").getAttribute("readonly"), null);
    await page.fill("#passengerName", "Pat Passenger");
    await page.fill("#passengerPhone", "+44 7700 900999");
    await page.fill("#managerName", "Alex Changed");
    assert.equal(await value("#passengerName"), "Pat Passenger", "independent passenger is not overwritten");
    await page.check("#passengerIsManager");
    assert.equal(await value("#passengerName"), "Alex Changed");
    await page.uncheck("#passengerIsManager");
    assert.equal(await value("#passengerName"), "Pat Passenger", "unchecking restores the independently edited passenger");

    await page.check("#customerMode-new");
    assert.equal(await page.locator("[data-new-customer-fields]").isVisible(), true);
    await page.fill("#newCustomerGivenName", "Taylor");
    await page.fill("#newCustomerSurname", "Passenger");
    await page.fill("#newCustomerPhone", "+44 7700 900123");
    assert.equal(await value("#managerName"), "Taylor Passenger");
    assert.equal(await value("[data-passenger-name]"), "Pat Passenger", "new customer selection preserves an independently edited passenger");
    await page.check("#customerMode-existing");
    assert.equal(await page.locator("[data-existing-customer-fields]").isVisible(), true);
    assert.equal(await value("#managerName"), "Alex Changed", "switching back restores the selected existing manager");
    assert.equal(await value("[data-passenger-name]"), "Pat Passenger");
    await page.selectOption("#paymentMethod", "bank-transfer");

    // Cargo summary updates automatically and matches the server wording.
    await page.selectOption("#adults", "2");
    await page.selectOption("#xlBaggage", "1");
    await page.selectOption("#sportsEquipment", "3");
    await page.selectOption("#childSeatRequired", "yes");
    assert.equal(
      await page.locator("[data-cargo-summary]").textContent(),
      cargoSummary({ adults: 2, children: 0, sportsEquipment: 3, xlBaggage: 1, lBaggage: 0, cabinHandBags: 0, backpacks: 0 }, true, false)
    );
    await page.selectOption("#lBaggage", "2");
    await page.selectOption("#cabinHandBags", "2");
    assert.match(await page.locator("[data-cargo-summary]").textContent() ?? "", /5 bags \(XL 1, L 2, Cabin 2\)/);
    await page.selectOption("#xlBaggage", "0");
    await page.selectOption("#lBaggage", "0");
    await page.selectOption("#cabinHandBags", "0");
    assert.doesNotMatch(await page.locator("[data-cargo-summary]").textContent() ?? "", /bags?\b/, "zero bags are not summarised");

    // Vias are hidden until added; at most two.
    assert.equal(await page.locator('[data-stop="via1"]').isVisible(), false);
    await page.selectOption("#pickupKind", "airport");
    await page.selectOption("#pickupAirportId", "airport-x");
    await page.selectOption("#dropoffKind", "airport");
    await page.selectOption("#dropoffAirportId", "airport-x");
    await page.selectOption("#vehicleClassKey", "minibus");
    await page.waitForFunction(() => (document.querySelector("[data-quoted-status]") as HTMLInputElement).value === "complete");
    assert.equal(quoteRequests.at(-1)?.get("vehicleClassKey"), "minibus", "vehicle category is sent with the quote");
    const beforeAddVia = quoteRequests.length;
    await page.click("[data-add-via]");
    await page.waitForTimeout(500);
    assert.ok(quoteRequests.length > beforeAddVia, "adding a Via requests a refreshed quote");
    assert.equal(quoteRequests.at(-1)?.get("via1Active"), "yes");
    await page.selectOption("#via1Kind", "airport");
    await page.selectOption("#via1AirportId", "airport-x");
    await page.click("[data-add-via]");
    assert.equal(await page.locator("[data-add-via]").isVisible(), false);
    await page.selectOption("#via2Kind", "address");
    assert.equal(await page.locator("#via2HouseNameNumber").getAttribute("required"), "");
    await page.fill("#via2Label", "Typed Lane");
    await page.fill("#via2HouseNameNumber", "12");
    assert.equal(await page.locator("[data-poi-fee-option]").isVisible(), false, "POI fees only for selected POIs");
    await page.selectOption("#dropoffKind", "poi");
    await page.selectOption("#dropoffPoiId", "poi-1");
    assert.equal(await page.locator("[data-poi-fee-option]").isVisible(), true);

    await page.waitForFunction(() => (document.querySelector("[data-quoted-status]") as HTMLInputElement).value === "complete");
    const request = quoteRequests.at(-1)!;
    assert.equal(request.get("_csrf"), "token-1");
    assert.deepEqual(
      ["pickup", "via1", "via2", "dropoff"].map((key) => request.get(`${key}Kind`)),
      ["airport", "airport", "address", "poi"]
    );
    assert.equal(request.get("via1Active"), "yes");
    assert.equal(request.get("via2Active"), "yes");
    assert.equal(request.get("via2HouseNameNumber"), "12");
    assert.equal(request.get("dropoffPoiId"), "poi-1");

    assert.equal(await page.locator("[data-route-distance]").textContent(), "18.40 miles");
    assert.equal(await page.locator("[data-route-duration]").textContent(), "1 h 5 min");
    assert.equal(await page.locator("[data-route-charges]").textContent(), "Enters London ULEZ");
    assert.deepEqual(
      await page.locator("[data-route-stops] li").allTextContents(),
      ["Pickup: Airport X — Arrivals", "Via: Airport X — Departures", "Via: Typed Lane (unverified — no coordinates)", "Drop-off: Hotel One — Lobby"]
    );
    assert.deepEqual(await page.locator("[data-price-line]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-price-line"))),
      ["ride-fare", "airport-pickup-fee", "location-discount", "airport-dropoff-fee"]);
    assert.match(await page.locator("[data-price-total]").textContent() ?? "", /Total payable\s*£41\.80/);
    assert.equal(await value("[data-quoted-total]"), "41.80");
    assert.equal(await page.locator("[data-unresolved-ack]").isVisible(), false);
    assert.equal(await page.locator("[data-booking-map-unavailable]").isVisible(), true);

    // Removing Via 1 moves Via 2 up so the route order is preserved; the result is re-quoted.
    nextQuote = unresolvedQuote;
    const before = quoteRequests.length;
    await page.click('[data-remove-via="via1"]');
    assert.equal(await value("#via1Kind"), "address");
    assert.equal(await value("#via1Label"), "Typed Lane");
    assert.equal(await page.locator('[data-stop="via2"]').isVisible(), false);
    assert.equal(await page.locator("[data-add-via]").isVisible(), true);
    await page.waitForFunction(() => (document.querySelector("[data-quoted-status]") as HTMLInputElement).value === "incomplete");
    const after = quoteRequests.at(-1)!;
    assert.ok(quoteRequests.length > before);
    assert.equal(after.get("via1Kind"), "address");
    assert.equal(after.get("via2Active"), "");

    assert.equal(await page.locator("[data-route-distance]").textContent(), "Unresolved");
    assert.match(await page.locator("[data-route-message]").textContent() ?? "", /unverified address/);
    assert.match(await page.locator("[data-price-total]").textContent() ?? "", /Not confirmed/);
    assert.equal(await value("[data-quoted-total]"), "");
    assert.equal(await page.locator("[data-unresolved-ack]").isVisible(), true);
    await page.check("#saveWithUnresolvedPrice");

    // Editing a priced input invalidates the shown quote until the server recalculates it.
    await page.selectOption("#serviceTime", "15:05");
    assert.equal(await value("[data-quoted-status]"), "");
    assert.equal(await page.locator("#saveWithUnresolvedPrice").isChecked(), false);
    delayNextQuote = true;
    await page.selectOption("#serviceTime", "15:10");
    await delayedQuoteReady;
    assert.equal(await value("[data-quoted-status]"), "", "no quote is shown while the new request is in flight");
    assert.equal(await value("[data-quote-fingerprint]"), "");
    releaseDelayedQuote();
    await page.waitForTimeout(100);
    await page.waitForFunction(() => (document.querySelector("[data-quoted-status]") as HTMLInputElement).value === "incomplete");
    const times = await page.locator("#serviceTime option").allTextContents();
    assert.ok(times.every((time) => /^([01]\d|2[0-3]):[0-5][05]$/.test(time)));

    // The journey and map sit side by side on desktop.
    const [formBox, mapBox] = await Promise.all([
      page.locator(".new-booking-journey__form").boundingBox(),
      page.locator(".new-booking-journey__map").boundingBox()
    ]);
    assert.ok(formBox && mapBox && mapBox.x > formBox.x + formBox.width - 1);
    assert.ok(Math.abs(formBox!.width - mapBox!.width) < 4, "approximately 50:50");
    const layout = await page.evaluate(() => ({
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      titleFontSize: Number.parseFloat(getComputedStyle(document.querySelector(".new-booking-page h1")!).fontSize),
      blockHeadingFontSize: Number.parseFloat(getComputedStyle(document.querySelector(".new-booking-block > h2")!).fontSize)
    }));
    assert.ok(layout.pageWidth <= layout.viewportWidth + 1, "desktop form should not overflow horizontally");
    assert.ok(layout.titleFontSize <= 28, "New Booking title should be compact");
    assert.ok(layout.blockHeadingFontSize <= 20, "form block headings should be compact");

    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
