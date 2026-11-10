import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import express from "express";
import { MIGRATIONS } from "../database/migrations";
import { createCsrfProtection } from "../middleware/csrf";
import type {
  AirportFeeActor,
  AirportFeeFormValues,
  AirportFeeRecord,
  AirportFeeStore
} from "../services/airport-fees";
import {
  crossingFeeScheduleDrafts,
  londonFeeScheduleDrafts
} from "../services/london-fee-schedule-data";
import type {
  LondonFeeScheduleActor,
  LondonFeeScheduleScheme,
  LondonFeeScheduleSnapshot,
  LondonFeeScheduleStore
} from "../services/london-fee-schedules";
import {
  EMPTY_FARE_SETTINGS,
  FareSettingsVersionConflictError,
  type FareSettingsActor,
  type FareSettingsConfiguration,
  type FareSettingsSnapshot,
  type FareSettingsStore
} from "../services/fare-settings";
import {
  createRoleSectionsRouter,
  fareSettingsCategories,
  grantingRoles,
  tollFeeCategories,
  workspaceModules
} from "./role-sections";

// Role keys the Staff directory shows for bookings@romanairporttransfers.co.uk
// (admin, customer, driver, partner, staff, superuser, tech_support).
const BOOKINGS_ROLES = ["admin", "customer", "driver", "partner", "staff", "superuser", "tech_support"];

type SchemeLeaf = {
  title: string;
  path: string;
  parentPath: string;
  parentTitle: string;
  categorySlug: string;
};

/** Every leaf destination: areas for nested categories, the category itself otherwise. */
function schemeLeaves(): SchemeLeaf[] {
  return tollFeeCategories.filter((category) => category.slug !== "airport-fees").flatMap((category) => {
    const categoryPath = `/settings/toll-fees/${category.slug}`;
    if (!category.areas) {
      return [{ title: category.title, path: categoryPath, parentPath: "/settings/toll-fees", parentTitle: "Toll & Fees", categorySlug: category.slug }];
    }
    return category.areas.map((area) => ({
      title: area.title,
      path: `${categoryPath}/${area.slug}`,
      parentPath: categoryPath,
      parentTitle: category.title,
      categorySlug: category.slug
    }));
  });
}

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;");

function createMemoryAirportFeeStore(): { store: AirportFeeStore; reset: () => void; records: AirportFeeRecord[] } {
  const records: AirportFeeRecord[] = [];
  let nextId = 1;
  const reset = () => {
    records.splice(0, records.length);
    nextId = 1;
  };
  const toRecord = (id: string, values: AirportFeeFormValues): AirportFeeRecord => ({
    id,
    displayName: values.displayName,
    dropoffPlaceId: values.dropoffPlaceId,
    dropoffLocationLabel: values.dropoffLocationLabel,
    dropoffLatitude: Number(values.dropoffLatitude),
    dropoffLongitude: Number(values.dropoffLongitude),
    dropoffFee: values.dropoffFee,
    pickupPlaceId: values.pickupPlaceId,
    pickupLocationLabel: values.pickupLocationLabel,
    pickupLatitude: Number(values.pickupLatitude),
    pickupLongitude: Number(values.pickupLongitude),
    pickupFee: values.pickupFee,
    pickupTimeReference: values.pickupTimeReference === "ALT" || values.pickupTimeReference === "AGA"
      ? values.pickupTimeReference
      : null,
    pickupDeferredEnabled: values.pickupDeferredPolicy === "yes" ? true : values.pickupDeferredPolicy === "no" ? false : null,
    pickupDeferredMinutes: values.pickupDeferredMinutes ? Number(values.pickupDeferredMinutes) : null,
    pickupFeeCoveredMinutes: values.pickupFeeCoveredMinutes ? Number(values.pickupFeeCoveredMinutes) : null,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z"
  });
  return {
    records,
    reset,
    store: {
      async list() {
        return structuredClone(records);
      },
      async get(id) {
        const record = records.find((item) => item.id === id);
        return record ? structuredClone(record) : null;
      },
      async save(id: string | null, values: AirportFeeFormValues, _actor: AirportFeeActor) {
        if (id) {
          const index = records.findIndex((item) => item.id === id);
          if (index < 0) return null;
          records[index] = toRecord(id, values);
          return structuredClone(records[index]);
        }
        const record = toRecord(`airport-${nextId++}`, values);
        records.push(record);
        return structuredClone(record);
      },
      async archive(id, _actor) {
        const index = records.findIndex((item) => item.id === id);
        if (index < 0) return false;
        records.splice(index, 1);
        return true;
      }
    }
  };
}

function createMemoryFeeScheduleStore(): { store: LondonFeeScheduleStore; reset: () => void } {
  const snapshots = new Map<LondonFeeScheduleScheme, LondonFeeScheduleSnapshot>();
  const reset = () => {
    snapshots.clear();
    for (const scheme of [
      "london-lez",
      "london-ulez",
      "dartford-crossing",
      "blackwall-silvertown-tunnels"
    ] as const) {
      const schedule = scheme in londonFeeScheduleDrafts
        ? londonFeeScheduleDrafts[scheme as keyof typeof londonFeeScheduleDrafts]
        : crossingFeeScheduleDrafts[scheme as keyof typeof crossingFeeScheduleDrafts];
      snapshots.set(scheme, {
        schedule: structuredClone(schedule),
        currentVersion: 1,
        history: [{ version: 1, actorEmail: "Initial supplied draft", createdAt: "2026-11-01T00:00:00.000Z" }]
      });
    }
  };
  reset();

  return {
    reset,
    store: {
      async load(scheme) {
        const snapshot = snapshots.get(scheme);
        assert.ok(snapshot);
        return structuredClone(snapshot);
      },
      async save(scheme, expectedVersion, amounts, actor: LondonFeeScheduleActor) {
        const current = snapshots.get(scheme);
        assert.ok(current);
        assert.equal(current.currentVersion, expectedVersion);
        const schedule = current.schedule.kind === "crossing"
          ? {
            ...current.schedule,
            rates: current.schedule.rates.map((rate) => ({ ...rate, amount: amounts[rate.key] }))
          }
          : {
            ...current.schedule,
            rates: current.schedule.rates.map((rate) => ({ ...rate, amount: Number(amounts[rate.key]) }))
          };
        snapshots.set(scheme, {
          schedule,
          currentVersion: current.currentVersion + 1,
          history: [
            { version: current.currentVersion + 1, actorEmail: actor.email, createdAt: "2026-11-01T00:01:00.000Z" },
            ...current.history
          ]
        });
      }
    }
  };
}

function createMemoryFareSettingsStore(): { store: FareSettingsStore; reset: () => void; snapshot: () => FareSettingsSnapshot } {
  let state: FareSettingsSnapshot;
  const reset = () => {
    state = { configuration: structuredClone(EMPTY_FARE_SETTINGS), currentVersion: 0, history: [] };
  };
  reset();
  return {
    reset,
    snapshot: () => structuredClone(state),
    store: {
      async load() {
        return structuredClone(state);
      },
      async save(expectedVersion: number, configuration: FareSettingsConfiguration, actor: FareSettingsActor) {
        if (expectedVersion !== state.currentVersion) throw new FareSettingsVersionConflictError();
        state = {
          configuration: structuredClone(configuration),
          currentVersion: state.currentVersion + 1,
          history: [
            {
              version: state.currentVersion + 1,
              actorEmail: actor.email,
              createdAt: "2026-11-10T12:00:00.000Z"
            },
            ...state.history
          ]
        };
      }
    }
  };
}

