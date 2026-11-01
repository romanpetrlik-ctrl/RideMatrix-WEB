import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import { londonFeeScheduleDrafts } from "../services/london-fee-schedule-data";
import type {
  LondonFeeScheduleActor,
  LondonFeeScheduleScheme,
  LondonFeeScheduleSnapshot,
  LondonFeeScheduleStore
} from "../services/london-fee-schedules";
import { createRoleSectionsRouter, grantingRoles, tollFeeCategories, workspaceModules } from "./role-sections";

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
  return tollFeeCategories.flatMap((category) => {
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

function createMemoryFeeScheduleStore(): { store: LondonFeeScheduleStore; reset: () => void } {
  const snapshots = new Map<LondonFeeScheduleScheme, LondonFeeScheduleSnapshot>();
  const reset = () => {
    snapshots.clear();
    for (const scheme of ["london-lez", "london-ulez"] as const) {
      snapshots.set(scheme, {
        schedule: structuredClone(londonFeeScheduleDrafts[scheme]),
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
        snapshots.set(scheme, {
          schedule: {
            ...current.schedule,
            rates: current.schedule.rates.map((rate) => ({ ...rate, amount: Number(amounts[rate.key]) }))
          },
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
    app.use(createRoleSectionsRouter({ appTitle: "RideMatrix Test", feeScheduleStore: feeSchedules.store }));
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
          assert.match(destinationBody, /£12\.50/);
          assert.match(destinationBody, /Euro 6 \(NOx and PM\)/);
          assert.match(destinationBody, /Unknown \/ unverified; not supplied/);
          assert.match(destinationBody, /Source: Cars/);
          assert.match(destinationBody, /cars\?intcmp=52215/);
          assert.doesNotMatch(destinationBody, /data-london-ulez-map|DATE_CREAT|boundary\.json/);
        } else if (scheme.title === "London LEZ" && destination.path === "fee-settings") {
          assert.match(destinationBody, /Draft \/ Inactive — not used for booking prices/);
          assert.match(destinationBody, /£100\.00/);
          assert.match(destinationBody, /£300\.00/);
          assert.match(destinationBody, /Euro 3/);
          assert.match(destinationBody, /Euro IV \(PM\)/);
          assert.match(destinationBody, /source URL was not supplied/);
          assert.match(destinationBody, /Unknown \/ unverified; not supplied/);
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

  test("London LEZ and ULEZ drafts are distinct, inactive, editable, and retain append-only form history", async () => {
    feeSchedules.reset();
    const headers = withSession("sid=fee-schedules", ["superuser"]);
    const londonBase = "/settings/toll-fees/london-lez-ulez-congestion-charge";
    const lezResponse = await fetch(`${baseUrl}${londonBase}/london-lez/fee-settings`, { headers });
    const lezBody = await lezResponse.text();
    assert.equal(lezResponse.status, 200);
    assert.match(lezBody, /£100\.00/);
    assert.match(lezBody, /£300\.00/);
    assert.match(lezBody, /Cars and motorcycles\/L-category vehicles/);
    assert.match(lezBody, /Small vans up to and including 1\.205 tonnes unladen/);
    assert.match(lezBody, /Draft \/ Inactive — not used for booking prices/);

    const ulezResponse = await fetch(`${baseUrl}${londonBase}/london-ulez/fee-settings`, { headers });
    const ulezBody = await ulezResponse.text();
    assert.equal(ulezResponse.status, 200);
    assert.match(ulezBody, /£12\.50/);
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
    assert.match(savedPage, /isolated from route estimates, booking totals, invoices, notifications, and customer charges/);
    assert.doesNotMatch(savedPage, /Activate|active rate|customer charge total/i);

    const lezPage = await (await fetch(`${baseUrl}${londonBase}/london-lez/fee-settings`, { headers })).text();
    assert.match(lezPage, /Current draft rate:<\/strong> £100\.00/);
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
  });

  test("unrelated Toll & Fees destinations keep their category-level sections", async () => {
    const headers = withSession("sid=unrelated-toll", ["superuser"]);
    for (const slug of ["airport-fees", "dartford-crossing", "blackwall-silvertown-tunnels"]) {
      const body = await (await fetch(`${baseUrl}/settings/toll-fees/${slug}/fee-settings`, { headers })).text();
      assert.match(body, new RegExp(`href="/settings/toll-fees/${slug}/reference-data"`));
      assert.equal((body.match(/class="toll-fees-subnav__item"/g) ?? []).length, 2);
      assert.equal((body.match(/aria-current="page"/g) ?? []).length, 2, "current item plus the selected subpage only");
    }
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

  test("nested Toll & Fees pages preserve the System Settings authorization boundary", async () => {
    const destinationUrl = `${baseUrl}/settings/toll-fees/airport-fees/fee-settings`;
    const deniedHeaders = withSession("sid=nested-denied", ["admin", "staff", "tech_support"]);
    const deniedResponse = await fetch(destinationUrl, { headers: deniedHeaders, redirect: "manual" });
    assert.equal(deniedResponse.status, 403);
    assert.match(await deniedResponse.text(), /does not include the System Control role required for System settings/);

    const unauthenticatedResponse = await fetch(destinationUrl, { headers: { cookie: "sid=nested-unknown" }, redirect: "manual" });
    assert.equal(unauthenticatedResponse.status, 302);
    assert.equal(unauthenticatedResponse.headers.get("location"), "/access");
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
});