describe("role workspaces authorize against the /auth/session role contract", () => {
  let authServer: http.Server;
  let appServer: http.Server;
  let baseUrl: string;
  const previousMapEnvironment = {
    enabled: process.env.GOOGLE_MAPS_ENABLED,
    publicEnabled: process.env.NEXT_PUBLIC_GOOGLE_MAPS_ENABLED,
    browserKey: process.env.GOOGLE_MAPS_BROWSER_API_KEY,
    publicBrowserKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY,
    nextBrowserKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  };
  const sessionsByCookie = new Map<string, unknown>();
  const seenCookies: Array<string | undefined> = [];
  const feeSchedules = createMemoryFeeScheduleStore();
  const airportFees = createMemoryAirportFeeStore();
  const fareSettings = createMemoryFareSettingsStore();

  before(async () => {
    process.env.GOOGLE_MAPS_ENABLED = "false";
    delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_ENABLED;
    delete process.env.GOOGLE_MAPS_BROWSER_API_KEY;
    delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY;
    delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

    // Stand-in for the external auth service (API_BASE_URL defaults to
    // http://127.0.0.1:4000). The real getSessionAccount() client is used, so
    // the cookie forwarding and JSON session shape are exercised end-to-end.
    authServer = http.createServer((req, res) => {
      if (req.url === "/auth/session" && req.method === "GET") {
        seenCookies.push(req.headers.cookie);
        const session = sessionsByCookie.get(req.headers.cookie ?? "") ?? { authenticated: false };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(session));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => authServer.listen(4000, "127.0.0.1", resolve));

    const app = express();
    app.set("view engine", "ejs");
    app.set("views", `${process.cwd()}/src/views`);
    app.use(express.urlencoded({ extended: true }));
    app.use(createCsrfProtection({ appTitle: "RideMatrix Test", cookieSecure: false }));
    app.use(createRoleSectionsRouter({
      appTitle: "RideMatrix Test",
      feeScheduleStore: feeSchedules.store,
      airportFeeStore: airportFees.store,
      fareSettingsStore: fareSettings.store
    }));
    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
    for (const [name, value] of Object.entries({
      GOOGLE_MAPS_ENABLED: previousMapEnvironment.enabled,
      NEXT_PUBLIC_GOOGLE_MAPS_ENABLED: previousMapEnvironment.publicEnabled,
      GOOGLE_MAPS_BROWSER_API_KEY: previousMapEnvironment.browserKey,
      NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY: previousMapEnvironment.publicBrowserKey,
      NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: previousMapEnvironment.nextBrowserKey
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function withSession(cookie: string, roles: unknown) {
    sessionsByCookie.set(cookie, {
      authenticated: true,
      user: { id: "u-1", email: "bookings@romanairporttransfers.co.uk", roles, active_role: "admin" }
    });
    return { cookie };
  }

  test("a session holding the superuser role key can open /settings and is told access was granted", async () => {
    const headers = withSession("sid=superuser", BOOKINGS_ROLES);

    const response = await fetch(`${baseUrl}/settings`, { headers, redirect: "manual" });

    assert.equal(response.status, 200);
    assert.equal(seenCookies.at(-1), "sid=superuser");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const body = await response.text();
    assert.match(body, /System settings/);
    assert.match(body, /Access granted\./);
    assert.match(body, /System Control \(superuser\)/);
    assert.match(body, /Not yet configured/);
    assert.match(body, /href="\/settings\/toll-fees"/);
    assert.doesNotMatch(body, /Unable to continue/);
  });

  test("Toll & Fees and every category destination are reachable with clear placeholders", async () => {
    const headers = withSession("sid=toll-fees", ["superuser"]);
    const categoryResponse = await fetch(`${baseUrl}/settings/toll-fees`, { headers });
    assert.equal(categoryResponse.status, 200);
    const categoryBody = await categoryResponse.text();
    assert.match(categoryBody, /<h1>Toll & Fees<\/h1>/);
    assert.match(categoryBody, /Draft schedules only/);
    assert.match(categoryBody, /not calculated or charged/i);
    assert.match(categoryBody, /aria-label="Toll & Fees categories"/);
    assert.equal((categoryBody.match(/class="toll-fees-card"/g) ?? []).length, tollFeeCategories.length);
    assert.doesNotMatch(categoryBody, /class="toll-fees-subnav__item"/);

    for (const category of tollFeeCategories) {
      assert.equal(categoryBody.split(category.title).length - 1, 1, `${category.title} should appear once on the landing page`);
      assert.equal(
        categoryBody.split(`href="/settings/toll-fees/${category.slug}"`).length - 1,
        1,
        `${category.title} should have one landing-page destination`
      );
      const categoryPath = `/settings/toll-fees/${category.slug}`;
      const response = await fetch(`${baseUrl}${categoryPath}`, { headers });
      assert.equal(response.status, 200, `${category.title} category should be reachable`);
      const body = await response.text();
      assert.ok(body.includes(category.title), `${category.title} should be visible`);
      assert.match(body, /aria-label="Breadcrumb"/);
      assert.match(body, /href="\/settings\/toll-fees">Toll &amp; Fees<\/a>/);

      if (category.slug === "airport-fees") {
        assert.match(body, /Add Airport and Fee/);
        assert.match(body, /Saved airports/);
        assert.match(body, /configuration only; this web layer does not apply them to booking or fare calculations/);
        assert.doesNotMatch(body, /Reference data \(managed\)|Fee settings|Not configured yet/);
        continue;
      }

      if (category.areas) {
        assert.equal((body.match(/class="toll-fees-card"/g) ?? []).length, category.areas.length);
        assert.doesNotMatch(body, /class="toll-fees-subnav__item"/);
        for (const area of category.areas) {
          assert.ok(body.includes(`href="${categoryPath}/${area.slug}"`), `${area.title} should be linked from ${category.title}`);
        }
        continue;
      }

      assert.ok(body.includes(`${categoryPath}/reference-data`), "reference data destination should be linked");
      assert.ok(body.includes(`${categoryPath}/fee-settings`), "fee settings destination should be linked");
      assert.equal((body.match(/class="toll-fees-subnav__item"/g) ?? []).length, 2);
    }

    for (const scheme of schemeLeaves()) {
      const schemeUrl = `${baseUrl}${scheme.path}`;
      const schemeResponse = await fetch(schemeUrl, { headers });
      assert.equal(schemeResponse.status, 200, `${scheme.title} should be reachable`);
      const schemeBody = await schemeResponse.text();
      assert.ok(schemeBody.includes(scheme.title), `${scheme.title} should be visible`);
      assert.match(schemeBody, /aria-label="Breadcrumb"/);
      assert.ok(schemeBody.includes(`href="${scheme.parentPath}">${escapeHtml(scheme.parentTitle)}</a>`), "parent breadcrumb should be linked");
      assert.ok(schemeBody.includes(`&larr; Back to ${escapeHtml(scheme.parentTitle)}</a>`), "a back link to the parent should be shown");
      assert.equal((schemeBody.match(/class="toll-fees-subnav__item"/g) ?? []).length, 2);

      for (const destination of [
        { path: "reference-data", title: "Reference data (managed)", explanation: /versioned geographic boundaries/ },
        { path: "fee-settings", title: "Fee settings", explanation: /configurable fee schedules/ }
      ]) {
        const destinationResponse = await fetch(`${schemeUrl}/${destination.path}`, { headers });
        assert.equal(destinationResponse.status, 200, `${scheme.title} ${destination.title} should be reachable`);
        const destinationBody = await destinationResponse.text();
        assert.ok(destinationBody.includes(`${scheme.title}: ${destination.title}`), `${scheme.title} ${destination.title} should have a page title`);
        assert.match(destinationBody, destination.explanation);
        const isLondonLezReference = scheme.title === "London LEZ" && destination.path === "reference-data";
        const isLondonUlezReference = scheme.title === "London ULEZ" && destination.path === "reference-data";
        const isLondonCongestionChargeReference = scheme.title === "London Congestion Charge" && destination.path === "reference-data";
        if (isLondonLezReference) {
          assert.match(destinationBody, /London Low Emission Zone boundary/);
          assert.match(destinationBody, /Map preview unavailable/);
          assert.doesNotMatch(destinationBody, /Not configured yet/);
        } else if (isLondonUlezReference) {
          assert.match(destinationBody, /London Ultra Low Emission Zone boundary/);
          assert.match(destinationBody, /Low Emission Zone/);
          assert.match(destinationBody, /DATE_CREAT; not an effective date/);
          assert.match(destinationBody, /Source URL<\/dt><dd>Not provided/);
          assert.match(destinationBody, /Effective date<\/dt><dd>Not provided/);
          assert.match(destinationBody, /Verification<\/dt><dd>Unverified/);
          assert.match(destinationBody, /Map preview unavailable/);
          assert.doesNotMatch(destinationBody, /Not configured yet/);
        } else if (isLondonCongestionChargeReference) {
          assert.match(destinationBody, /London Congestion Charge boundary/);
          assert.match(destinationBody, /2 Polygon features/);
          assert.match(destinationBody, /Effective date<\/dt><dd>Unknown \(not provided\)/);
          assert.match(destinationBody, /Source URL<\/dt><dd>Not provided/);
          assert.match(destinationBody, /Verification<\/dt><dd>Unverified/);
          assert.match(destinationBody, /Map preview unavailable/);
          assert.doesNotMatch(destinationBody, /Not configured yet/);
        } else if (scheme.title === "London ULEZ" && destination.path === "fee-settings") {
          assert.match(destinationBody, /Draft \/ Inactive — not used for booking prices/);
          assert.match(destinationBody, /value="12\.50"/);
          assert.match(destinationBody, /Euro 6 \(NOx and PM\)/);
          assert.match(destinationBody, /Unknown \/ unverified; not supplied/);
          assert.match(destinationBody, /Source: Cars/);
          assert.match(destinationBody, /cars\?intcmp=52215/);
          assert.doesNotMatch(destinationBody, /data-london-ulez-map|DATE_CREAT|boundary\.json/);
        } else if (scheme.title === "London LEZ" && destination.path === "fee-settings") {
          assert.match(destinationBody, /Draft \/ Inactive — not used for booking prices/);
          assert.match(destinationBody, /value="100\.00"/);
          assert.match(destinationBody, /value="300\.00"/);
          assert.match(destinationBody, /Euro 3/);
          assert.match(destinationBody, /Euro IV \(PM\)/);
          assert.match(destinationBody, /source URL was not supplied/);
          assert.match(destinationBody, /Unknown \/ unverified; not supplied/);
        } else if (
          (scheme.title === "Dartford Crossing" || scheme.title === "Blackwall & Silvertown tunnels")
          && destination.path === "fee-settings"
        ) {
          assert.match(destinationBody, /Draft \/ Inactive — not used for booking prices/);
        } else {
          assert.match(destinationBody, /Not configured yet/);
        }
        const selectedSubnav = destinationBody.match(/<a class="toll-fees-subnav__item"[^>]*aria-current="page"[^>]*>/g) ?? [];
        assert.equal(selectedSubnav.length, 1, "exactly one subpage should be marked as selected");
        assert.ok(selectedSubnav[0].includes(`${scheme.path}/${destination.path}`), "the selected subpage should match the current destination");
        assert.match(destinationBody, /does not (display maps, )?calculate fees, or charge customers|does not calculate fees or charge customers/);
      }
    }
  });

  test("Airport Fees creates, edits, validates, and archives airport records without pricing or booking changes", async () => {
    airportFees.reset();
    const previousEnabled = process.env.GOOGLE_MAPS_ENABLED;
    const previousBrowserKey = process.env.GOOGLE_MAPS_BROWSER_API_KEY;
    process.env.GOOGLE_MAPS_ENABLED = "true";
    process.env.GOOGLE_MAPS_BROWSER_API_KEY = "airport-test-browser-key";
    const airportPath = "/settings/toll-fees/airport-fees";
    const sessionCookie = "sid=airport-admin";
    const headers = withSession(sessionCookie, ["superuser"]);

    try {
      const pageResponse = await fetch(`${baseUrl}${airportPath}`, { headers });
      assert.equal(pageResponse.status, 200);
      const pageBody = await pageResponse.text();
      const csrfCookie = pageResponse.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
      const token = pageBody.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfCookie);
      assert.ok(token);
      assert.match(pageBody, /data-airport-place-root/);
      assert.match(pageBody, /Bournemouth Airport Car Park 1/);
      assert.match(pageBody, /airport-display-name/);
      const airportForm = pageBody.match(/<form class="airport-fees__form"[\s\S]*?<\/form>/)?.[0];
      assert.ok(airportForm, "the airport form should be rendered");
      for (const [id, label] of [
        ["airport-display-name", "Airport display name"],
        ["airport-dropoff-location", "Drop-off location"],
        ["airport-dropoff-fee", "Drop-off fee (GBP)"],
        ["airport-pickup-location", "Pick-up location"],
        ["airport-pickup-fee", "Pick-up fee (GBP)"],
        ["airport-pickup-time-reference", "Time reference"],
        ["airport-pickup-deferred-policy", "Deferred pick-up policy"],
        ["airport-pickup-deferred-minutes", "Deferred period before fee-covered period begins (minutes)"],
        ["airport-pickup-fee-covered-minutes", "Fee-covered period (minutes)"]
      ]) {
        assert.ok(airportForm.includes(`<label for="${id}">${label}</label>`), `${label} should have an associated visible label`);
        assert.ok(airportForm.includes(`id="${id}"`), `${label} should point to a form control`);
      }
      const formFieldOrder = Array.from(
        airportForm.matchAll(/name="(displayName|dropoffLocationLabel|dropoffFee|pickupLocationLabel|pickupFee|pickupTimeReference|pickupDeferredPolicy|pickupDeferredMinutes|pickupFeeCoveredMinutes)"/g),
        (match) => match[1]
      );
      assert.deepEqual(formFieldOrder, [
        "displayName",
        "dropoffLocationLabel",
        "dropoffFee",
        "pickupLocationLabel",
        "pickupFee",
        "pickupTimeReference",
        "pickupDeferredPolicy",
        "pickupDeferredMinutes",
        "pickupFeeCoveredMinutes"
      ]);
      assert.match(airportForm, /name="pickupTimeReference" required/);
      assert.match(airportForm, /name="pickupDeferredPolicy" required/);
      assert.match(airportForm, /name="pickupDeferredMinutes" required/);
      assert.match(airportForm, /name="pickupFeeCoveredMinutes" required/);
      assert.doesNotMatch(airportForm, /name="pickupTimeReference"[^>]*>[\s\S]*?<option value="(?:ALT|AGA)" selected/);
      assert.match(airportForm, /This is the period covered by the configured pick-up fee, not fee effective dates/);
      assert.ok(airportForm.indexOf('name="pickupFee"') < airportForm.indexOf("Save airport and fees"));
      assert.ok(pageBody.indexOf("</form>") < pageBody.indexOf('aria-labelledby="airport-fees-records-title"'));
      assert.match(airportForm, /name="dropoffPlaceId"/);
      assert.match(airportForm, /name="dropoffLatitude"/);
      assert.match(airportForm, /name="dropoffLongitude"/);
      assert.match(airportForm, /name="pickupPlaceId"/);
      assert.match(airportForm, /name="pickupLatitude"/);
      assert.match(airportForm, /name="pickupLongitude"/);
      assert.match(pageBody, /configuration only; this web layer does not apply them to booking or fare calculations/);
      assert.doesNotMatch(pageBody, /fare total|booking price|customer charge/i);

      const postCookie = `${sessionCookie}; ${csrfCookie}`;
      sessionsByCookie.set(postCookie, {
        authenticated: true,
        user: { id: "u-1", email: "bookings@romanairporttransfers.co.uk", roles: ["superuser"], active_role: "superuser" }
      });
      const formValues = {
        id: "",
        displayName: "Bournemouth Airport (BOH)",
        dropoffPlaceId: "ChIJ-dropoff-car-park",
        dropoffLocationLabel: "Bournemouth Airport Car Park 1",
        dropoffLatitude: "50.7799",
        dropoffLongitude: "-1.8425",
        dropoffFee: "0",
        pickupPlaceId: "ChIJ-pickup-terminal",
        pickupLocationLabel: "Bournemouth Airport terminal pickup",
        pickupLatitude: "50.7801",
        pickupLongitude: "-1.8420",
        pickupFee: "4.50",
        pickupTimeReference: "AGA",
        pickupDeferredPolicy: "yes",
        pickupDeferredMinutes: "30",
        pickupFeeCoveredMinutes: "30"
      };
      const submit = (values: Record<string, string>, url = airportPath) => fetch(`${baseUrl}${url}`, {
        method: "POST",
        headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...values, _csrf: token }),
        redirect: "manual"
      });

      const invalid = await submit({
        ...formValues,
        dropoffPlaceId: "",
        pickupPlaceId: "",
        dropoffFee: "",
        pickupFee: "1.234",
        pickupTimeReference: "",
        pickupDeferredMinutes: "0"
      });
      assert.equal(invalid.status, 400);
      const invalidBody = await invalid.text();
      assert.match(invalidBody, /Select a drop-off location from Google Places/);
      assert.match(invalidBody, /Select a pick-up location from Google Places/);
      assert.match(invalidBody, /Enter a GBP amount/);
      assert.match(invalidBody, /Select Actual Landing Time/);
      assert.match(invalidBody, /non-zero deferred period/);
      assert.match(invalidBody, /value="1\.234"/);
      assert.equal(airportFees.records.length, 0);

      const created = await submit(formValues);
      assert.equal(created.status, 303);
      assert.equal(created.headers.get("location"), `${airportPath}?saved=1`);
      assert.equal(airportFees.records.length, 1, "create should insert one airport configuration");
      assert.equal(airportFees.records[0].displayName, "Bournemouth Airport (BOH)");
      assert.equal(airportFees.records[0].dropoffPlaceId, "ChIJ-dropoff-car-park");
      assert.equal(airportFees.records[0].pickupPlaceId, "ChIJ-pickup-terminal");
      assert.equal(airportFees.records[0].dropoffLatitude, 50.7799);
      assert.equal(airportFees.records[0].dropoffLongitude, -1.8425);
      assert.equal(airportFees.records[0].pickupLatitude, 50.7801);
      assert.equal(airportFees.records[0].pickupLongitude, -1.842);
      assert.equal(airportFees.records[0].dropoffFee, "0.00", "£0.00 is an explicit zero amount");
      assert.equal(airportFees.records[0].pickupFee, "4.50");
      assert.equal(airportFees.records[0].pickupTimeReference, "AGA");
      assert.equal(airportFees.records[0].pickupDeferredEnabled, true);
      assert.equal(airportFees.records[0].pickupDeferredMinutes, 30);
      assert.equal(airportFees.records[0].pickupFeeCoveredMinutes, 30);
      const savedListBody = await (await fetch(`${baseUrl}${airportPath}`, { headers })).text();
      assert.match(savedListBody, /Customer time window: 60 minutes from Actual Gate Arrival \(AGA\)/);

      const editPage = await fetch(`${baseUrl}${airportPath}?edit=airport-1`, { headers });
      const editBody = await editPage.text();
      assert.equal(editPage.status, 200);
      assert.match(editBody, /Edit Airport and Fee/);
      assert.match(editBody, /name="id" value="airport-1"/);
      assert.match(editBody, /name="pickupPlaceId" value="ChIJ-pickup-terminal"/);
      assert.match(editBody, /name="dropoffLatitude" value="50\.7799"/);
      assert.match(editBody, /name="pickupLongitude" value="-1\.842"/);
      assert.match(editBody, /name="pickupTimeReference" required[\s\S]*?<option value="AGA" selected/);
      assert.match(editBody, /name="pickupDeferredPolicy" required[\s\S]*?<option value="yes" selected/);
      assert.match(editBody, /name="pickupDeferredMinutes" required[\s\S]*?<option value="30" selected/);
      assert.match(editBody, /name="pickupFeeCoveredMinutes" required[\s\S]*?<option value="30" selected/);
      const updated = await submit({
        ...formValues,
        id: "airport-1",
        displayName: "Bournemouth Airport (BOH) — updated",
        dropoffFee: "3.25"
      });
      assert.equal(updated.status, 303);
      assert.equal(airportFees.records.length, 1, "editing must not create a duplicate");
      assert.equal(airportFees.records[0].displayName, "Bournemouth Airport (BOH) — updated");
      assert.equal(airportFees.records[0].dropoffFee, "3.25");
      assert.equal(airportFees.records[0].pickupFee, "4.50", "changing the drop-off amount must not change the pick-up fee");

      const configuredRecord = airportFees.records[0];
      airportFees.records.push({
        ...configuredRecord,
        id: "legacy-airport",
        pickupTimeReference: null,
        pickupDeferredEnabled: null,
        pickupDeferredMinutes: null,
        pickupFeeCoveredMinutes: null
      });
      const legacyEdit = await fetch(`${baseUrl}${airportPath}?edit=legacy-airport`, { headers });
      const legacyBody = await legacyEdit.text();
      assert.equal(legacyEdit.status, 200);
      assert.match(legacyBody, /Setup incomplete: this legacy airport has no saved pick-up timing policy/);
      assert.match(legacyBody, /Setup incomplete: pick-up timing policy is not configured/);
      assert.match(legacyBody, /name="pickupTimeReference" required[\s\S]*?<option value="" selected/);
      assert.doesNotMatch(legacyBody, /name="pickupTimeReference" required[\s\S]*?<option value="(?:ALT|AGA)" selected/);
      airportFees.records.splice(airportFees.records.indexOf(configuredRecord) + 1, 1);

      const confirmationPage = await fetch(`${baseUrl}${airportPath}`, { headers });
      const confirmationBody = await confirmationPage.text();
      assert.match(confirmationBody, /data-airport-delete-open="airport-delete-airport-1"/);
      assert.match(confirmationBody, /data-airport-delete-cancel/);
      assert.equal(airportFees.records.length, 1, "canceling confirmation must leave the record saved");

      const deleted = await submit({}, `${airportPath}/airport-1/delete`);
      assert.equal(deleted.status, 303);
      assert.equal(deleted.headers.get("location"), `${airportPath}?archived=1`);
      assert.equal(airportFees.records.length, 0, "confirmed deletion archives and removes the record from the list");

      const sameLocationValues = {
        ...formValues,
        id: "",
        pickupPlaceId: formValues.dropoffPlaceId,
        pickupLocationLabel: formValues.dropoffLocationLabel,
        pickupLatitude: formValues.dropoffLatitude,
        pickupLongitude: formValues.dropoffLongitude
      };
      const sameLocationSaved = await submit(sameLocationValues);
      assert.equal(sameLocationSaved.status, 303);
      assert.equal(airportFees.records.length, 1);
      assert.equal(airportFees.records[0].pickupPlaceId, airportFees.records[0].dropoffPlaceId);
      assert.equal(airportFees.records[0].pickupLatitude, airportFees.records[0].dropoffLatitude);
    } finally {
      if (previousEnabled === undefined) delete process.env.GOOGLE_MAPS_ENABLED;
      else process.env.GOOGLE_MAPS_ENABLED = previousEnabled;
      if (previousBrowserKey === undefined) delete process.env.GOOGLE_MAPS_BROWSER_API_KEY;
      else process.env.GOOGLE_MAPS_BROWSER_API_KEY = previousBrowserKey;
    }
  });

  test("London LEZ and ULEZ drafts are distinct, inactive, editable, and retain append-only form history", async () => {
    feeSchedules.reset();
    const headers = withSession("sid=fee-schedules", ["superuser"]);
    const londonBase = "/settings/toll-fees/london-lez-ulez-congestion-charge";
    const lezResponse = await fetch(`${baseUrl}${londonBase}/london-lez/fee-settings`, { headers });
    const lezBody = await lezResponse.text();
    assert.equal(lezResponse.status, 200);
    assert.match(lezBody, /value="100\.00"/);
    assert.match(lezBody, /value="300\.00"/);
    assert.match(lezBody, /Cars and motorcycles\/L-category vehicles/);
    assert.match(lezBody, /Small vans up to and including 1\.205 tonnes unladen/);
    assert.match(lezBody, /Draft \/ Inactive — not used for booking prices/);
    for (const rate of londonFeeScheduleDrafts["london-lez"].rates) {
      const rateCard = lezBody.match(new RegExp(`<fieldset class="london-fee-draft__rate">[\\s\\S]*?name="amount_${rate.key}"[\\s\\S]*?</fieldset>`))?.[0];
      assert.ok(rateCard, `rate card should include ${rate.key}`);
      assert.ok(rateCard.includes(`<legend>${rate.label}</legend>`));
      assert.ok(rateCard.includes(`<label for="london-fee-amount-${rate.key}">Daily rate (GBP per charging day)</label>`));
      assert.ok(rateCard.includes(rate.applicability));
      assert.ok(rateCard.includes(rate.emissionsThresholds));
    }

    const ulezResponse = await fetch(`${baseUrl}${londonBase}/london-ulez/fee-settings`, { headers });
    const ulezBody = await ulezResponse.text();
    assert.equal(ulezResponse.status, 200);
    assert.match(ulezBody, /value="12\.50"/);
    assert.match(ulezBody, /Petrol: Euro 4 \(NOx\)\. Diesel: Euro 6 \(NOx and PM\)/);
    assert.match(ulezBody, /Euro 3 \(NOx\)/);
    assert.match(ulezBody, /24 hours a day every day except Christmas Day/);
    assert.match(ulezBody, /does not include the M25/);
    assert.match(ulezBody, /TfL registration is an operational requirement/);
    assert.match(ulezBody, /ULEZ enforcement penalties are not fee rates/);
    assert.match(ulezBody, /cars\?intcmp=52215/);
    assert.match(ulezBody, /vans-minibuses-and-more\?intcmp=52212/);
    assert.match(ulezBody, /motorcycles-mopeds-and-more\?intcmp=52209/);
    assert.match(ulezBody, /larger-vehicles\?intcmp=52206/);
    assert.match(ulezBody, /Unknown \/ unverified; not supplied/);
    assert.match(ulezBody, /complete rules were not supplied/);
    assert.doesNotMatch(ulezBody, /£180|£90/);

    const ulezCookie = ulezResponse.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
    const token = ulezBody.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(ulezCookie);
    assert.ok(token);
    sessionsByCookie.set(`sid=fee-schedules; ${ulezCookie}`, {
      authenticated: true,
      user: { id: "u-1", email: "bookings@romanairporttransfers.co.uk", roles: ["superuser"], active_role: "superuser" }
    });
    const updatePath = `${londonBase}/london-ulez/fee-settings`;
    const invalidForm = new URLSearchParams({ _csrf: token, baseVersion: "1" });
    for (const rate of londonFeeScheduleDrafts["london-ulez"].rates) {
      invalidForm.set(`amount_${rate.key}`, rate.key === "ulez-cars" ? "12.345" : rate.amount.toFixed(2));
    }
    const invalidResponse = await fetch(`${baseUrl}${updatePath}`, {
      method: "POST",
      headers: { cookie: `sid=fee-schedules; ${ulezCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: invalidForm,
      redirect: "manual"
    });
    assert.equal(invalidResponse.status, 400);
    assert.match(await invalidResponse.text(), /no more than 2 decimal places/);

    const validForm = new URLSearchParams({ _csrf: token, baseVersion: "1" });
    for (const rate of londonFeeScheduleDrafts["london-ulez"].rates) {
      validForm.set(`amount_${rate.key}`, rate.key === "ulez-cars" ? "13.25" : rate.amount.toFixed(2));
    }
    const savedResponse = await fetch(`${baseUrl}${updatePath}`, {
      method: "POST",
      headers: { cookie: `sid=fee-schedules; ${ulezCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: validForm,
      redirect: "manual"
    });
    assert.equal(savedResponse.status, 303);
    assert.equal(savedResponse.headers.get("location"), `${updatePath}?saved=1`);

    const savedPage = await (await fetch(`${baseUrl}${updatePath}?saved=1`, { headers })).text();
    assert.match(savedPage, /Draft changes saved as version 2/);
    assert.match(savedPage, /value="13\.25"/);
    assert.match(savedPage, /<li><strong>Version 2<\/strong> — bookings@romanairporttransfers\.co\.uk/);
    assert.match(savedPage, /Changes do not affect estimates, bookings, invoices, notifications, or customer charges/);
    assert.doesNotMatch(savedPage, /active rate|customer charge total/i);

    const lezPage = await (await fetch(`${baseUrl}${londonBase}/london-lez/fee-settings`, { headers })).text();
    assert.match(lezPage, /id="london-fee-amount-lez-vans-specialist-minibuses"[\s\S]*?value="100\.00"/);
    assert.match(lezPage, /name="baseVersion" value="1"/);

    const deniedCookie = `sid=fee-schedules-denied; ${ulezCookie}`;
    sessionsByCookie.set(deniedCookie, {
      authenticated: true,
      user: { id: "u-2", email: "admin@example.com", roles: ["admin"], active_role: "admin" }
    });
    const deniedForm = new URLSearchParams({ _csrf: token, baseVersion: "1" });
    for (const rate of londonFeeScheduleDrafts["london-ulez"].rates) {
      deniedForm.set(`amount_${rate.key}`, rate.amount.toFixed(2));
    }
    const deniedSave = await fetch(`${baseUrl}${updatePath}`, {
      method: "POST",
      headers: { cookie: deniedCookie, "content-type": "application/x-www-form-urlencoded" },
      body: deniedForm,
      redirect: "manual"
    });
    assert.equal(deniedSave.status, 403);
  });

  test("Dartford and shared Blackwall/Silvertown schedules keep supplied crossing rates and inactive versioned forms", async () => {
    feeSchedules.reset();
    const cookie = "sid=crossing-fees";
    const headers = withSession(cookie, ["superuser"]);
    const dartfordPath = "/settings/toll-fees/dartford-crossing/fee-settings";
    const dartfordResponse = await fetch(`${baseUrl}${dartfordPath}`, { headers });
    const dartfordBody = await dartfordResponse.text();
    assert.equal(dartfordResponse.status, 200);
    const dartford = crossingFeeScheduleDrafts["dartford-crossing"];
    assert.equal(dartford.status, "draft_inactive");
    assert.equal(dartford.active, false);
    assert.equal(dartford.bookingPriceUsage, "never");
    assert.deepEqual(dartford.rates.map((rate) => [rate.vehicleClass, rate.paymentMethod, rate.amount]), [
      ["Class A", "One-off payment", "0.00"], ["Class A", "Pay as you go", "0.00"], ["Class A", "Pre-pay", "0.00"],
      ["Class B", "One-off payment", "3.50"], ["Class B", "Pay as you go", "3.50"], ["Class B", "Pre-pay", "2.80"],
      ["Class C", "One-off payment", "4.20"], ["Class C", "Pay as you go", "4.20"], ["Class C", "Pre-pay", "3.60"],
      ["Class D", "One-off payment", "8.40"], ["Class D", "Pay as you go", "8.40"], ["Class D", "Pre-pay", "7.20"]
    ]);
    assert.match(dartfordBody, /Dartford Crossing draft schedule/);
    assert.match(dartfordBody, /Draft \/ Inactive — not used for booking prices/);
    assert.match(dartfordBody, /Changes do not affect estimates, bookings, invoices, notifications, or customer charges/);
    assert.match(dartfordBody, /Saving records a new history version; this schedule cannot be activated here/);
    assert.doesNotMatch(dartfordBody, /Current draft amount/);
    assert.match(dartfordBody, /06:00–22:00 UK local time every day, including weekends and bank holidays/);
    assert.match(dartfordBody, /free from 22:00 to 06:00 UK local time/);
    assert.match(dartfordBody, /droppable axles whether raised or lowered/);
    assert.match(dartfordBody, /trailer axles only/);
    assert.match(dartfordBody, /https:\/\/www\.gov\.uk\/pay-dartford-crossing-charge\/charges/);
    assert.match(dartfordBody, /vehicle is checked automatically/);
    assert.match(dartfordBody, /£25 for unlimited crossings or £12\.50 for 50 crossings/);
    assert.match(dartfordBody, /Effective date<\/dt><dd>Unknown \/ unverified/);
    assert.match(dartfordBody, /this schedule cannot be activated here/);
    for (const rate of dartford.rates) {
      const rateCard = dartfordBody.match(new RegExp(`<fieldset class="london-fee-draft__rate">[\\s\\S]*?name="amount_${rate.key}"[\\s\\S]*?</fieldset>`))?.[0];
      assert.ok(rateCard, `rate card should include ${rate.key}`);
      assert.ok(rateCard.includes(`<legend>${rate.vehicleClass} — ${rate.paymentMethod}</legend>`));
      assert.match(rateCard, new RegExp(`<label for="london-fee-amount-${rate.key}">Amount \\(GBP per crossing\\)<\\/label>`));
      assert.match(rateCard, new RegExp(`id="london-fee-amount-${rate.key}"[\\s\\S]*?name="amount_${rate.key}"[\\s\\S]*?value="${rate.amount}"`));
      assert.match(rateCard, /<summary>Rate conditions<\/summary>/);
      assert.ok(rateCard.includes(rate.chargingPeriod));
      assert.ok(rateCard.includes(rate.applicability));
      assert.ok(rateCard.includes(rate.crossingBasis));
    }

    const tunnelPath = "/settings/toll-fees/blackwall-silvertown-tunnels/fee-settings";
    const tunnelResponse = await fetch(`${baseUrl}${tunnelPath}`, { headers });
    const tunnelBody = await tunnelResponse.text();
    assert.equal(tunnelResponse.status, 200);
    const tunnels = crossingFeeScheduleDrafts["blackwall-silvertown-tunnels"];
    assert.equal(tunnels.status, "draft_inactive");
    assert.equal(tunnels.active, false);
    assert.equal(tunnels.bookingPriceUsage, "never");
    assert.deepEqual(tunnels.rates.map((rate) => [rate.vehicleClass, rate.paymentMethod, rate.amount]), [
      ["Motorcycles, mopeds, motor tricycles", "Auto Pay off-peak", "1.55"],
      ["Motorcycles, mopeds, motor tricycles", "Auto Pay peak", "2.60"],
      ["Motorcycles, mopeds, motor tricycles", "Phone/online", "2.60"],
      ["Cars and small vans", "Auto Pay off-peak", "1.55"],
      ["Cars and small vans", "Auto Pay peak", "4.20"],
      ["Cars and small vans", "Phone/online", "4.20"],
      ["Large vans", "Auto Pay off-peak", "2.60"],
      ["Large vans", "Auto Pay peak", "6.80"],
      ["Large vans", "Phone/online", "6.80"],
      ["Heavy goods vehicles", "Auto Pay off-peak", "5.25"],
      ["Heavy goods vehicles", "Auto Pay peak", "10.50"],
      ["Heavy goods vehicles", "Phone/online", "10.50"]
    ]);
    assert.match(tunnelBody, /Blackwall and Silvertown tunnels draft schedule/);
    assert.match(tunnelBody, /Draft \/ Inactive — not used for booking prices/);
    assert.match(tunnelBody, /Changes do not affect estimates, bookings, invoices, notifications, or customer charges/);
    assert.match(tunnelBody, /One shared charging schedule covers Blackwall and Silvertown tunnels/);
    assert.match(tunnelBody, /each crossing must retain its actual tunnel identity \(Blackwall or Silvertown\)/);
    assert.match(tunnelBody, /per crossing, in either direction/);
    assert.match(tunnelBody, /06:00–22:00 UK local time every day except Christmas Day \(25 December\)/);
    assert.match(tunnelBody, /Weekdays: northbound 06:00–10:00; southbound 16:00–19:00/);
    assert.match(tunnelBody, /Off-peak applies at other chargeable times and throughout weekends/);
    assert.match(tunnelBody, /Off-peak rates are available only with Auto Pay/);
    assert.match(tunnelBody, /Without Auto Pay, the peak\/phone-or-online rate applies at all chargeable times/);
    assert.match(tunnelBody, /Monday–Friday bank holidays is unresolved and is not assumed/);
    assert.match(tunnelBody, /Vehicle-category mapping is unresolved and is not inferred/);
    assert.match(tunnelBody, /No source URL, licence, verification date, or effective date was supplied/);
    assert.match(tunnelBody, /source URL not provided/);
    assert.match(tunnelBody, /URL not provided; unknown/);
    assert.match(tunnelBody, /small vans/);
    assert.match(tunnelBody, /large vans/);
    assert.match(tunnelBody, /Eligible residents on certain benefits, sole traders, small businesses and charities may qualify/);
    assert.match(tunnelBody, /some vehicles may be exempt or receive 100% discount/);
    assert.doesNotMatch(tunnelBody, /£180|£90|PCN|penalt/i);
    for (const rate of tunnels.rates) {
      const rateCard = tunnelBody.match(new RegExp(`<fieldset class="london-fee-draft__rate">[\\s\\S]*?name="amount_${rate.key}"[\\s\\S]*?</fieldset>`))?.[0];
      assert.ok(rateCard, `rate card should include ${rate.key}`);
      assert.ok(rateCard.includes(`<legend>${rate.vehicleClass} — ${rate.paymentMethod}</legend>`));
      assert.match(rateCard, new RegExp(`<label for="london-fee-amount-${rate.key}">Amount \\(GBP per crossing\\)<\\/label>`));
      assert.match(rateCard, new RegExp(`id="london-fee-amount-${rate.key}"[\\s\\S]*?name="amount_${rate.key}"[\\s\\S]*?value="${rate.amount}"`));
      assert.match(rateCard, /<summary>Rate conditions<\/summary>/);
      assert.ok(rateCard.includes(rate.chargingPeriod));
      assert.ok(rateCard.includes(rate.applicability));
      assert.ok(rateCard.includes(rate.crossingBasis));
    }
    for (const rate of [...dartford.rates, ...tunnels.rates]) {
      assert.equal(rate.currency, "GBP");
      assert.equal(rate.crossingBasis.includes("Per individual crossing"), true);
    }

    const crossingMigration = MIGRATIONS.find((migration) => migration.id === "0023_crossing_fee_schedule_drafts");
    assert.ok(crossingMigration);
    assert.match(crossingMigration.sql, /'dartford-crossing', 'blackwall-silvertown-tunnels'/);
    assert.ok(crossingMigration.sql.includes(JSON.stringify(dartford)));
    assert.ok(crossingMigration.sql.includes(JSON.stringify(tunnels)));

    const dartfordCsrfCookie = dartfordResponse.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
    const token = dartfordBody.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(dartfordCsrfCookie);
    assert.ok(token);
    const postCookie = `${cookie}; ${dartfordCsrfCookie}`;
    sessionsByCookie.set(postCookie, {
      authenticated: true,
      user: { id: "u-1", email: "bookings@romanairporttransfers.co.uk", roles: ["superuser"], active_role: "superuser" }
    });
    const dartfordRateToEdit = dartford.rates.find((rate) => rate.key === "dartford-b-one-off");
    assert.ok(dartfordRateToEdit);
    const invalidForm = new URLSearchParams({ _csrf: token, baseVersion: "1" });
    for (const rate of dartford.rates) {
      invalidForm.set(`amount_${rate.key}`, rate.key === dartfordRateToEdit.key ? "3.501" : rate.amount);
    }
    const invalidSave = await fetch(`${baseUrl}${dartfordPath}`, {
      method: "POST",
      headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
      body: invalidForm,
      redirect: "manual"
    });
    assert.equal(invalidSave.status, 400);
    assert.match(await invalidSave.text(), /no more than 2 decimal places/);

    const validForm = new URLSearchParams({ _csrf: token, baseVersion: "1" });
    for (const rate of dartford.rates) {
      validForm.set(`amount_${rate.key}`, rate.key === dartfordRateToEdit.key ? "3.51" : rate.amount);
    }
    const savedDartford = await fetch(`${baseUrl}${dartfordPath}`, {
      method: "POST",
      headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
      body: validForm,
      redirect: "manual"
    });
    assert.equal(savedDartford.status, 303);
    assert.equal(savedDartford.headers.get("location"), `${dartfordPath}?saved=1`);
    const savedDartfordPage = await (await fetch(`${baseUrl}${dartfordPath}?saved=1`, { headers })).text();
    assert.match(savedDartfordPage, /Draft changes saved as version 2/);
    assert.match(savedDartfordPage, /value="3\.51"/);
    assert.match(savedDartfordPage, /<li><strong>Version 2<\/strong> — bookings@romanairporttransfers\.co\.uk/);

    const tunnelRateToEdit = tunnels.rates[0];
    const tunnelForm = new URLSearchParams({ _csrf: token, baseVersion: "1" });
    for (const rate of tunnels.rates) {
      tunnelForm.set(`amount_${rate.key}`, rate.key === tunnelRateToEdit.key ? "1.56" : rate.amount);
    }
    const savedTunnel = await fetch(`${baseUrl}${tunnelPath}`, {
      method: "POST",
      headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
      body: tunnelForm,
      redirect: "manual"
    });
    assert.equal(savedTunnel.status, 303);
    const savedTunnelPage = await (await fetch(`${baseUrl}${tunnelPath}?saved=1`, { headers })).text();
    assert.match(savedTunnelPage, /Draft changes saved as version 2/);
    assert.match(savedTunnelPage, /value="1\.56"/);
  });

  test("London LEZ boundary metadata, map configuration and data endpoint are protected", async () => {
    const cookie = "sid=london-lez-boundary";
    const headers = withSession(cookie, ["superuser"]);
    process.env.GOOGLE_MAPS_ENABLED = "true";
    process.env.GOOGLE_MAPS_BROWSER_API_KEY = "browser-key-for-test";

    const pageUrl = `${baseUrl}/settings/toll-fees/london-lez-ulez-congestion-charge/london-lez/reference-data`;
    const pageResponse = await fetch(pageUrl, { headers });
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /data-london-lez-map/);
    assert.match(page, /browser-key-for-test/);
    assert.match(page, /2021-10-26/);
    assert.match(page, /2007-11-13/);
    assert.match(page, /2026-10-31/);
    assert.match(page, /Powered by TfL Open Data/);
    assert.match(page, /EPSG:27700 \(British National Grid\)/);
    assert.match(page, /WGS 84 \(RFC 7946 longitude, latitude\)/);
    assert.match(page, /LEZ_Boundary_20211026_Shape_Files\.zip/);

    const dataUrl = `${baseUrl}/settings/toll-fees/london-lez-ulez-congestion-charge/london-lez/reference-data/boundary.json`;
    const ulezDataUrl = `${baseUrl}/settings/toll-fees/london-lez-ulez-congestion-charge/london-ulez/reference-data/boundary.json`;
    const dataResponse = await fetch(dataUrl, { headers });
    assert.equal(dataResponse.status, 200);
    assert.match(dataResponse.headers.get("cache-control") ?? "", /no-store/);
    const boundary = await dataResponse.json() as { type: string; features: Array<{ properties: { UNIQUE_ID: string } }> };
    assert.equal(boundary.type, "FeatureCollection");
    assert.equal(boundary.features.length, 22);

    const deniedHeaders = withSession("sid=london-lez-boundary-denied", ["admin"]);
    const deniedData = await fetch(dataUrl, { headers: deniedHeaders });
    assert.equal(deniedData.status, 403);
    assert.deepEqual(await deniedData.json(), { error: "System settings access is required." });

    const unauthenticatedData = await fetch(dataUrl, { headers: { cookie: "sid=london-lez-boundary-unknown" } });
    assert.equal(unauthenticatedData.status, 401);
    assert.deepEqual(await unauthenticatedData.json(), { error: "Authentication required." });

    const ulezPageUrl = `${baseUrl}/settings/toll-fees/london-lez-ulez-congestion-charge/london-ulez/reference-data`;
    const ulezPage = await (await fetch(ulezPageUrl, { headers })).text();
    assert.match(ulezPage, /data-london-ulez-map/);
    assert.match(ulezPage, /London ULEZ boundary preview/);
    assert.match(ulezPage, /data-boundary-url="[^"]*london-ulez\/reference-data\/boundary\.json"/);

    const ulezResponse = await fetch(ulezDataUrl, { headers });
    assert.equal(ulezResponse.status, 200);
    assert.match(ulezResponse.headers.get("cache-control") ?? "", /no-store/);
    const ulezBoundary = await ulezResponse.json() as {
      type: string;
      features: Array<{ properties: { UNIQUE_ID: string; "@id": string; DATASET: string; DATE_CREAT: string }; geometry: { type: string } }>;
    };
    assert.equal(ulezBoundary.type, "FeatureCollection");
    assert.equal(ulezBoundary.features.length, 22);
    assert.equal(new Set(ulezBoundary.features.map((feature) => feature.properties["@id"])).size, 22);
    assert.ok(ulezBoundary.features.every((feature) => feature.properties.DATASET === "Low Emission Zone"));
    assert.ok(ulezBoundary.features.every((feature) => feature.properties.DATE_CREAT === "20071113"));
    assert.equal(ulezBoundary.features.filter((feature) => feature.geometry.type === "Polygon").length, 21);
    assert.equal(ulezBoundary.features.filter((feature) => feature.geometry.type === "MultiPolygon").length, 1);

    const deniedUlezData = await fetch(ulezDataUrl, { headers: deniedHeaders });
    assert.equal(deniedUlezData.status, 403);
    assert.deepEqual(await deniedUlezData.json(), { error: "System settings access is required." });

    const unauthenticatedUlezData = await fetch(ulezDataUrl, { headers: { cookie: "sid=london-ulez-boundary-unknown" } });
    assert.equal(unauthenticatedUlezData.status, 401);
    assert.deepEqual(await unauthenticatedUlezData.json(), { error: "Authentication required." });
  });

  test("every Clean Air Zone and London scheme has reference data and fee settings destinations", () => {
    const caz = tollFeeCategories.find((category) => category.slug === "clean-air-zones");
    assert.deepEqual(
      caz?.areas?.map((area) => area.title),
      [
        "Bath",
        "Birmingham",
        "Bradford",
        "Bristol",
        "Portsmouth",
        "Sheffield",
        "Tyneside (Newcastle and Gateshead)"
      ]
    );

    const london = tollFeeCategories.find((category) => category.slug === "london-lez-ulez-congestion-charge");
    assert.deepEqual(
      london?.areas?.map((area) => area.title),
      ["London LEZ", "London ULEZ", "London Congestion Charge"]
    );

    const leaves = schemeLeaves().filter((leaf) => ["clean-air-zones", "london-lez-ulez-congestion-charge"].includes(leaf.categorySlug));
    assert.equal(leaves.length, 7 + 3, "Clean Air Zone and London destinations should be complete");
    assert.equal(new Set(schemeLeaves().map((leaf) => leaf.path)).size, schemeLeaves().length, "every scheme path must be unique");
  });

  test("London LEZ, ULEZ and Congestion Charge remain separate destinations", async () => {
    const headers = withSession("sid=london-separate", ["superuser"]);
    const londonPath = "/settings/toll-fees/london-lez-ulez-congestion-charge";
    const londonSchemes = [
      { title: "London LEZ", path: `${londonPath}/london-lez` },
      { title: "London ULEZ", path: `${londonPath}/london-ulez` },
      { title: "London Congestion Charge", path: `${londonPath}/london-congestion-charge` }
    ];

    for (const scheme of londonSchemes) {
      const body = await (await fetch(`${baseUrl}${scheme.path}`, { headers })).text();
      assert.ok(body.includes(scheme.title));
      for (const other of londonSchemes.filter((item) => item.title !== scheme.title)) {
        assert.ok(!body.includes(other.title), `${scheme.title} page must not mention ${other.title}`);
        assert.ok(!body.includes(`href="${other.path}`), `${scheme.title} page must not link to ${other.title}`);
      }
    }

    const combined = await fetch(`${baseUrl}${londonPath}/london-lez-ulez`, { headers });
    assert.equal(combined.status, 404, "a combined London destination must not exist");
  });

  test("London Congestion Charge reference data and fee settings are separate protected destinations", async () => {
    const headers = withSession("sid=congestion-charge", ["superuser"]);
    const basePath = "/settings/toll-fees/london-lez-ulez-congestion-charge/london-congestion-charge";
    process.env.GOOGLE_MAPS_ENABLED = "true";
    process.env.GOOGLE_MAPS_BROWSER_API_KEY = "browser-key-for-test";
    const referenceResponse = await fetch(`${baseUrl}${basePath}/reference-data`, { headers });
    const feesResponse = await fetch(`${baseUrl}${basePath}/fee-settings`, { headers });
    assert.equal(referenceResponse.status, 200);
    assert.equal(feesResponse.status, 200);
    const referenceBody = await referenceResponse.text();
    const feesBody = await feesResponse.text();
    assert.match(referenceBody, /London Congestion Charge boundary/);
    assert.match(referenceBody, /data-london-congestion-charge-map/);
    assert.match(referenceBody, /data-boundary-url="[^"]*london-congestion-charge\/reference-data\/boundary\.json"/);
    assert.match(referenceBody, /aria-labelledby="london-congestion-charge-preview-title"/);
    assert.match(referenceBody, /Both supplied Polygon features/);
    assert.match(referenceBody, /Unknown \(not provided\)/);
    assert.match(referenceBody, /does not calculate fees or charge customers/);
    assert.match(feesBody, /No fee schedule is configured/);
    assert.match(feesBody, /does not calculate fees or charge customers/);
    assert.doesNotMatch(feesBody, /boundary\.json|CLoCCS|SHAPE_AREA/);

    const dataResponse = await fetch(`${baseUrl}${basePath}/reference-data/boundary.json`, { headers });
    assert.equal(dataResponse.status, 200);
    assert.match(dataResponse.headers.get("cache-control") ?? "", /no-store/);
    const boundary = await dataResponse.json() as {
      type: string;
      features: Array<{ properties: Record<string, string | number>; geometry: { type: string } }>;
    };
    assert.equal(boundary.type, "FeatureCollection");
    assert.equal(boundary.features.length, 2);
    assert.ok(boundary.features.every((feature) => feature.geometry.type === "Polygon"));
    assert.deepEqual(boundary.features.map((feature) => feature.properties.OBJECTID), [1, 2]);

    const deniedHeaders = withSession("sid=congestion-charge-denied", ["admin"]);
    const deniedData = await fetch(`${baseUrl}${basePath}/reference-data/boundary.json`, { headers: deniedHeaders });
    assert.equal(deniedData.status, 403);
    assert.deepEqual(await deniedData.json(), { error: "System settings access is required." });
  });

  test("every Toll & Fees scheme destination is denied without the superuser role", async () => {
    const deniedHeaders = withSession("sid=caz-denied", ["admin", "staff", "tech_support"]);
    for (const scheme of schemeLeaves()) {
      const response = await fetch(`${baseUrl}${scheme.path}/fee-settings`, { headers: deniedHeaders, redirect: "manual" });
      assert.equal(response.status, 403, `${scheme.title} must be denied`);
    }

    const unauthenticated = await fetch(`${baseUrl}${schemeLeaves()[0].path}/reference-data`, {
      headers: { cookie: "sid=caz-unknown" },
      redirect: "manual"
    });
    assert.equal(unauthenticated.status, 302);
    assert.equal(unauthenticated.headers.get("location"), "/access");

    const airportDenied = await fetch(`${baseUrl}/settings/toll-fees/airport-fees`, {
      headers: deniedHeaders,
      redirect: "manual"
    });
    assert.equal(airportDenied.status, 403);
  });

  test("unrelated Toll & Fees destinations keep their category-level sections", async () => {
    const headers = withSession("sid=unrelated-toll", ["superuser"]);
    for (const slug of ["dartford-crossing", "blackwall-silvertown-tunnels"]) {
      const body = await (await fetch(`${baseUrl}/settings/toll-fees/${slug}/fee-settings`, { headers })).text();
      assert.match(body, new RegExp(`href="/settings/toll-fees/${slug}/reference-data"`));
      assert.equal((body.match(/class="toll-fees-subnav__item"/g) ?? []).length, 2);
      assert.equal((body.match(/aria-current="page"/g) ?? []).length, 2, "current item plus the selected subpage only");
    }
    const airportBody = await (await fetch(`${baseUrl}/settings/toll-fees/airport-fees`, { headers })).text();
    assert.doesNotMatch(airportBody, /toll-fees-subnav__item|Reference data \(managed\)|Fee settings/);
    assert.match(airportBody, /Add Airport and Fee/);
  });


  test("a session without the superuser role key is denied /settings with 403 even with every other role", async () => {
    const headers = withSession(
      "sid=no-superuser",
      BOOKINGS_ROLES.filter((role) => role !== "superuser")
    );

    const response = await fetch(`${baseUrl}/settings`, { headers, redirect: "manual" });

    assert.equal(response.status, 403);
    const body = await response.text();
    assert.match(body, /Unable to continue/);
    assert.match(body, /does not include the System Control role required for System settings/);
    assert.doesNotMatch(body, /\(superuser\)/);
    assert.doesNotMatch(body, /Access granted/);
  });

  test("display labels and case variants of superuser never grant /settings", async () => {
    for (const roles of [["System Control"], ["SUPERUSER"], [" superuser"], [{ key: "superuser" }], "superuser"]) {
      const headers = withSession(`sid=variant-${JSON.stringify(roles)}`, roles);
      const response = await fetch(`${baseUrl}/settings`, { headers, redirect: "manual" });
      assert.equal(response.status, 403, `roles ${JSON.stringify(roles)} must be denied`);
    }
  });

  test("unauthenticated sessions are redirected to /access", async () => {
    const response = await fetch(`${baseUrl}/settings`, { headers: { cookie: "sid=unknown" }, redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
  });

  test("Airport Fees preserves the System Settings authorization boundary and has no placeholder subpage", async () => {
    const destinationUrl = `${baseUrl}/settings/toll-fees/airport-fees`;
    const deniedHeaders = withSession("sid=nested-denied", ["admin", "staff", "tech_support"]);
    const deniedResponse = await fetch(destinationUrl, { headers: deniedHeaders, redirect: "manual" });
    assert.equal(deniedResponse.status, 403);
    assert.match(await deniedResponse.text(), /does not include the System Control role required for System settings/);

    const unauthenticatedResponse = await fetch(destinationUrl, { headers: { cookie: "sid=nested-unknown" }, redirect: "manual" });
    assert.equal(unauthenticatedResponse.status, 302);
    assert.equal(unauthenticatedResponse.headers.get("location"), "/access");
    const removedPlaceholder = await fetch(`${destinationUrl}/fee-settings`, { headers: withSession("sid=airport-old-path", ["superuser"]) });
    assert.equal(removedPlaceholder.status, 404);
  });

  test("other workspaces keep their own role requirements", async () => {
    const superuserOnly = withSession("sid=superuser-only", ["superuser"]);
    assert.equal((await fetch(`${baseUrl}/vps`, { headers: superuserOnly })).status, 200);
    assert.equal((await fetch(`${baseUrl}/tech-support`, { headers: superuserOnly })).status, 403);

    const adminOnly = withSession("sid=admin-only", ["admin"]);
    assert.equal((await fetch(`${baseUrl}/vps`, { headers: adminOnly })).status, 403);
    assert.equal((await fetch(`${baseUrl}/settings`, { headers: adminOnly })).status, 403);
  });

  test("grantingRoles matches role keys exactly", () => {
    const settings = workspaceModules.find((module) => module.key === "system-settings");
    assert.ok(settings);
    assert.deepEqual(grantingRoles(BOOKINGS_ROLES, settings), ["superuser"]);
    assert.deepEqual(grantingRoles(["System Control", "Superuser"], settings), []);
  });

  test("Fare Settings navigation lists all five categories and future categories are clear placeholders", async () => {
    fareSettings.reset();
    const headers = withSession("sid=fare-nav", ["superuser"]);
    const settingsBody = await (await fetch(`${baseUrl}/settings`, { headers })).text();
    assert.match(settingsBody, /href="\/settings\/fare-settings">Open Fare Settings/);

    const landingBody = await (await fetch(`${baseUrl}/settings/fare-settings`, { headers })).text();
    for (const category of fareSettingsCategories) {
      assert.match(landingBody, new RegExp(`href="/settings/fare-settings/${category.slug}"`));
      assert.match(landingBody, new RegExp(category.title));
    }

    for (const category of fareSettingsCategories.filter((item) => !item.configurable)) {
      const body = await (await fetch(`${baseUrl}/settings/fare-settings/${category.slug}`, { headers })).text();
      assert.match(body, /Configuration placeholder/);
      assert.match(body, /No fare rules or pricing behavior are configured here/);
    }
  });

  test("Fare surcharge setting validates, saves, disables, and retains its saved values", async () => {
    fareSettings.reset();
    const path = "/settings/fare-settings/fare-surcharge-settings";
    const sessionCookie = "sid=fare-daily";
    const initialBody = await (await fetch(`${baseUrl}${path}`, {
      headers: withSession(sessionCookie, ["superuser"])
    })).text();
    assert.match(initialBody, /name="dailyEnabled" value="yes"/);
    assert.match(initialBody, /name="dailyStartTime" type="time"/);
    assert.match(initialBody, /name="dailyEndTime" type="time"/);
    const postForm = async (version: string, values: Record<string, string>) => {
      const headers = withSession(sessionCookie, ["superuser"]);
      const page = await fetch(`${baseUrl}${path}`, { headers });
      const pageBody = await page.text();
      const csrfCookie = page.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
      const token = pageBody.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfCookie);
      assert.ok(token);
      const postCookie = `${sessionCookie}; ${csrfCookie}`;
      withSession(postCookie, ["superuser"]);
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          cookie: postCookie,
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ ...values, baseVersion: version, _csrf: token }),
        redirect: "manual"
      });
    };

    const invalid = await postForm("0", { dailyEnabled: "yes" });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /Enter a valid non-negative percentage/);
    assert.equal(fareSettings.snapshot().currentVersion, 0);

    const enabled = await postForm("0", {
      dailyEnabled: "yes",
      dailyPercentage: "12.5",
      dailyStartTime: "23:00",
      dailyEndTime: "06:00"
    });
    assert.equal(enabled.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.dailySurcharge, {
      enabled: true,
      percentage: "12.5",
      startTime: "23:00",
      endTime: "06:00"
    });

    const stale = await postForm("0", { dailyEnabled: "no" });
    assert.equal(stale.status, 409);
    assert.match(await stale.text(), /changed after the form was opened/);
    assert.equal(fareSettings.snapshot().history.length, 1);

    const disabled = await postForm("1", { dailyEnabled: "no" });
    assert.equal(disabled.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.dailySurcharge, {
      enabled: false,
      percentage: "12.5",
      startTime: "23:00",
      endTime: "06:00"
    });
    assert.equal(fareSettings.snapshot().history.length, 2);
  });

  test("Bank holiday fare settings save, edit, and remove explicit periods with precedence recorded", async () => {
    fareSettings.reset();
    const path = "/settings/fare-settings/bank-holiday-fare-settings";
    const sessionCookie = "sid=fare-bank";
    const initialBody = await (await fetch(`${baseUrl}${path}`, {
      headers: withSession(sessionCookie, ["superuser"])
    })).text();
    assert.match(initialBody, /Add surcharge period/);
    assert.match(initialBody, /type="datetime-local"/);
    assert.match(initialBody, /name="periodsSubmitted" value="yes"/);
    const postForm = async (version: string, values: Record<string, string>) => {
      const headers = withSession(sessionCookie, ["superuser"]);
      const page = await fetch(`${baseUrl}${path}`, { headers });
      const pageBody = await page.text();
      const csrfCookie = page.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
      const token = pageBody.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfCookie);
      assert.ok(token);
      const postCookie = `${sessionCookie}; ${csrfCookie}`;
      withSession(postCookie, ["superuser"]);
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          cookie: postCookie,
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ ...values, baseVersion: version, _csrf: token }),
        redirect: "manual"
      });
    };

    const saved = await postForm("0", {
      bankHolidayEnabled: "yes",
      "periods[0][label]": "Christmas/Boxing Day period",
      "periods[0][startDateTime]": "2026-12-24T18:00",
      "periods[0][endDateTime]": "2026-12-27T06:00",
      "periods[0][percentage]": "35",
      "periods[1][label]": "New Year period",
      "periods[1][startDateTime]": "2026-12-31T18:00",
      "periods[1][endDateTime]": "2027-01-02T06:00",
      "periods[1][percentage]": "40"
    });
    assert.equal(saved.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.bankHolidaySurcharge, {
      enabled: true,
      periods: [
        {
          label: "Christmas/Boxing Day period",
          startDateTime: "2026-12-24T18:00",
          endDateTime: "2026-12-27T06:00",
          percentage: "35"
        },
        {
          label: "New Year period",
          startDateTime: "2026-12-31T18:00",
          endDateTime: "2027-01-02T06:00",
          percentage: "40"
        }
      ]
    });
    assert.equal(fareSettings.snapshot().configuration.precedence, "bank-holiday-over-daily");

    const editedAndRemoved = await postForm("1", {
      bankHolidayEnabled: "no",
      "periods[0][label]": "Updated Christmas period",
      "periods[0][startDateTime]": "2026-12-24T19:00",
      "periods[0][endDateTime]": "2026-12-27T06:00",
      "periods[0][percentage]": "36"
    });
    assert.equal(editedAndRemoved.status, 303);
    assert.equal(fareSettings.snapshot().configuration.bankHolidaySurcharge.enabled, false);
    assert.deepEqual(fareSettings.snapshot().configuration.bankHolidaySurcharge.periods, [{
      label: "Updated Christmas period",
      startDateTime: "2026-12-24T19:00",
      endDateTime: "2026-12-27T06:00",
      percentage: "36"
    }]);
    const removed = await postForm("2", {
      bankHolidayEnabled: "no",
      periodsSubmitted: "yes"
    });
    assert.equal(removed.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.bankHolidaySurcharge.periods, []);
    assert.equal(fareSettings.snapshot().history.length, 3);

    const savedPage = await fetch(`${baseUrl}${path}`, { headers: withSession(sessionCookie, ["superuser"]) });
    const savedBody = await savedPage.text();
    assert.match(savedBody, /that period's surcharge takes precedence; it is not combined with the daily surcharge/);
    assert.match(savedBody, /Configuration history/);
  });

  test("Fare Settings remains restricted to superuser sessions", async () => {
    const denied = await fetch(`${baseUrl}/settings/fare-settings/fare-surcharge-settings`, {
      headers: withSession("sid=fare-denied", ["admin", "staff", "tech_support"]),
      redirect: "manual"
    });
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /does not include the System Control role required for System settings/);
    const anonymous = await fetch(`${baseUrl}/settings/fare-settings`, {
      headers: { cookie: "sid=fare-anonymous" },
      redirect: "manual"
    });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get("location"), "/access");
  });
});
