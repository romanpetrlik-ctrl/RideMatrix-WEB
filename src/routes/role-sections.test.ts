import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
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
import type {
  PoiFeeFormValues,
  PoiFeeRecord,
  PoiFormValues,
  PoiManagementActor,
  PoiManagementStore,
  PoiRecord
} from "../services/poi-management";
import {
  crossingFeeScheduleDrafts,
  londonFeeScheduleDrafts
} from "../services/london-fee-schedule-data";
import {
  LondonFeeScheduleVersionConflictError,
  roadChargeScheduleRecord,
  type LondonFeeScheduleActor,
  type LondonFeeScheduleScheme,
  type LondonFeeScheduleSnapshot,
  type LondonFeeScheduleStore
} from "../services/london-fee-schedules";
import {
  applyRoadChargeActivation,
  applyRoadChargeEdit,
  isRoadChargeSchedule,
  roadChargeScheduleSeeds
} from "../services/road-charge-schedules";
import {
  EMPTY_FARE_SETTINGS,
  FareSettingsVersionConflictError,
  matchesMinimumFareRule,
  type FareSettingsActor,
  type FareSettingsConfiguration,
  type FareSettingsSnapshot,
  type FareSettingsStore
} from "../services/fare-settings";
import {
  RECENT_CONFIGURATION_HISTORY_LIMIT,
  resolveHistoryPage,
  type ConfigurationHistoryEntry
} from "../services/configuration-history";
import type { OperationalBase } from "../services/dead-mileage";
import {
  createRoleSectionsRouter,
  fareSettingsCategories,
  grantingRoles,
  tollFeeCategories,
  workspaceModules
} from "./role-sections";
import { createPoiManagementRouter } from "./poi-management";

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

function createMemoryPoiManagementStore(): {
  store: PoiManagementStore;
  reset: () => void;
  pois: PoiRecord[];
  fees: PoiFeeRecord[];
} {
  const pois: PoiRecord[] = [];
  const fees: PoiFeeRecord[] = [];
  let nextPoiId = 1;
  let nextFeeId = 1;
  const reset = () => {
    pois.splice(0, pois.length);
    fees.splice(0, fees.length);
    nextPoiId = 1;
    nextFeeId = 1;
  };
  const toPoi = (id: string, values: PoiFormValues): PoiRecord => ({
    id,
    displayName: values.displayName,
    category: values.category,
    placeId: values.placeId,
    locationLabel: values.locationLabel,
    latitude: Number(values.latitude),
    longitude: Number(values.longitude),
    notes: values.notes,
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z"
  });
  return {
    pois,
    fees,
    reset,
    store: {
      async listPois() {
        return structuredClone(pois);
      },
      async getPoi(id) {
        const poi = pois.find((item) => item.id === id);
        return poi ? structuredClone(poi) : null;
      },
      async savePoi(id: string | null, values: PoiFormValues, _actor: PoiManagementActor) {
        if (id) {
          const index = pois.findIndex((item) => item.id === id);
          if (index < 0) return null;
          pois[index] = toPoi(id, values);
          return structuredClone(pois[index]);
        }
        const poi = toPoi(`poi-${nextPoiId++}`, values);
        pois.push(poi);
        return structuredClone(poi);
      },
      async deletePoi(id, _actor) {
        const index = pois.findIndex((item) => item.id === id);
        if (index < 0) return "not-found";
        if (fees.some((fee) => fee.poiId === id)) return "has-fees";
        pois.splice(index, 1);
        return "deleted";
      },
      async listFees() {
        return structuredClone(fees);
      },
      async getFee(id) {
        const fee = fees.find((item) => item.id === id);
        return fee ? structuredClone(fee) : null;
      },
      async saveFee(id: string | null, values: PoiFeeFormValues, _actor: PoiManagementActor) {
        const poi = pois.find((item) => item.id === values.poiId);
        if (!poi) return null;
        const record: PoiFeeRecord = {
          id: id ?? `fee-${nextFeeId++}`,
          poiId: poi.id,
          poiDisplayName: poi.displayName,
          action: values.action,
          amount: values.amount,
          currency: "GBP",
          feeBasis: values.feeBasis,
          trigger: values.trigger as "selection" | "confirmation",
          notes: values.notes,
          createdAt: "2026-11-15T00:00:00.000Z",
          updatedAt: "2026-11-15T00:00:00.000Z"
        };
        if (id) {
          const index = fees.findIndex((item) => item.id === id);
          if (index < 0) return null;
          fees[index] = record;
          return structuredClone(record);
        }
        fees.push(record);
        return structuredClone(record);
      },
      async deleteFee(id, _actor) {
        const index = fees.findIndex((item) => item.id === id);
        if (index < 0) return false;
        fees.splice(index, 1);
        return true;
      }
    }
  };
}

/** Mirrors the PostgreSQL stores: callers only receive the recent entries plus a total count. */
function recentHistory<T extends { history: ConfigurationHistoryEntry[] }>(state: T): T & { historyTotal: number } {
  return {
    ...structuredClone(state),
    history: structuredClone(state.history.slice(0, RECENT_CONFIGURATION_HISTORY_LIMIT)),
    historyTotal: state.history.length
  };
}

function historyPage(history: ConfigurationHistoryEntry[], requestedPage: number, perPage?: number) {
  const page = resolveHistoryPage(requestedPage, history.length, perPage);
  return {
    entries: structuredClone(history.slice(page.offset, page.offset + page.perPage)),
    page: page.page,
    perPage: page.perPage,
    totalPages: page.totalPages,
    totalRecords: history.length
  };
}

/** Builds newest-first history entries for versions count..1. */
function seededHistory(count: number, actorEmail = "history@example.com"): ConfigurationHistoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    version: count - index,
    actorEmail,
    createdAt: "2026-11-01T00:00:00.000Z"
  }));
}

function createMemoryFeeScheduleStore(): {
  store: LondonFeeScheduleStore;
  reset: () => void;
  seedHistory: (scheme: LondonFeeScheduleScheme, count: number) => void;
  history: (scheme: LondonFeeScheduleScheme) => ConfigurationHistoryEntry[];
  current: (scheme: LondonFeeScheduleScheme) => Omit<LondonFeeScheduleSnapshot, "historyTotal">;
} {
  // Mirrors the database after migration 0035: structured inactive schedules for the four road-charge schemes
  // (version 2 on top of the legacy draft, version 1 for the Congestion Charge) and the legacy Dartford draft.
  const snapshots = new Map<LondonFeeScheduleScheme, Omit<LondonFeeScheduleSnapshot, "historyTotal">>();
  const reset = () => {
    snapshots.clear();
    snapshots.set("dartford-crossing", {
      schedule: structuredClone(crossingFeeScheduleDrafts["dartford-crossing"]),
      status: "draft_inactive",
      currentVersion: 1,
      history: [{ version: 1, actorEmail: "Initial supplied draft", createdAt: "2026-11-01T00:00:00.000Z" }]
    });
    for (const scheme of ["london-lez", "london-ulez", "london-congestion-charge", "blackwall-silvertown-tunnels"] as const) {
      const hasLegacy = scheme !== "london-congestion-charge";
      const version = hasLegacy ? 2 : 1;
      snapshots.set(scheme, {
        schedule: { ...structuredClone(roadChargeScheduleSeeds[scheme]), supersedesLegacyDraftVersion: hasLegacy ? 1 : null },
        status: "inactive",
        currentVersion: version,
        history: [
          { version, actorEmail: "System migration: structured road-charge schedule (inactive)", createdAt: "2026-11-01T00:00:00.000Z" },
          ...(hasLegacy ? [{ version: 1, actorEmail: "Initial supplied draft", createdAt: "2026-11-01T00:00:00.000Z" }] : [])
        ]
      });
    }
  };
  reset();

  const append = (scheme: LondonFeeScheduleScheme, schedule: LondonFeeScheduleSnapshot["schedule"], status: string, actor: LondonFeeScheduleActor) => {
    const current = snapshots.get(scheme);
    assert.ok(current);
    snapshots.set(scheme, {
      schedule,
      status,
      currentVersion: current.currentVersion + 1,
      history: [
        { version: current.currentVersion + 1, actorEmail: actor.email, createdAt: "2026-11-01T00:01:00.000Z" },
        ...current.history
      ]
    });
  };
  const locked = (scheme: LondonFeeScheduleScheme, expectedVersion: number) => {
    const current = snapshots.get(scheme);
    assert.ok(current);
    if (current.currentVersion !== expectedVersion) throw new LondonFeeScheduleVersionConflictError();
    return current;
  };

  return {
    reset,
    seedHistory(scheme, count) {
      const current = snapshots.get(scheme);
      assert.ok(current);
      snapshots.set(scheme, { ...current, currentVersion: count, history: seededHistory(count) });
    },
    history: (scheme) => structuredClone(snapshots.get(scheme)?.history ?? []),
    current: (scheme) => structuredClone(snapshots.get(scheme)!),
    store: {
      async load(scheme) {
        const snapshot = snapshots.get(scheme);
        assert.ok(snapshot);
        return recentHistory(snapshot);
      },
      async loadHistoryPage(scheme, page, perPage) {
        const snapshot = snapshots.get(scheme);
        assert.ok(snapshot);
        return historyPage(snapshot.history, page, perPage);
      },
      async save(scheme, expectedVersion, amounts, actor: LondonFeeScheduleActor, effectiveDates) {
        const current = locked(scheme, expectedVersion);
        if (isRoadChargeSchedule(current.schedule)) {
          append(scheme, applyRoadChargeEdit(current.schedule, {
            amounts,
            effectiveFrom: effectiveDates ? effectiveDates.effectiveFrom : current.schedule.effectiveFrom,
            effectiveUntil: effectiveDates ? effectiveDates.effectiveUntil : current.schedule.effectiveUntil
          }), "inactive", actor);
          return;
        }
        const schedule = current.schedule.kind === "crossing"
          ? {
            ...current.schedule,
            rates: current.schedule.rates.map((rate) => ({ ...rate, amount: amounts[rate.key] }))
          }
          : {
            ...current.schedule,
            rates: current.schedule.rates.map((rate) => ({ ...rate, amount: Number(amounts[rate.key]) }))
          };
        append(scheme, schedule, "draft_inactive", actor);
      },
      async setActivation(scheme, expectedVersion, request, actor, now) {
        const current = locked(scheme, expectedVersion);
        assert.ok(isRoadChargeSchedule(current.schedule), "legacy drafts cannot be activated");
        const next = applyRoadChargeActivation(current.schedule, request, actor, now);
        append(scheme, next, next.status, actor);
      },
      async loadPricingSchedules() {
        return Object.fromEntries([...snapshots.entries()].flatMap(([scheme, snapshot]) => {
          const record = roadChargeScheduleRecord(scheme, snapshot.currentVersion, snapshot.status, snapshot.schedule);
          return record ? [[scheme, record]] : [];
        }));
      }
    }
  };
}

function createMemoryFareSettingsStore(): {
  store: FareSettingsStore;
  reset: () => void;
  seedHistory: (count: number) => void;
  /** The full internal state, including every history entry (newest first). */
  snapshot: () => Omit<FareSettingsSnapshot, "historyTotal">;
} {
  let state: Omit<FareSettingsSnapshot, "historyTotal">;
  const reset = () => {
    state = { configuration: structuredClone(EMPTY_FARE_SETTINGS), currentVersion: 0, history: [] };
  };
  reset();
  return {
    reset,
    seedHistory(count) {
      state = { ...state, currentVersion: count, history: seededHistory(count) };
    },
    snapshot: () => structuredClone(state),
    store: {
      async load() {
        return recentHistory(state);
      },
      async loadHistoryPage(page, perPage) {
        return historyPage(state.history, page, perPage);
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
  const poiManagement = createMemoryPoiManagementStore();
  const fareSettings = createMemoryFareSettingsStore();
  let operationalBase: OperationalBase | null = {
    operatorId: "test-operator",
    latitude: 50.71,
    longitude: -2.44,
    providerPlaceId: "verified-operational-point",
    coordinatesVerified: true,
    updatedAt: "2026-11-10T12:00:00.000Z"
  };

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
        const requestCookie = req.headers.cookie ?? "";
        const sessionCookie = requestCookie.split(";")[0].trim();
        const session = sessionsByCookie.get(requestCookie) ?? sessionsByCookie.get(sessionCookie) ?? { authenticated: false };
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
      fareSettingsStore: fareSettings.store,
      poiManagementStore: poiManagement.store,
      loadOperationalBase: async () => operationalBase
    }));
    app.use(createPoiManagementRouter({ appTitle: "RideMatrix Test", store: poiManagement.store }));
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
    assert.match(body, /href="\/settings\/pois">Manage POIs/);
    assert.match(body, /href="\/settings\/poi-fees">Manage POI Fees/);
    assert.doesNotMatch(body, /Unable to continue/);
  });

  test("Toll & Fees and every category destination are reachable with clear placeholders", async () => {
    const headers = withSession("sid=toll-fees", ["superuser"]);
    const categoryResponse = await fetch(`${baseUrl}/settings/toll-fees`, { headers });
    assert.equal(categoryResponse.status, 200);
    const categoryBody = await categoryResponse.text();
    assert.match(categoryBody, /<h1>Toll & Fees<\/h1>/);
    assert.match(categoryBody, /Fee schedules are used only when active/);
    assert.match(categoryBody, /The Dartford schedule remains an inactive draft/);
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
          assert.match(destinationBody, /Verification<\/dt><dd>2026-11-19/);
          assert.match(destinationBody, /Map preview unavailable/);
          assert.doesNotMatch(destinationBody, /Not configured yet/);
        } else if (
          ["London LEZ", "London ULEZ", "London Congestion Charge", "Blackwall & Silvertown tunnels"].includes(scheme.title)
          && destination.path === "fee-settings"
        ) {
          assert.match(destinationBody, /Inactive — not used for booking prices/);
          assert.match(destinationBody, /While inactive, New Booking quotes that enter this scheme show the charge as unresolved/);
          assert.match(destinationBody, /Rules, sources and verification/);
          assert.doesNotMatch(destinationBody, /data-london-ulez-map|DATE_CREAT|boundary\.json/);
        } else if (scheme.title === "Dartford Crossing" && destination.path === "fee-settings") {
          assert.match(destinationBody, /Draft \/ Inactive — not used for booking prices/);
        } else {
          assert.match(destinationBody, /Not configured yet/);
        }
        const selectedSubnav = destinationBody.match(/<a class="toll-fees-subnav__item"[^>]*aria-current="page"[^>]*>/g) ?? [];
        assert.equal(selectedSubnav.length, 1, "exactly one subpage should be marked as selected");
        assert.ok(selectedSubnav[0].includes(`${scheme.path}/${destination.path}`), "the selected subpage should match the current destination");
        if (destinationBody.includes("road-charge-schedule-title")) {
          assert.doesNotMatch(destinationBody, /Active — used for New Booking quotes/, "seeded schedules are not live");
        } else {
          assert.match(destinationBody, /does not (display maps, )?calculate fees, or charge customers|does not calculate fees or charge customers/);
        }
      }
    }
  });

  test("POI and POI Fees pages preserve the System Settings authorization boundary", async () => {
    const authorized = withSession("sid=poi-authorized", ["superuser"]);
    for (const [path, title] of [["/settings/pois", "POIs"], ["/settings/poi-fees", "POI Fees"]]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: authorized });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      const body = await response.text();
      assert.match(body, new RegExp(`<h1>${title}</h1>`));
      assert.match(body, /Configuration only/);
      assert.match(body, /not applied to booking prices, totals, customer charges, or payments/);
    }

    const denied = withSession("sid=poi-denied", ["admin", "staff", "tech_support"]);
    for (const path of ["/settings/pois", "/settings/poi-fees"]) {
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: denied, redirect: "manual" })).status, 403);
    }
    for (const path of ["/settings/pois", "/settings/poi-fees"]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { cookie: `sid=poi-unauthenticated-${path}` },
        redirect: "manual"
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/access");
    }
  });

  test("POIs save selected Places, edit and delete independently from multiple optional POI Fees", async () => {
    poiManagement.reset();
    const oldMapEnvironment = {
      enabled: process.env.GOOGLE_MAPS_ENABLED,
      browserKey: process.env.GOOGLE_MAPS_BROWSER_API_KEY
    };
    process.env.GOOGLE_MAPS_ENABLED = "true";
    process.env.GOOGLE_MAPS_BROWSER_API_KEY = "test-browser-key";
    const headers = withSession("sid=poi-crud", ["superuser"]);
    const sessionCookie = headers.cookie;
    const csrfFor = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`, { headers });
      assert.equal(response.status, 200);
      const body = await response.text();
      const csrfCookie = response.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
      const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfCookie);
      assert.ok(token);
      return { cookie: `${sessionCookie}; ${csrfCookie}`, token };
    };
    const postForm = async (path: string, values: Record<string, string>) => {
      const csrfPath = path.includes("/delete")
        ? (path.startsWith("/settings/pois/") ? "/settings/pois" : "/settings/poi-fees")
        : path;
      const csrf = await csrfFor(csrfPath);
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { cookie: csrf.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...values, _csrf: csrf.token }),
        redirect: "manual"
      });
    };

    try {
      const poiValues = {
        displayName: "Configured Hotel Name",
        category: "hotel",
        placeId: "ChIJ-operational-hotel",
        locationLabel: "Selected Google Place location",
        latitude: "51.4701",
        longitude: "-0.4543",
        notes: "Drop-off is free for the first 10 minutes."
      };
      const invalidPoi = await postForm("/settings/pois", { ...poiValues, placeId: "" });
      assert.equal(invalidPoi.status, 400);
      const invalidPoiBody = await invalidPoi.text();
      assert.match(invalidPoiBody, /Select a valid operational location from Google Places/);
      assert.match(invalidPoiBody, /value="Configured Hotel Name"/, "submitted values should be preserved");
      assert.equal(poiManagement.pois.length, 0);

      const createdPoi = await postForm("/settings/pois", poiValues);
      assert.equal(createdPoi.status, 303);
      assert.match(createdPoi.headers.get("location") ?? "", /saved=1/);
      assert.equal(poiManagement.pois.length, 1);
      const poi = poiManagement.pois[0];
      assert.match(poi.id, /^poi-/);
      assert.equal(poi.placeId, "ChIJ-operational-hotel");
      assert.equal(poi.locationLabel, "Selected Google Place location");
      assert.equal(poi.latitude, 51.4701);
      assert.equal(poi.longitude, -0.4543);
      assert.equal(poi.displayName, "Configured Hotel Name");
      assert.equal(poiManagement.fees.length, 0, "creating a POI must not create a fee");
      const poiEditBody = await (await fetch(`${baseUrl}/settings/pois?edit=${poi.id}`, { headers })).text();
      assert.match(poiEditBody, new RegExp(`name="id" value="${poi.id}"`));
      assert.match(poiEditBody, /value="Configured Hotel Name"/);

      const noFeePoiResponse = await postForm("/settings/pois", {
        ...poiValues,
        displayName: "Station without a fee",
        category: "railway station",
        placeId: "ChIJ-station",
        locationLabel: "Selected station location"
      });
      assert.equal(noFeePoiResponse.status, 303);
      const noFeePoi = poiManagement.pois[1];
      assert.equal(poiManagement.fees.length, 0);

      const editedPoiResponse = await postForm("/settings/pois", {
        ...poiValues,
        id: poi.id,
        displayName: "Configured Hotel Name Updated",
        notes: "Use the signed side entrance."
      });
      assert.equal(editedPoiResponse.status, 303);
      assert.equal(poiManagement.pois.length, 2, "editing updates the existing internal ID");
      assert.equal(poiManagement.pois[0].id, poi.id);
      assert.equal(poiManagement.pois[0].displayName, "Configured Hotel Name Updated");
      assert.equal(poiManagement.pois[0].placeId, "ChIJ-operational-hotel");
      assert.equal(poiManagement.pois[0].notes, "Use the signed side entrance.");

      const invalidFee = await postForm("/settings/poi-fees", {
        poiId: "missing-poi",
        action: "Drop-off",
        amount: "1000000.00",
        feeBasis: "",
        trigger: "selection",
        notes: ""
      });
      assert.equal(invalidFee.status, 400);
      const invalidFeeBody = await invalidFee.text();
      assert.match(invalidFeeBody, /Select an existing POI/);
      assert.match(invalidFeeBody, /Enter a GBP amount/);
      assert.match(invalidFeeBody, /Specify the fee basis or unit/);
      assert.match(invalidFeeBody, /value="1000000.00"/, "invalid submitted amounts should be preserved");
      assert.equal(poiManagement.fees.length, 0);

      for (const fee of [
        { action: "Drop-off", amount: "6", feeBasis: "per visit", trigger: "selection" },
        { action: "Parking", amount: "18.5", feeBasis: "per hour", trigger: "confirmation" }
      ]) {
        const response = await postForm("/settings/poi-fees", {
          poiId: poi.id,
          ...fee,
          notes: ""
        });
        assert.equal(response.status, 303);
      }
      assert.equal(poiManagement.fees.length, 2);
      assert.ok(poiManagement.fees.every((fee) => fee.poiId === poi.id));
      assert.equal(poiManagement.fees[0].amount, "6.00");
      assert.equal(poiManagement.fees[1].amount, "18.50");
      assert.equal(poiManagement.fees[0].trigger, "selection");
      assert.equal(poiManagement.fees[1].trigger, "confirmation");

      const firstFee = poiManagement.fees[0];
      const feeEditBody = await (await fetch(`${baseUrl}/settings/poi-fees?edit=${firstFee.id}`, { headers })).text();
      assert.match(feeEditBody, new RegExp(`name="id" value="${firstFee.id}"`));
      assert.match(feeEditBody, new RegExp(`value="${poi.id}" selected`));

      const editedFeeResponse = await postForm("/settings/poi-fees", {
        id: firstFee.id,
        poiId: poi.id,
        action: "Drop-off",
        amount: "7.5",
        feeBasis: "per visit",
        trigger: "selection",
        notes: "Updated operator source."
      });
      assert.equal(editedFeeResponse.status, 303);
      assert.equal(poiManagement.fees.length, 2, "editing a fee updates its existing record");
      assert.equal(poiManagement.fees[0].id, firstFee.id);
      assert.equal(poiManagement.fees[0].amount, "7.50");
      assert.equal(poiManagement.fees[0].notes, "Updated operator source.");

      const feesPage = await (await fetch(`${baseUrl}/settings/poi-fees`, { headers })).text();
      assert.match(feesPage, /Configured Hotel Name Updated — Drop-off/);
      assert.match(feesPage, /Configured Hotel Name Updated — Parking/);
      assert.match(feesPage, /not applied to booking prices/);
      assert.equal((await fetch(`${baseUrl}/settings/toll-fees/airport-fees`, { headers })).status, 200);
      const airportBody = await (await fetch(`${baseUrl}/settings/toll-fees/airport-fees`, { headers })).text();
      assert.match(airportBody, /Saved airports/);
      assert.doesNotMatch(airportBody, /Configured Hotel Name Updated|POI Fees/);

      const blockedDelete = await postForm(`/settings/pois/${poi.id}/delete`, {});
      assert.equal(blockedDelete.status, 303);
      assert.match(blockedDelete.headers.get("location") ?? "", /hasFees=1/);
      assert.ok(poiManagement.pois.some((item) => item.id === poi.id));

      const deleteUnusedPoi = await postForm(`/settings/pois/${noFeePoi.id}/delete`, {});
      assert.equal(deleteUnusedPoi.status, 303);
      assert.doesNotMatch(deleteUnusedPoi.headers.get("location") ?? "", /hasFees/);
      assert.ok(!poiManagement.pois.some((item) => item.id === noFeePoi.id));

      const deleteFirstFee = await postForm(`/settings/poi-fees/${firstFee.id}/delete`, {});
      assert.equal(deleteFirstFee.status, 303);
      assert.equal(poiManagement.fees.length, 1);
      const deleteLastFee = await postForm(`/settings/poi-fees/${poiManagement.fees[0].id}/delete`, {});
      assert.equal(deleteLastFee.status, 303);
      assert.equal(poiManagement.fees.length, 0);
      const deletePoi = await postForm(`/settings/pois/${poi.id}/delete`, {});
      assert.equal(deletePoi.status, 303);
      assert.ok(!poiManagement.pois.some((item) => item.id === poi.id));
    } finally {
      if (oldMapEnvironment.enabled === undefined) delete process.env.GOOGLE_MAPS_ENABLED;
      else process.env.GOOGLE_MAPS_ENABLED = oldMapEnvironment.enabled;
      if (oldMapEnvironment.browserKey === undefined) delete process.env.GOOGLE_MAPS_BROWSER_API_KEY;
      else process.env.GOOGLE_MAPS_BROWSER_API_KEY = oldMapEnvironment.browserKey;
      poiManagement.reset();
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

  const roadChargeForm = (scheme: keyof typeof roadChargeScheduleSeeds, token: string, baseVersion: number, overrides: Record<string, string> = {}) => {
    const seed = roadChargeScheduleSeeds[scheme];
    const form = new URLSearchParams({ _csrf: token, baseVersion: String(baseVersion), effectiveFrom: seed.effectiveFrom ?? "", effectiveUntil: seed.effectiveUntil ?? "" });
    for (const rate of seed.rates) form.set(`amount_${rate.key}`, rate.amount);
    for (const [key, value] of Object.entries(overrides)) form.set(key, value);
    return form;
  };

  const csrfSession = async (path: string, cookie: string, roles: string[], email = "bookings@romanairporttransfers.co.uk") => {
    const response = await fetch(`${baseUrl}${path}`, { headers: withSession(cookie, roles) });
    const body = await response.text();
    const csrfCookie = response.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
    const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrfCookie);
    assert.ok(token);
    const postCookie = `${cookie}; ${csrfCookie}`;
    sessionsByCookie.set(postCookie, {
      authenticated: true,
      user: { id: "u-1", email, roles, active_role: roles[0] }
    });
    return { body, token, postCookie };
  };

  const postForm = (path: string, cookie: string, form: URLSearchParams) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual"
  });

  test("London LEZ, ULEZ and Congestion Charge schedules show status, sources and blockers, and edits append inactive versions", async () => {
    feeSchedules.reset();
    const headers = withSession("sid=fee-schedules", ["superuser"]);
    const londonBase = "/settings/toll-fees/london-lez-ulez-congestion-charge";

    const lezBody = await (await fetch(`${baseUrl}${londonBase}/london-lez/fee-settings`, { headers })).text();
    assert.match(lezBody, /London LEZ fee schedule/);
    assert.match(lezBody, /Inactive — not used for booking prices/);
    assert.doesNotMatch(lezBody, /Active — used for New Booking quotes/);
    assert.match(lezBody, /id="road-charge-amount-lez-vans-specialist-minibuses"[\s\S]*?value="100\.00"/);
    assert.match(lezBody, /id="road-charge-amount-lez-heavy-below-euro-iv-pm"[\s\S]*?value="300\.00"/);
    assert.match(lezBody, /name="effectiveFrom" type="date" value="2021-03-01"/);
    assert.match(lezBody, /https:\/\/tfl\.gov\.uk\/modes\/driving\/low-emission-zone\/lorries-vans-buses-and-coaches<\/a> — effective 2021-03-01/);
    assert.match(lezBody, /Rules researched<\/dt><dd>2026-11-19/);
    assert.match(lezBody, /Not verified for this version/);
    assert.match(lezBody, /name="action" value="enable"/, "LEZ has no blockers, so it can be enabled");
    assert.match(lezBody, /Version history/);
    assert.match(lezBody, /<li><strong>Version 2<\/strong> — System migration/);

    const ulezBody = await (await fetch(`${baseUrl}${londonBase}/london-ulez/fee-settings`, { headers })).text();
    assert.match(ulezBody, /value="12\.50"/);
    assert.match(ulezBody, /Inactive — not used for booking prices/);
    assert.match(ulezBody, /Cannot be enabled yet/);
    assert.match(ulezBody, /ULEZ route exposure uses a boundary dataset/);
    assert.doesNotMatch(ulezBody, /name="action" value="enable"/);
    assert.doesNotMatch(ulezBody, /£180|£90/);

    const ccBody = await (await fetch(`${baseUrl}${londonBase}/london-congestion-charge/fee-settings`, { headers })).text();
    for (const amount of ["21.00", "13.50", "9.00", "0.00"]) assert.ok(ccBody.includes(`value="${amount}"`), `CC shows ${amount}`);
    assert.match(ccBody, /A configured £0\.00 is quoted as a zero charge, not as unresolved/);
    assert.doesNotMatch(ccBody, /boundary dataset/);
    assert.match(ccBody, /name="effectiveUntil" type="date" value="2030-03-03"/);

    const updatePath = `${londonBase}/london-ulez/fee-settings`;
    const { token, postCookie } = await csrfSession(updatePath, "sid=fee-schedules-post", ["superuser"]);
    const invalidAmount = await postForm(updatePath, postCookie, roadChargeForm("london-ulez", token, 2, { "amount_ulez-cars": "12.345" }));
    assert.equal(invalidAmount.status, 400);
    assert.match(await invalidAmount.text(), /no more than 2 decimal places/);
    const invalidDate = await postForm(updatePath, postCookie, roadChargeForm("london-ulez", token, 2, { effectiveFrom: "2023-02-30" }));
    assert.equal(invalidDate.status, 400);
    assert.match(await invalidDate.text(), /Enter a valid effective-from date/);
    assert.equal(feeSchedules.current("london-ulez").currentVersion, 2, "invalid edits are not saved");

    const saved = await postForm(updatePath, postCookie, roadChargeForm("london-ulez", token, 2, { "amount_ulez-cars": "13.25" }));
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get("location"), `${updatePath}?saved=1`);
    const savedPage = await (await fetch(`${baseUrl}${updatePath}?saved=1`, { headers })).text();
    assert.match(savedPage, /Changes saved as version 3/);
    assert.match(savedPage, /value="13\.25"/);
    assert.match(savedPage, /<li><strong>Version 3<\/strong> — bookings@romanairporttransfers\.co\.uk/);
    assert.equal(feeSchedules.current("london-ulez").status, "inactive");

    const stale = await postForm(updatePath, postCookie, roadChargeForm("london-ulez", token, 2));
    assert.equal(stale.status, 409);

    const deniedCookie = `sid=fee-schedules-denied; ${postCookie.split("; ")[1]}`;
    sessionsByCookie.set(deniedCookie, { authenticated: true, user: { id: "u-2", email: "admin@example.com", roles: ["admin"], active_role: "admin" } });
    const deniedSave = await postForm(updatePath, deniedCookie, roadChargeForm("london-ulez", token, 3));
    assert.equal(deniedSave.status, 403);
    assert.equal(feeSchedules.current("london-ulez").currentVersion, 3);
  });

  test("road-charge schedules are enabled only with verification, are actor-attributed, and edits or disabling deactivate them", async () => {
    feeSchedules.reset();
    const lezPath = "/settings/toll-fees/london-lez-ulez-congestion-charge/london-lez/fee-settings";
    const activationPath = `${lezPath}/activation`;
    const { token, postCookie } = await csrfSession(lezPath, "sid=fee-activation", ["superuser"]);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const enable = (overrides: Record<string, string> = {}, cookie = postCookie) => postForm(activationPath, cookie, new URLSearchParams({
      _csrf: token, baseVersion: "2", action: "enable", verifiedOn: yesterday, confirmSources: "yes", ...overrides
    }));

    const noCsrf = await fetch(`${baseUrl}${activationPath}`, {
      method: "POST",
      headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ baseVersion: "2", action: "enable", verifiedOn: yesterday, confirmSources: "yes" }),
      redirect: "manual"
    });
    assert.equal(noCsrf.status, 403);

    const deniedCookie = `sid=fee-activation-denied; ${postCookie.split("; ")[1]}`;
    sessionsByCookie.set(deniedCookie, { authenticated: true, user: { id: "u-2", email: "admin@example.com", roles: ["admin"], active_role: "admin" } });
    assert.equal((await enable({}, deniedCookie)).status, 403);

    const unconfirmed = await enable({ confirmSources: "" });
    assert.equal(unconfirmed.status, 400);
    assert.match(await unconfirmed.text(), /Confirm that you opened every cited source/);
    const future = await enable({ verifiedOn: "2999-01-01" });
    assert.equal(future.status, 400);
    assert.match(await future.text(), /cannot be in the future/);
    const missingDate = await enable({ verifiedOn: "" });
    assert.equal(missingDate.status, 400);
    assert.match(await missingDate.text(), /Enter the date you verified/);
    assert.equal(feeSchedules.current("london-lez").currentVersion, 2, "rejected activations append nothing");

    const enabled = await enable();
    assert.equal(enabled.status, 303);
    assert.equal(enabled.headers.get("location"), `${lezPath}?enabled=1`);
    const lez = feeSchedules.current("london-lez");
    assert.equal(lez.status, "active");
    assert.equal(lez.currentVersion, 3);
    const schedule = lez.schedule as { verification: { verifiedOn: string; verifiedByEmail: string } | null };
    assert.equal(schedule.verification?.verifiedOn, yesterday);
    assert.equal(schedule.verification?.verifiedByEmail, "bookings@romanairporttransfers.co.uk");
    const pricing = await feeSchedules.store.loadPricingSchedules();
    assert.equal(pricing["london-lez"]?.status, "active");
    assert.equal(pricing["london-lez"]?.version, 3);
    assert.equal(pricing["london-ulez"]?.status, "inactive");

    const activePage = await (await fetch(`${baseUrl}${lezPath}?enabled=1`, { headers: withSession("sid=fee-activation", ["superuser"]) })).text();
    assert.match(activePage, /Active — used for New Booking quotes/);
    assert.match(activePage, /Schedule enabled as version 3/);
    assert.match(activePage, new RegExp(`Verified on ${yesterday} by bookings@romanairporttransfers\\.co\\.uk`));
    assert.match(activePage, /<li><strong>Version 3<\/strong> — bookings@romanairporttransfers\.co\.uk/);
    assert.match(activePage, /name="action" value="disable"/);

    assert.equal((await enable()).status, 409, "a stale version cannot be enabled");

    // Editing an active schedule appends an inactive, unverified version.
    const edited = await postForm(lezPath, postCookie, roadChargeForm("london-lez", token, 3, { "amount_lez-vans-specialist-minibuses": "101.00" }));
    assert.equal(edited.status, 303);
    assert.equal(feeSchedules.current("london-lez").status, "inactive");
    assert.equal((feeSchedules.current("london-lez").schedule as { verification: unknown }).verification, null);

    // Removing the effective date makes the schedule impossible to enable.
    const noDate = await postForm(lezPath, postCookie, roadChargeForm("london-lez", token, 4, { effectiveFrom: "" }));
    assert.equal(noDate.status, 303);
    const blocked = await postForm(activationPath, postCookie, new URLSearchParams({ _csrf: token, baseVersion: "5", action: "enable", verifiedOn: yesterday, confirmSources: "yes" }));
    assert.equal(blocked.status, 400);
    assert.match(await blocked.text(), /The effective-from date is unknown/);
    assert.equal(feeSchedules.current("london-lez").status, "inactive");

    const restored = await postForm(lezPath, postCookie, roadChargeForm("london-lez", token, 5));
    assert.equal(restored.status, 303);
    assert.equal((await postForm(activationPath, postCookie, new URLSearchParams({ _csrf: token, baseVersion: "6", action: "enable", verifiedOn: yesterday, confirmSources: "yes" }))).status, 303);
    const disabled = await postForm(activationPath, postCookie, new URLSearchParams({ _csrf: token, baseVersion: "7", action: "disable" }));
    assert.equal(disabled.status, 303);
    assert.equal(disabled.headers.get("location"), `${lezPath}?disabled=1`);
    assert.equal(feeSchedules.current("london-lez").status, "inactive");
    assert.deepEqual(feeSchedules.history("london-lez").map((entry) => entry.version), [8, 7, 6, 5, 4, 3, 2, 1]);

    // ULEZ route exposure is not verified, so it cannot be enabled even with confirmation.
    for (const [scheme, path, pattern] of [
      ["london-ulez", "/settings/toll-fees/london-lez-ulez-congestion-charge/london-ulez/fee-settings", /ULEZ route exposure uses a boundary dataset/]
    ] as const) {
      const version = feeSchedules.current(scheme).currentVersion;
      const response = await postForm(`${path}/activation`, postCookie, new URLSearchParams({ _csrf: token, baseVersion: String(version), action: "enable", verifiedOn: yesterday, confirmSources: "yes" }));
      assert.equal(response.status, 400, `${scheme} must not be enabled`);
      assert.match(await response.text(), pattern);
      assert.equal(feeSchedules.current(scheme).status, "inactive");
      assert.equal(feeSchedules.current(scheme).currentVersion, version);
    }
    const tunnelPath = "/settings/toll-fees/blackwall-silvertown-tunnels/fee-settings";
    const tunnelVersion = feeSchedules.current("blackwall-silvertown-tunnels").currentVersion;
    const tunnelEnabled = await postForm(`${tunnelPath}/activation`, postCookie, new URLSearchParams({ _csrf: token, baseVersion: String(tunnelVersion), action: "enable", verifiedOn: yesterday, confirmSources: "yes" }));
    assert.equal(tunnelEnabled.status, 303, "verified tunnel geometry permits schedule activation");
    assert.equal(feeSchedules.current("blackwall-silvertown-tunnels").status, "active");

    // Dartford has no activation route and remains a legacy inactive draft.
    const dartford = await postForm("/settings/toll-fees/dartford-crossing/fee-settings/activation", postCookie, new URLSearchParams({ _csrf: token, baseVersion: "1", action: "enable", verifiedOn: yesterday, confirmSources: "yes" }));
    assert.equal(dartford.status, 404);
    assert.equal(feeSchedules.current("dartford-crossing").status, "draft_inactive");
    feeSchedules.reset();
  });

  test("Dartford and shared Blackwall/Silvertown schedules keep their rates; Dartford stays a draft and the tunnel schedule is structured and inactive", async () => {
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
    const tunnels = roadChargeScheduleSeeds["blackwall-silvertown-tunnels"];
    assert.match(tunnelBody, /Blackwall and Silvertown tunnels fee schedule/);
    assert.match(tunnelBody, /Inactive — not used for booking prices/);
    assert.match(tunnelBody, /name="action" value="enable"/);
    assert.doesNotMatch(tunnelBody, /unverified reference geometry/);
    assert.match(tunnelBody, /name="effectiveFrom" type="date" value="2026-09-21"/);
    assert.match(tunnelBody, /silvertown-tunnel-charging-statement-effective-september-2026\.pdf<\/a> — effective 2026-09-21/);
    for (const rate of tunnels.rates) {
      assert.match(tunnelBody, new RegExp(`<label for="road-charge-amount-${rate.key}">Amount \\(GBP per crossing\\)</label>[\\s\\S]*?value="${rate.amount.replace(".", "\\.")}"`));
    }
    assert.deepEqual(tunnels.rates.map((rate) => rate.amount), ["1.55", "2.60", "2.60", "1.55", "4.20", "4.20", "2.60", "6.80", "6.80", "5.25", "10.50", "10.50"]);
    assert.doesNotMatch(tunnelBody, /£180|£90|PCN|penalt/i);
    for (const rate of dartford.rates) {
      assert.equal(rate.currency, "GBP");
      assert.equal(rate.crossingBasis.includes("Per individual crossing"), true);
    }

    const crossingMigration = MIGRATIONS.find((migration) => migration.id === "0023_crossing_fee_schedule_drafts");
    assert.ok(crossingMigration);
    assert.match(crossingMigration.sql, /'dartford-crossing', 'blackwall-silvertown-tunnels'/);
    assert.ok(crossingMigration.sql.includes(JSON.stringify(dartford)));
    assert.ok(crossingMigration.sql.includes(JSON.stringify(crossingFeeScheduleDrafts["blackwall-silvertown-tunnels"])), "the historical tunnel draft is preserved");

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
    const tunnelForm = roadChargeForm("blackwall-silvertown-tunnels", token, 2, { [`amount_${tunnelRateToEdit.key}`]: "1.56" });
    const savedTunnel = await postForm(tunnelPath, postCookie, tunnelForm);
    assert.equal(savedTunnel.status, 303);
    const savedTunnelPage = await (await fetch(`${baseUrl}${tunnelPath}?saved=1`, { headers })).text();
    assert.match(savedTunnelPage, /Changes saved as version 3/);
    assert.match(savedTunnelPage, /value="1\.56"/);
    assert.equal(feeSchedules.current("dartford-crossing").currentVersion, 2, "the tunnel edit leaves Dartford unchanged");
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
    assert.match(feesBody, /London Congestion Charge fee schedule/);
    assert.match(feesBody, /Inactive — not used for booking prices/);
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

  test("Fare Settings navigation exposes separate minimum and fixed fare destinations", async () => {
    fareSettings.reset();
    const headers = withSession("sid=fare-nav", ["superuser"]);
    const settingsBody = await (await fetch(`${baseUrl}/settings`, { headers })).text();
    assert.match(settingsBody, /href="\/settings\/fare-settings">Open Fare Settings/);

    const landingBody = await (await fetch(`${baseUrl}/settings/fare-settings`, { headers })).text();
    for (const category of fareSettingsCategories) {
      assert.match(landingBody, new RegExp(`href="/settings/fare-settings/${category.slug}"`));
      assert.match(landingBody, new RegExp(category.title));
    }
    assert.match(landingBody, /Minimum fare rules/);
    assert.match(landingBody, /Fixed fares/);
    assert.notEqual(
      landingBody.indexOf('href="/settings/fare-settings/minimum-fare-rules"'),
      landingBody.indexOf('href="/settings/fare-settings/fixed-fares"')
    );
    const minimumRuleCategory = fareSettingsCategories.find((item) => item.slug === "minimum-fare-rules");
    const fixedFareCategory = fareSettingsCategories.find((item) => item.slug === "fixed-fares");
    assert.equal(minimumRuleCategory?.configurable, true);
    assert.equal(fixedFareCategory?.configurable, true);
    const minimumPage = await (await fetch(`${baseUrl}/settings/fare-settings/minimum-fare-rules`, { headers })).text();
    assert.match(minimumPage, /base fare = max\(distance-slabs fare, configured minimum base fare\)/);
    assert.match(minimumPage, /booking totals are unchanged/);
    assert.match(minimumPage, /Airport fees are separate/);
    const fixedPage = await (await fetch(`${baseUrl}/settings/fare-settings/fixed-fares`, { headers })).text();
    assert.match(fixedPage, /origin → destination/);
    assert.match(fixedPage, /full postcode or outward code/);

    for (const category of fareSettingsCategories.filter((item) => !item.configurable)) {
      const body = await (await fetch(`${baseUrl}/settings/fare-settings/${category.slug}`, { headers })).text();
      assert.match(body, /Configuration placeholder/);
      assert.match(body, /No fare rules or pricing behavior are configured here/);
    }
    assert.equal(fareSettingsCategories.find((item) => item.slug === "distance-slabs")?.configurable, true);
  });

  test("Fare Settings navigation exposes distinct Distance slabs and Additional distance slabs destinations", async () => {
    fareSettings.reset();
    const headers = withSession("sid=fare-nav-slabs", ["superuser"]);
    const landingBody = await (await fetch(`${baseUrl}/settings/fare-settings`, { headers })).text();
    const base = landingBody.indexOf('href="/settings/fare-settings/distance-slabs"');
    const additional = landingBody.indexOf('href="/settings/fare-settings/additional-distance-slabs"');
    assert.ok(base >= 0 && additional > base, "Additional distance slabs is listed separately, next to Distance slabs");
    assert.match(landingBody, />Distance slabs</);
    assert.match(landingBody, />Additional distance slabs</);

    const basePage = await (await fetch(`${baseUrl}/settings/fare-settings/distance-slabs`, { headers })).text();
    assert.match(basePage, /Progressive rates by distance/);
    assert.doesNotMatch(basePage, /Airport-specific distance slabs|Additional distance slabs set|Copy base slabs data/);

    const legacyLink = await fetch(`${baseUrl}/settings/fare-settings/distance-slabs?airportSet=new`, { headers, redirect: "manual" });
    assert.equal(legacyLink.status, 302);
    assert.equal(legacyLink.headers.get("location"), "/settings/fare-settings/additional-distance-slabs");
  });

  test("dead-mileage settings require a verified operational point and save radius to attributed Fare Settings history", async () => {
    fareSettings.reset();
    operationalBase = {
      operatorId: "test-operator",
      latitude: 50.71,
      longitude: -2.44,
      providerPlaceId: "verified-operational-point",
      coordinatesVerified: true,
      updatedAt: "2026-11-10T12:00:00.000Z"
    };
    const path = "/settings/fare-settings/dead-mileage-settings";
    const sessionCookie = "sid=dead-mileage-settings";
    const getPage = () => fetch(`${baseUrl}${path}`, { headers: withSession(sessionCookie, ["superuser"]) });
    operationalBase = { ...operationalBase!, coordinatesVerified: false };
    const unverifiedPage = await getPage();
    const unverifiedBody = await unverifiedPage.text();
    assert.match(unverifiedBody, /Dead mileage is unavailable/);
    assert.doesNotMatch(unverifiedBody, /name="freeRadiusMiles"/);
    operationalBase = { ...operationalBase!, coordinatesVerified: true };
    const postForm = async (version: string, radius: string, enabled = "yes", ratePerMile = "1.00") => {
      const page = await getPage();
      const body = await page.text();
      const csrfCookie = page.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
      const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfCookie);
      assert.ok(token);
      const postCookie = `${sessionCookie}; ${csrfCookie}`;
      withSession(postCookie, ["superuser"]);
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ enabled, freeRadiusMiles: radius, ratePerMile, baseVersion: version, _csrf: token }),
        redirect: "manual"
      });
    };

    const initial = await getPage();
    const initialBody = await initial.text();
    assert.match(initialBody, /verified coordinates from the existing operational-base record/);
    assert.match(initialBody, /\(50\.71, -2\.44\)/);
    assert.match(initialBody, /name="freeRadiusMiles"/);
    assert.match(initialBody, /When enabled, the fee is/);
    const invalid = await postForm("0", "0");
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /Enter a radius greater than 0/);
    assert.equal(fareSettings.snapshot().currentVersion, 0);

    const saved = await postForm("0", "5.25");
    assert.equal(saved.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.deadMileage, { enabled: true, freeRadiusMiles: "5.25", ratePerMile: "1.00" });
    assert.equal(fareSettings.snapshot().history[0].actorEmail, "bookings@romanairporttransfers.co.uk");
    assert.equal(fareSettings.snapshot().history[0].createdAt, "2026-11-10T12:00:00.000Z");
    assert.equal(fareSettings.snapshot().history.length, 1);
    const savedPage = await getPage();
    const savedBody = await savedPage.text();
    assert.match(savedBody, /bookings@romanairporttransfers\.co\.uk, 2026-11-10T12:00:00\.000Z/);
    assert.match(savedBody, /name="freeRadiusMiles"[^>]*value="5\.25"/);

    operationalBase = null;
    const unavailable = await getPage();
    const unavailableBody = await unavailable.text();
    assert.match(unavailableBody, /Dead mileage is unavailable/);
    assert.doesNotMatch(unavailableBody, /name="freeRadiusMiles"/);
    const rejectedWithoutBase = await postForm("1", "6");
    assert.equal(rejectedWithoutBase.status, 400);
    assert.match(await rejectedWithoutBase.text(), /does not have verified saved coordinates/);
    assert.equal(fareSettings.snapshot().currentVersion, 1);
  });

  test("minimum fare rules validate, preserve POI IDs, match both airport directions, and record edit/delete history", async () => {
    fareSettings.reset();
    airportFees.reset();
    const airport: AirportFeeRecord = {
      id: "rm-boh-internal-id",
      displayName: "Bournemouth Airport (BOH)",
      dropoffPlaceId: "google-place-dropoff",
      dropoffLocationLabel: "configured drop-off point",
      dropoffLatitude: 0,
      dropoffLongitude: 0,
      dropoffFee: "0.00",
      pickupPlaceId: "google-place-pickup",
      pickupLocationLabel: "configured pick-up point",
      pickupLatitude: 20,
      pickupLongitude: 20,
      pickupFee: "0.00",
      pickupTimeReference: "ALT",
      pickupDeferredEnabled: false,
      pickupDeferredMinutes: 0,
      pickupFeeCoveredMinutes: 10,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z"
    };
    airportFees.records.push(airport);
    const path = "/settings/fare-settings/minimum-fare-rules";
    const cookie = "sid=minimum-rules";
    const initialPage = await fetch(`${baseUrl}${path}`, { headers: withSession(cookie, ["superuser"]) });
    const initialBody = await initialPage.text();
    assert.match(initialBody, /name="poiId"/);
    assert.match(initialBody, /name="minimumBaseFare"/);
    assert.doesNotMatch(initialBody, /Radius \(miles\)|name="radiusMiles"|minimum-rule-radius/);
    assert.match(initialBody, /other endpoint's distance does not affect the match/);
    const postForm = async (version: string, values: Record<string, string>) => {
      const page = await fetch(`${baseUrl}${path}`, { headers: withSession(cookie, ["superuser"]) });
      const pageBody = await page.text();
      const csrfCookie = page.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
      const token = pageBody.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfCookie);
      assert.ok(token);
      const postCookie = `${cookie}; ${csrfCookie}`;
      withSession(postCookie, ["superuser"]);
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...values, baseVersion: version, _csrf: token }),
        redirect: "manual"
      });
    };

    airportFees.records[0].pickupLatitude = Number.NaN;
    const invalidFare = await postForm("0", {
      ruleAction: "save",
      ruleId: "",
      name: "BOH short journey",
      poiId: airport.id,
      minimumBaseFare: "-25"
    });
    assert.equal(invalidFare.status, 400);
    assert.match(await invalidFare.text(), /Enter a GBP amount/);
    assert.equal(fareSettings.snapshot().currentVersion, 0);

    const created = await postForm("0", {
      ruleAction: "save",
      ruleId: "",
      name: "BOH short journey",
      poiId: airport.id,
      minimumBaseFare: "25"
    });
    assert.equal(created.status, 303);
    const createdRule = fareSettings.snapshot().configuration.minimumFareRules[0];
    assert.deepEqual(createdRule, {
      id: createdRule.id,
      name: "BOH short journey",
      poiId: "rm-boh-internal-id",
      minimumBaseFare: "25.00"
    });
    assert.equal(fareSettings.snapshot().history[0].actorEmail, "bookings@romanairporttransfers.co.uk");
    const savedPage = await (await fetch(`${baseUrl}${path}`, {
      headers: withSession(cookie, ["superuser"])
    })).text();
    assert.match(savedPage, /name="poiId"[\s\S]*?selected>.*internal ID rm-boh-internal-id/);
    assert.match(savedPage, /name="minimumBaseFare"[^>]*value="25\.00"/);
    assert.doesNotMatch(savedPage, /name="radiusMiles"|minimum-rule-[^"]*-radius/);
    const farAwayOrigin = { poiId: "another-location", latitude: -80, longitude: 170 };
    const farAwayDestination = { poiId: "another-location", latitude: 89, longitude: -179 };

    const archivedAirport = structuredClone(airport);
    assert.equal(await airportFees.store.archive(airport.id, {
      accountId: "account-1",
      email: "bookings@romanairporttransfers.co.uk"
    }), true);
    const unavailableMinimumPage = await (await fetch(`${baseUrl}${path}`, {
      headers: withSession(cookie, ["superuser"])
    })).text();
    assert.match(unavailableMinimumPage, /Unavailable managed location — internal ID rm-boh-internal-id/);
    assert.doesNotMatch(unavailableMinimumPage.slice(0, unavailableMinimumPage.indexOf("Saved minimum fare rules")), /Unavailable managed location/);
    airportFees.records.push(archivedAirport);

    assert.equal(matchesMinimumFareRule(createdRule, farAwayOrigin, { poiId: airport.id }, airport), true);
    assert.equal(matchesMinimumFareRule(createdRule, { poiId: airport.id }, farAwayDestination, airport), true);
    assert.equal(matchesMinimumFareRule(createdRule, farAwayOrigin, { poiId: "different-id" }, airport), false);

    const edited = await postForm("1", {
      ruleAction: "save",
      ruleId: createdRule.id,
      name: "BOH five mile minimum",
      poiId: airport.id,
      minimumBaseFare: "30.50"
    });
    assert.equal(edited.status, 303);
    assert.equal(fareSettings.snapshot().configuration.minimumFareRules[0].minimumBaseFare, "30.50");
    assert.equal(fareSettings.snapshot().history.length, 2);

    const removed = await postForm("2", {
      ruleAction: "delete",
      ruleId: createdRule.id
    });
    assert.equal(removed.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.minimumFareRules, []);
    assert.equal(fareSettings.snapshot().history.length, 3);
  });

  test("fixed fares preserve endpoint identities and postcode scope through create, edit, and delete", async () => {
    fareSettings.reset();
    airportFees.reset();
    airportFees.records.push({
      id: "rm-boh-internal-id",
      displayName: "Bournemouth Airport (BOH)",
      dropoffPlaceId: "google-dropoff",
      dropoffLocationLabel: "drop-off",
      dropoffLatitude: 50.78,
      dropoffLongitude: -1.84,
      dropoffFee: "0.00",
      pickupPlaceId: "google-pickup",
      pickupLocationLabel: "pick-up",
      pickupLatitude: 50.79,
      pickupLongitude: -1.83,
      pickupFee: "0.00",
      pickupTimeReference: "ALT",
      pickupDeferredEnabled: false,
      pickupDeferredMinutes: 0,
      pickupFeeCoveredMinutes: 10,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z"
    });
    const path = "/settings/fare-settings/fixed-fares";
    const cookie = "sid=fixed-fares";
    const initialBody = await (await fetch(`${baseUrl}${path}`, {
      headers: withSession(cookie, ["superuser"])
    })).text();
    assert.match(initialBody, /data-fixed-endpoint/);
    assert.match(initialBody, /Managed POI by RideMatrix ID/);
    assert.match(initialBody, /Bournemouth Airport \(BOH\) — internal ID rm-boh-internal-id/);
    assert.match(initialBody, /Full postcode/);
    assert.match(initialBody, /Outward code/);
    const postForm = async (version: string, values: Record<string, string>) => {
      const page = await fetch(`${baseUrl}${path}`, { headers: withSession(cookie, ["superuser"]) });
      const pageBody = await page.text();
      const csrfCookie = page.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
      const token = pageBody.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfCookie);
      assert.ok(token);
      const postCookie = `${cookie}; ${csrfCookie}`;
      withSession(postCookie, ["superuser"]);
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...values, baseVersion: version, _csrf: token }),
        redirect: "manual"
      });
    };

    const created = await postForm("0", {
      ruleAction: "save",
      ruleId: "",
      name: "Airport to Bournemouth",
      originType: "poi",
      originPoiId: "rm-boh-internal-id",
      destinationType: "postcode",
      destinationPostcode: "bh1 1aa",
      destinationPostcodeScope: "full",
      baseFare: "42.5"
    });
    assert.equal(created.status, 303);
    const createdRule = fareSettings.snapshot().configuration.fixedFares[0];
    assert.deepEqual(createdRule, {
      id: createdRule.id,
      name: "Airport to Bournemouth",
      origin: { type: "poi", poiId: "rm-boh-internal-id" },
      destination: { type: "postcode", postcode: "BH1 1AA", scope: "full" },
      baseFare: "42.50"
    });

    const archivedAirport = structuredClone(airportFees.records[0]);
    assert.equal(await airportFees.store.archive(archivedAirport.id, {
      accountId: "account-1",
      email: "bookings@romanairporttransfers.co.uk"
    }), true);
    const unavailableFixedPage = await (await fetch(`${baseUrl}${path}`, {
      headers: withSession(cookie, ["superuser"])
    })).text();
    assert.match(unavailableFixedPage, /Unavailable managed location — internal ID rm-boh-internal-id/);
    const newFixedForm = unavailableFixedPage.slice(unavailableFixedPage.lastIndexOf('name="ruleId" value=""'));
    assert.doesNotMatch(newFixedForm, /Unavailable managed location/);
    airportFees.records.push(archivedAirport);

    const edited = await postForm("1", {
      ruleAction: "save",
      ruleId: createdRule.id,
      name: "Airport to Bournemouth outward code",
      originType: "poi",
      originPoiId: "rm-boh-internal-id",
      destinationType: "postcode",
      destinationPostcode: "bh1",
      destinationPostcodeScope: "outward",
      baseFare: "45.00"
    });
    assert.equal(edited.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.fixedFares[0].destination, {
      type: "postcode", postcode: "BH1", scope: "outward"
    });
    assert.deepEqual(fareSettings.snapshot().configuration.fixedFares[0].origin, {
      type: "poi", poiId: "rm-boh-internal-id"
    });
    assert.equal(fareSettings.snapshot().configuration.fixedFares[0].baseFare, "45.00");
    assert.equal(fareSettings.snapshot().history.length, 2);

    const removed = await postForm("2", { ruleAction: "delete", ruleId: createdRule.id });
    assert.equal(removed.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.fixedFares, []);
    assert.equal(fareSettings.snapshot().history.length, 3);
  });

  test("Distance slabs validate, save, edit, remove, preview unsaved form state, and retain version history", async () => {
    fareSettings.reset();
    const path = "/settings/fare-settings/distance-slabs";
    const sessionCookie = "sid=fare-distance";
    const getPage = () => fetch(`${baseUrl}${path}`, { headers: withSession(sessionCookie, ["superuser"]) });
    const initialResponse = await getPage();
    const initialBody = await initialResponse.text();
    assert.match(initialBody, /name="distanceSlabs\[0\]\[startMiles\]"/);
    assert.match(initialBody, /name="distanceSlabs\[0\]\[endMiles\]"/);
    assert.match(initialBody, /name="distanceSlabs\[0\]\[ratePerMile\]"/);
    assert.match(initialBody, /Open-ended final slab/);
    assert.match(initialBody, /Settings preview/);
    assert.match(initialBody, /data-test-distance/);
    assert.match(initialBody, /current form values, including unsaved edits/);
    assert.match(initialBody, /not a booking quote/);

    const postForm = async (version: string, values: Record<string, string>) => {
      const page = await getPage();
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

    const invalid = await postForm("0", {
      "distanceSlabs[0][startMiles]": "1",
      "distanceSlabs[0][endMiles]": "",
      "distanceSlabs[0][ratePerMile]": "3"
    });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.text();
    assert.match(invalidBody, /The first slab must start at 0 miles/);
    assert.match(invalidBody, /name="distanceSlabs\[0\]\[startMiles\]"[^>]*value="1"/);
    assert.equal(fareSettings.snapshot().currentVersion, 0);

    const created = await postForm("0", {
      "distanceSlabs[0][startMiles]": "0",
      "distanceSlabs[0][endMiles]": "10",
      "distanceSlabs[0][ratePerMile]": "3.00",
      "distanceSlabs[1][startMiles]": "10",
      "distanceSlabs[1][endMiles]": "",
      "distanceSlabs[1][ratePerMile]": "2.70"
    });
    assert.equal(created.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.distanceSlabs, [
      { startMiles: "0", endMiles: "10", ratePerMile: "3.00" },
      { startMiles: "10", endMiles: "", ratePerMile: "2.70" }
    ]);
    assert.deepEqual(fareSettings.snapshot().configuration.dailySurcharge, EMPTY_FARE_SETTINGS.dailySurcharge);
    assert.equal(fareSettings.snapshot().history.length, 1);

    const edited = await postForm("1", {
      "distanceSlabs[0][startMiles]": "0",
      "distanceSlabs[0][endMiles]": "8",
      "distanceSlabs[0][ratePerMile]": "3.10",
      "distanceSlabs[1][startMiles]": "8",
      "distanceSlabs[1][endMiles]": "",
      "distanceSlabs[1][ratePerMile]": "2.75"
    });
    assert.equal(edited.status, 303);
    assert.equal(fareSettings.snapshot().configuration.distanceSlabs[0].endMiles, "8");
    assert.equal(fareSettings.snapshot().history.length, 2);

    const removed = await postForm("2", {
      "distanceSlabs[0][startMiles]": "0",
      "distanceSlabs[0][endMiles]": "",
      "distanceSlabs[0][ratePerMile]": "2.60"
    });
    assert.equal(removed.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.distanceSlabs, [
      { startMiles: "0", endMiles: "", ratePerMile: "2.60" }
    ]);
    assert.equal(fareSettings.snapshot().history.length, 3);
    const savedBody = await (await getPage()).text();
    assert.match(savedBody, /value="2\.60"/);
    assert.match(savedBody, /Configuration history/);
    assert.match(savedBody, /booking fares and totals are not calculated or changed here/);
  });

  const slabAirport = (id: string, displayName: string): AirportFeeRecord => ({
    id, displayName,
    dropoffPlaceId: "google-dropoff", dropoffLocationLabel: "Google drop-off label", dropoffLatitude: 0, dropoffLongitude: 0, dropoffFee: "0.00",
    pickupPlaceId: "google-pickup", pickupLocationLabel: "Google pickup label", pickupLatitude: 1, pickupLongitude: 1, pickupFee: "0.00",
    pickupTimeReference: "ALT", pickupDeferredEnabled: false, pickupDeferredMinutes: 0, pickupFeeCoveredMinutes: 10,
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z"
  });
  const slabPoi = (id: string, displayName: string): PoiRecord => ({
    id, displayName, category: "Hotel", placeId: "google-poi", locationLabel: "Google POI label",
    latitude: 50.7, longitude: -1.9, notes: "", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z"
  });
  const additionalSlabsClient = (cookie: string) => {
    const path = "/settings/fare-settings/additional-distance-slabs";
    const getPage = (suffix = "") => fetch(`${baseUrl}${path}${suffix}`, { headers: withSession(cookie, ["superuser"]), redirect: "manual" });
    const post = async (target: string, version: string, values: Record<string, string>) => {
      const page = await getPage();
      const body = await page.text();
      const csrfCookie = page.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
      const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfCookie && token);
      const postCookie = `${cookie}; ${csrfCookie}`;
      withSession(postCookie, ["superuser"]);
      return fetch(`${baseUrl}${target}`, {
        method: "POST",
        headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ baseVersion: version, _csrf: token, ...values }),
        redirect: "manual"
      });
    };
    return { path, getPage, post };
  };
  const slabFields = (firstRate: string, finalRate = "2.70") => ({
    "distanceSlabs[0][startMiles]": "0", "distanceSlabs[0][endMiles]": "10", "distanceSlabs[0][ratePerMile]": firstRate,
    "distanceSlabs[1][startMiles]": "10", "distanceSlabs[1][endMiles]": "", "distanceSlabs[1][ratePerMile]": finalRate
  });

  test("Additional distance slabs create, copy base slabs, list, edit, and remove independent sets", async () => {
    fareSettings.reset();
    airportFees.reset();
    poiManagement.reset();
    airportFees.records.push(slabAirport("rm-boh", "Bournemouth Airport"), slabAirport("rm-sou", "Southampton Airport"));
    poiManagement.pois.push(slabPoi("poi-pier", "Bournemouth Pier"));
    const { path, getPage, post } = additionalSlabsClient("sid=additional-slabs");
    const basePath = "/settings/fare-settings/distance-slabs";

    assert.equal((await post(basePath, "0", slabFields("3.00"))).status, 303);
    const baseBefore = structuredClone(fareSettings.snapshot().configuration.distanceSlabs);

    const landing = await (await getPage()).text();
    assert.match(landing, /href="\/settings\/fare-settings\/additional-distance-slabs\/new">Create additional distance slabs set/);
    assert.match(landing, /No additional distance slab sets have been configured/);
    assert.match(landing, /Configuration only — not yet used to price bookings/);

    const createPage = await (await getPage("/new")).text();
    assert.match(createPage, /<label for="additional-slab-target">Select POI or Place to link it<\/label>/);
    assert.match(createPage, /<optgroup label="Airports"><option value="airport:rm-boh" >Bournemouth Airport<\/option>/);
    assert.match(createPage, /<optgroup label="Points of interest"><option value="poi:poi-pier" >Bournemouth Pier<\/option>/);
    assert.doesNotMatch(createPage, /Google (drop-off|pickup|POI) label/);
    assert.match(createPage, /data-copy-base-slabs data-base-slabs="\[\{&quot;startMiles&quot;:&quot;0&quot;,&quot;endMiles&quot;:&quot;10&quot;,&quot;ratePerMile&quot;:&quot;3\.00&quot;\},\{&quot;startMiles&quot;:&quot;10&quot;,&quot;endMiles&quot;:&quot;&quot;,&quot;ratePerMile&quot;:&quot;2\.70&quot;\}\]"/);
    assert.match(createPage, /Copy base slabs data/);
    assert.match(createPage, /id="distance-test-miles"/);
    assert.match(createPage, /data-distance-preview-total/);
    assert.match(createPage, /data-distance-slab-form data-additional-slab-form/);
    assert.match(createPage, /Open-ended final slab — leave this blank/);

    // No-JavaScript fallback: copying re-renders the editor with every base slab and saves nothing.
    const copied = await post(path, "1", { setAction: "copy-base", name: "Airport rates", targetKey: "airport:rm-boh" });
    assert.equal(copied.status, 200);
    const copiedBody = await copied.text();
    assert.match(copiedBody, /Base slabs copied into this editor/);
    assert.match(copiedBody, /name="distanceSlabs\[0\]\[ratePerMile\]" type="text" inputmode="decimal" value="3\.00"/);
    assert.match(copiedBody, /name="distanceSlabs\[1\]\[startMiles\]" type="text" inputmode="decimal" value="10"/);
    assert.match(copiedBody, /name="distanceSlabs\[1\]\[endMiles\]" type="text" inputmode="decimal" value=""/);
    assert.match(copiedBody, /name="distanceSlabs\[1\]\[ratePerMile\]" type="text" inputmode="decimal" value="2\.70"/);
    assert.match(copiedBody, /value="Airport rates"/);
    assert.match(copiedBody, /<option value="airport:rm-boh" selected>/);
    assert.equal(fareSettings.snapshot().currentVersion, 1);

    const created = await post(path, "1", { setAction: "save", name: "Airport rates", targetKey: "airport:rm-boh", ...slabFields("3.50") });
    assert.equal(created.status, 303);
    assert.equal(created.headers.get("location"), `${path}?saved=1`);
    let config = fareSettings.snapshot().configuration;
    assert.equal(config.additionalDistanceSlabSets?.length, 1);
    const set = config.additionalDistanceSlabSets![0];
    assert.deepEqual(set.target, { type: "airport", id: "rm-boh" });
    assert.equal(set.distanceSlabs[0].ratePerMile, "3.50");
    assert.deepEqual(config.distanceSlabs, baseBefore, "saving a copied set does not modify base slabs");
    assert.equal(fareSettings.snapshot().history[0].actorEmail, "bookings@romanairporttransfers.co.uk");

    const poiSet = await post(path, "2", { name: "Pier rates", targetKey: "poi:poi-pier", ...slabFields("4.00") });
    assert.equal(poiSet.status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.additionalDistanceSlabSets![1].target, { type: "poi", id: "poi-pier" });

    const listed = await (await getPage("?saved=1")).text();
    assert.match(listed, /Fare settings saved/);
    assert.match(listed, /<h3>Airport rates<\/h3>/);
    assert.match(listed, /Linked to:<\/strong> Bournemouth Airport <span class="fare-settings__help">\(Airport\)/);
    assert.match(listed, /Linked to:<\/strong> Bournemouth Pier <span class="fare-settings__help">\(POI\)/);
    assert.match(listed, /2 slabs from 0 miles; final slab open-ended from 10 miles at £2\.70 per mile/);
    assert.match(listed, /Slab 2 — open-ended final slab/);
    assert.match(listed, new RegExp(`href="${path}/${set.id}/edit"`));
    assert.match(listed, new RegExp(`href="${path}/${set.id}/remove"`));

    const editPage = await (await getPage(`/${set.id}/edit`)).text();
    assert.match(editPage, /Edit additional distance slabs set/);
    assert.match(editPage, /value="Airport rates"/);
    assert.match(editPage, /<option value="airport:rm-boh" selected>/);
    assert.match(editPage, /name="distanceSlabs\[0\]\[ratePerMile\]" type="text" inputmode="decimal" value="3\.50"/);
    assert.equal((await getPage("/missing-set/edit")).status, 404);

    const duplicate = await post(path, "3", { name: "Duplicate", targetKey: "airport:rm-boh", ...slabFields("5.00") });
    assert.equal(duplicate.status, 400);
    assert.match(await duplicate.text(), /Bournemouth Airport is already linked to the additional distance slab set &quot;Airport rates&quot;/);
    const freeText = await post(path, "3", { name: "Free text", targetKey: "Southampton Airport", ...slabFields("5.00") });
    assert.equal(freeText.status, 400);
    assert.match(await freeText.text(), /missing or no longer available/);
    const gapped = await post(path, "3", { name: "Gapped", targetKey: "airport:rm-sou", ...slabFields("5.00"), "distanceSlabs[1][startMiles]": "11" });
    assert.equal(gapped.status, 400);
    const closed = await post(path, "3", { name: "Closed", targetKey: "airport:rm-sou", ...slabFields("5.00"), "distanceSlabs[1][endMiles]": "20" });
    assert.equal(closed.status, 400);
    assert.equal(fareSettings.snapshot().currentVersion, 3);

    const edited = await post(path, "3", { setId: set.id, name: "Airport rates", targetKey: "airport:rm-boh", ...slabFields("3.75") });
    assert.equal(edited.status, 303);
    config = fareSettings.snapshot().configuration;
    assert.equal(config.additionalDistanceSlabSets![0].id, set.id);
    assert.equal(config.additionalDistanceSlabSets![0].distanceSlabs[0].ratePerMile, "3.75");
    assert.deepEqual(config.distanceSlabs, baseBefore);

    // A later base edit must not overwrite the copied set.
    assert.equal((await post(basePath, "4", slabFields("9.99"))).status, 303);
    config = fareSettings.snapshot().configuration;
    assert.equal(config.distanceSlabs[0].ratePerMile, "9.99");
    assert.equal(config.additionalDistanceSlabSets![0].distanceSlabs[0].ratePerMile, "3.75");
    assert.equal(config.additionalDistanceSlabSets!.length, 2, "saving base slabs keeps additional sets");

    // Removing an airport makes the link unavailable; it is reported, never substituted.
    airportFees.records.splice(0, airportFees.records.length, slabAirport("rm-sou", "Southampton Airport"));
    const unavailableEdit = await (await getPage(`/${set.id}/edit`)).text();
    assert.match(unavailableEdit, /<option value="airport:rm-boh" selected disabled>Unavailable airport — internal ID rm-boh<\/option>/);
    assert.match(unavailableEdit, /The linked airport or POI is missing or unavailable/);
    const unavailableSave = await post(path, "5", { setId: set.id, name: "Airport rates", targetKey: "airport:rm-boh", ...slabFields("3.75") });
    assert.equal(unavailableSave.status, 400);
    assert.match(await (await getPage()).text(), /Unavailable airport \(internal ID rm-boh\)/);

    const confirm = await (await getPage(`/${set.id}/remove`)).text();
    assert.match(confirm, /Remove “Airport rates”\?/);
    assert.match(confirm, /name="setAction" value="delete">Yes, remove this set/);
    assert.equal(fareSettings.snapshot().currentVersion, 5, "the confirmation page does not remove anything");
    assert.equal((await post(path, "1", { setId: set.id, setAction: "delete" })).status, 409);
    const removed = await post(path, "5", { setId: set.id, setAction: "delete" });
    assert.equal(removed.status, 303);
    config = fareSettings.snapshot().configuration;
    assert.deepEqual(config.additionalDistanceSlabSets!.map((item) => item.name), ["Pier rates"]);
    assert.equal(config.distanceSlabs[0].ratePerMile, "9.99");
    assert.equal(fareSettings.snapshot().history.length, 6, "each change is appended to configuration history");
    assert.deepEqual(config.minimumFareRules, []);
    assert.deepEqual(config.fixedFares, []);
  });

  test("Additional distance slabs preserve legacy airport-specific sets linked to managed airport IDs", async () => {
    fareSettings.reset();
    airportFees.reset();
    poiManagement.reset();
    airportFees.records.push(slabAirport("rm-boh", "Bournemouth Airport"), slabAirport("rm-sou", "Southampton Airport"));
    const legacySlabs = [
      { startMiles: "0", endMiles: "5", ratePerMile: "3.10" },
      { startMiles: "5", endMiles: "", ratePerMile: "2.20" }
    ];
    await fareSettings.store.save(0, {
      ...structuredClone(EMPTY_FARE_SETTINGS),
      additionalDistanceSlabSets: undefined,
      airportDistanceSlabSets: [{ id: "legacy-set", name: "South coast airports", airportIds: ["rm-boh", "rm-sou"], distanceSlabs: legacySlabs }]
    }, { accountId: "u-0", email: "legacy@example.test" });
    const { path, getPage, post } = additionalSlabsClient("sid=additional-slabs-legacy");

    const landing = await (await getPage()).text();
    assert.equal((landing.match(/<h3>South coast airports<\/h3>/g) ?? []).length, 2);
    assert.match(landing, /Linked to:<\/strong> Bournemouth Airport/);
    assert.match(landing, /Linked to:<\/strong> Southampton Airport/);
    assert.match(landing, new RegExp(`href="${path}/legacy-set/edit"`));
    assert.match(landing, new RegExp(`href="${path}/legacy-set--rm-sou/edit"`));
    const legacyEdit = await (await getPage("/legacy-set--rm-sou/edit")).text();
    assert.match(legacyEdit, /<option value="airport:rm-sou" selected>/);
    assert.match(legacyEdit, /value="3\.10"/);

    const saved = await post(path, "1", { setId: "legacy-set", name: "Bournemouth", targetKey: "airport:rm-boh", ...slabFields("3.20") });
    assert.equal(saved.status, 303);
    const snapshot = fareSettings.snapshot();
    assert.equal(snapshot.configuration.airportDistanceSlabSets, undefined);
    assert.deepEqual(snapshot.configuration.additionalDistanceSlabSets!.map((set) => [set.id, set.name, set.target.id, set.distanceSlabs[0].ratePerMile]), [
      ["legacy-set", "Bournemouth", "rm-boh", "3.20"],
      ["legacy-set--rm-sou", "South coast airports", "rm-sou", "3.10"]
    ]);
    assert.deepEqual(snapshot.history.map((entry) => entry.version), [2, 1], "legacy history is retained");
  });

  test("Additional distance slab changes keep System Settings authorization", async () => {
    fareSettings.reset();
    for (const suffix of ["", "/new", "/any-set/edit", "/any-set/remove"]) {
      const denied = await fetch(`${baseUrl}/settings/fare-settings/additional-distance-slabs${suffix}`, {
        headers: withSession("sid=additional-slabs-denied", ["admin", "staff", "tech_support"]),
        redirect: "manual"
      });
      assert.equal(denied.status, 403, suffix);
      const anonymous = await fetch(`${baseUrl}/settings/fare-settings/additional-distance-slabs${suffix}`, { redirect: "manual" });
      assert.equal(anonymous.status, 302, suffix);
      assert.equal(anonymous.headers.get("location"), "/access");
    }
    const anonymousPost = await fetch(`${baseUrl}/settings/fare-settings/additional-distance-slabs`, {
      method: "POST", redirect: "manual"
    });
    assert.notEqual(anonymousPost.status, 303);
    assert.equal(fareSettings.snapshot().currentVersion, 0);
  });

  const discountsClient = (cookie: string) => {
    const path = "/settings/fare-settings/location-based-discounts";
    const getPage = (suffix = "") => fetch(`${baseUrl}${path}${suffix}`, { headers: withSession(cookie, ["superuser"]), redirect: "manual" });
    const post = async (version: string, values: Record<string, string>) => {
      const page = await getPage();
      const body = await page.text();
      const csrfCookie = page.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
      const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfCookie && token);
      const postCookie = `${cookie}; ${csrfCookie}`;
      withSession(postCookie, ["superuser"]);
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ baseVersion: version, _csrf: token, ...values }),
        redirect: "manual"
      });
    };
    return { path, getPage, post };
  };
  const discountFields = (overrides: Record<string, string> = {}) => ({
    name: "BH1 airport promotion",
    locationKey: "airport:rm-boh",
    postcodePrecision: "full",
    postcodes: "bh14rs\nBH2 5AA",
    discountPercentage: "10",
    startDate: "",
    endDate: "",
    enabled: "no",
    ...overrides
  });

  test("Fare Settings navigation exposes Location-based discounts with documented matching semantics", async () => {
    fareSettings.reset();
    const headers = withSession("sid=fare-nav-discounts", ["superuser"]);
    const landingBody = await (await fetch(`${baseUrl}/settings/fare-settings`, { headers })).text();
    assert.match(landingBody, /href="\/settings\/fare-settings\/location-based-discounts"/);
    assert.match(landingBody, />Location-based discounts</);

    const page = await (await fetch(`${baseUrl}/settings/fare-settings/location-based-discounts`, { headers })).text();
    assert.match(page, /No location-based discounts have been configured/);
    assert.match(page, /discounts are not yet applied to booking prices/);
    assert.match(page, /href="\/settings\/fare-settings\/location-based-discounts\/new"/);

    const editor = await (await fetch(`${baseUrl}/settings/fare-settings/location-based-discounts/new`, { headers })).text();
    assert.match(editor, /data-location-discount-form/);
    assert.match(editor, /\/js\/location-discounts\.js/);
    assert.match(editor, /name="enabled" value="no" checked/, "new rules default to disabled");
    for (const semantic of [/either direction/i, /internal RideMatrix ID/i, /Google/, /unresolved/i, /passing through/i, /Distance Slabs/, /not discounted/i, /stack/i]) {
      assert.match(editor, semantic);
    }
    assert.equal(fareSettings.snapshot().currentVersion, 0, "viewing does not seed configuration");
  });

  test("Location-based discounts create, edit, disable, enable, and remove with attributed history", async () => {
    fareSettings.reset();
    airportFees.reset();
    poiManagement.reset();
    airportFees.records.push(slabAirport("rm-boh", "Bournemouth Airport"));
    poiManagement.pois.push(slabPoi("poi-pier", "Bournemouth Pier"));
    const { path, getPage, post } = discountsClient("sid=discounts-crud");

    const slabPost = additionalSlabsClient("sid=discounts-crud").post;
    assert.equal((await slabPost("/settings/fare-settings/distance-slabs", "0", slabFields("3.00"))).status, 303);
    const before = fareSettings.snapshot().configuration;
    const airportsBefore = structuredClone(airportFees.records);
    const poisBefore = structuredClone(poiManagement.pois);

    const editor = await (await getPage("/new")).text();
    assert.match(editor, /value="airport:rm-boh"[^>]*>Bournemouth Airport/);
    assert.match(editor, /value="poi:poi-pier"[^>]*>Bournemouth Pier/);

    const created = await post("1", discountFields());
    assert.equal(created.status, 303);
    assert.equal(created.headers.get("location"), `${path}?saved=1`);
    let snapshot = fareSettings.snapshot();
    assert.equal(snapshot.configuration.locationDiscounts?.length, 1);
    const [rule] = snapshot.configuration.locationDiscounts!;
    assert.deepEqual({ ...rule, id: "" }, {
      id: "",
      name: "BH1 airport promotion",
      location: { type: "airport", id: "rm-boh" },
      postcodePrecision: "full",
      postcodes: ["BH1 4RS", "BH2 5AA"],
      discountPercentage: "10",
      startDate: "",
      endDate: "",
      enabled: false,
      discountBasis: "standard-distance-slabs-base-fare"
    });
    assert.equal(snapshot.history[0].actorEmail, "bookings@romanairporttransfers.co.uk");
    assert.equal(snapshot.currentVersion, 2);

    const list = await (await getPage()).text();
    assert.match(list, /BH1 airport promotion/);
    assert.match(list, /Bournemouth Airport/);
    assert.match(list, /BH1 4RS/);
    assert.match(list, /Disabled/);
    assert.match(list, /Configuration history/);

    const editPage = await (await getPage(`/${rule.id}/edit`)).text();
    assert.match(editPage, /BH1 4RS\nBH2 5AA/);

    const edited = await post("2", discountFields({
      ruleId: rule.id, postcodePrecision: "outward", postcodes: "BH22", discountPercentage: "12.5",
      startDate: "2027-01-01", endDate: "2027-03-31"
    }));
    assert.equal(edited.status, 303);
    snapshot = fareSettings.snapshot();
    assert.equal(snapshot.configuration.locationDiscounts?.length, 1);
    assert.deepEqual(snapshot.configuration.locationDiscounts![0], {
      ...rule, postcodePrecision: "outward", postcodes: ["BH22"], discountPercentage: "12.5", startDate: "2027-01-01", endDate: "2027-03-31"
    });

    assert.equal((await post("3", { ruleAction: "enable", ruleId: rule.id })).status, 303);
    assert.equal(fareSettings.snapshot().configuration.locationDiscounts![0].enabled, true);
    assert.match(await (await getPage()).text(), /Enabled/);
    assert.equal((await post("4", { ruleAction: "disable", ruleId: rule.id })).status, 303);
    assert.equal(fareSettings.snapshot().configuration.locationDiscounts![0].enabled, false);

    const removePage = await (await getPage(`/${rule.id}/remove`)).text();
    assert.match(removePage, /Yes, remove this discount/);
    assert.equal((await post("5", { ruleAction: "delete", ruleId: rule.id })).status, 303);
    snapshot = fareSettings.snapshot();
    assert.deepEqual(snapshot.configuration.locationDiscounts, []);
    assert.equal(snapshot.currentVersion, 6);
    assert.equal(snapshot.history.length, 6, "each change is appended to Fare Settings history");

    const { locationDiscounts: _ignored, ...otherAfter } = snapshot.configuration;
    const { locationDiscounts: _before, ...otherBefore } = before;
    assert.deepEqual(otherAfter, otherBefore, "Distance Slabs, Additional Distance Slabs, minimum/fixed fares, surcharges, and dead mileage are unchanged");
    assert.deepEqual(airportFees.records, airportsBefore, "airport fees are unchanged");
    assert.deepEqual(poiManagement.pois, poisBefore, "POI fees are unchanged");

    assert.equal((await getPage("/missing/edit")).status, 404);
    assert.equal((await post("6", { ruleAction: "delete", ruleId: "missing" })).status, 404);
  });

  test("Location-based discounts reject invalid and overlapping rules with preserved values and clear errors", async () => {
    fareSettings.reset();
    airportFees.reset();
    poiManagement.reset();
    airportFees.records.push(slabAirport("rm-boh", "Bournemouth Airport"));
    const { post } = discountsClient("sid=discounts-invalid");

    const invalid = await post("0", discountFields({ postcodes: "BH1 4R", discountPercentage: "101", startDate: "2027-02-01", endDate: "2027-01-01", locationKey: "Bournemouth Airport" }));
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.text();
    assert.match(invalidBody, /BH1 4R is not a valid UK full postcode/);
    assert.match(invalidBody, /percentage greater than 0 and no more than 100/);
    assert.match(invalidBody, /end date cannot be before the start date/);
    assert.match(invalidBody, /missing or no longer available/);
    assert.match(invalidBody, /id="discount-postcodes"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="discount-postcodes"/);
    assert.match(invalidBody, />BH1 4R<\/textarea>/, "submitted postcodes are preserved");
    assert.match(invalidBody, /value="101"/, "submitted percentage is preserved");
    assert.equal(fareSettings.snapshot().currentVersion, 0);

    assert.equal((await post("0", discountFields({ name: "BH22 area", postcodePrecision: "outward", postcodes: "BH22", enabled: "yes" }))).status, 303);
    const overlap = await post("1", discountFields({ name: "Ferndown street", postcodes: "BH22 8AB" }));
    assert.equal(overlap.status, 400);
    const overlapBody = await overlap.text();
    assert.match(overlapBody, /BH22 8AB overlaps the outward code entry BH22 in the rule &(?:quot|#34);BH22 area&(?:quot|#34);/);
    assert.match(overlapBody, /cannot be stacked or combined/);
    assert.equal(fareSettings.snapshot().configuration.locationDiscounts?.length, 1);

    const dated = await post("1", discountFields({ name: "Later promotion", postcodes: "BH22 8AB", startDate: "2027-01-01" }));
    assert.equal(dated.status, 400, "an open-ended rule overlaps every later period");

    const stale = await post("0", discountFields({ name: "Stale" }));
    assert.equal(stale.status, 409);
    assert.match(await stale.text(), /value="Stale"/);
  });

  test("Location-based discounts cannot enable a rule whose location is unavailable", async () => {
    fareSettings.reset();
    airportFees.reset();
    poiManagement.reset();
    poiManagement.pois.push(slabPoi("poi-pier", "Bournemouth Pier"));
    const { post } = discountsClient("sid=discounts-enable");
    assert.equal((await post("0", discountFields({ name: "Pier", locationKey: "poi:poi-pier" }))).status, 303);
    const [rule] = fareSettings.snapshot().configuration.locationDiscounts!;
    poiManagement.reset();
    const rejected = await post("1", { ruleAction: "enable", ruleId: rule.id });
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /was not enabled\. The selected airport or POI is missing or no longer available/);
    assert.equal(fareSettings.snapshot().configuration.locationDiscounts![0].enabled, false);
  });

  test("Location-based discount changes keep System Settings authorization", async () => {
    fareSettings.reset();
    for (const suffix of ["", "/new", "/any-rule/edit", "/any-rule/remove"]) {
      const denied = await fetch(`${baseUrl}/settings/fare-settings/location-based-discounts${suffix}`, {
        headers: withSession("sid=discounts-denied", ["admin", "staff", "tech_support"]),
        redirect: "manual"
      });
      assert.equal(denied.status, 403, suffix);
      const anonymous = await fetch(`${baseUrl}/settings/fare-settings/location-based-discounts${suffix}`, { redirect: "manual" });
      assert.equal(anonymous.status, 302, suffix);
      assert.equal(anonymous.headers.get("location"), "/access");
    }
    const anonymousPost = await fetch(`${baseUrl}/settings/fare-settings/location-based-discounts`, { method: "POST", redirect: "manual" });
    assert.notEqual(anonymousPost.status, 303);
    assert.equal(fareSettings.snapshot().currentVersion, 0);
  });

  test("location-based discount configuration is read only by settings and the New Booking pricing service", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|ejs|js)$/.test(entry) && !/\.test\.ts$/.test(entry)) sources.push(full);
      }
    };
    walk("src");
    walk("public/js");
    const readers = sources.filter((file) => /locationDiscounts|matchLocationDiscount|LocationDiscounts|calculateJourneyFare|resolveJourneyLocationDiscount/.test(readFileSync(file, "utf8")));
    assert.deepEqual(readers.sort(), [
      "src/routes/role-sections.ts",
      "src/services/booking-pricing.ts",
      "src/services/fare-calculation.ts",
      "src/services/fare-settings.ts",
      "src/views/pages/fare-settings.ejs"
    ], "only Fare Settings and the fare calculation service read discount rules; no booking surface calls it yet");
  });

  const radiusClient = (cookie: string) => {
    const path = "/settings/fare-settings/operational-base-radius-discounts";
    const getPage = (suffix = "") => fetch(`${baseUrl}${path}${suffix}`, { headers: withSession(cookie, ["superuser"]), redirect: "manual" });
    const post = async (version: string, values: Record<string, string>) => {
      const page = await getPage();
      const body = await page.text();
      const csrfCookie = page.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
      const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfCookie && token);
      const postCookie = `${cookie}; ${csrfCookie}`;
      withSession(postCookie, ["superuser"]);
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { cookie: postCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ baseVersion: version, _csrf: token, ...values }),
        redirect: "manual"
      });
    };
    return { path, getPage, post };
  };
  const verifiedRadiusBase = (): OperationalBase => ({
    operatorId: "test-operator",
    latitude: 50.71,
    longitude: -2.44,
    providerPlaceId: "verified-operational-point",
    coordinatesVerified: true,
    updatedAt: "2026-11-10T12:00:00.000Z"
  });
  const radiusFields = (overrides: Record<string, string> = {}) => ({
    name: "Base area to Heathrow",
    locationKey: "airport:rm-lhr",
    radiusMiles: "10",
    discountPercentage: "15",
    startDate: "",
    endDate: "",
    enabled: "no",
    ...overrides
  });

  test("Operational-base radius discounts are listed in Fare Settings, unseeded, and explain precedence", async () => {
    fareSettings.reset();
    operationalBase = verifiedRadiusBase();
    airportFees.reset();
    airportFees.records.push(slabAirport("rm-lhr", "Heathrow Airport"));
    const headers = withSession("sid=radius-nav", ["superuser"]);
    const landing = await (await fetch(`${baseUrl}/settings/fare-settings`, { headers })).text();
    assert.match(landing, /href="\/settings\/fare-settings\/operational-base-radius-discounts"/);
    assert.match(landing, />Operational-base radius discounts</);

    const page = await (await fetch(`${baseUrl}/settings/fare-settings/operational-base-radius-discounts`, { headers })).text();
    assert.match(page, /No operational-base radius discounts have been configured/);
    assert.match(page, /data-radius-discount-pricing-note/);
    assert.match(page, /Not yet applied to booking prices/);
    assert.match(page, /data-radius-discount-centre/);
    assert.match(page, /50\.71, -2\.44/);

    const editor = await (await fetch(`${baseUrl}/settings/fare-settings/operational-base-radius-discounts/new`, { headers })).text();
    assert.match(editor, /data-radius-discount-form/);
    assert.match(editor, /value="airport:rm-lhr"[^>]*>Heathrow Airport/);
    assert.match(editor, /name="enabled" value="no" checked/, "new rules default to disabled");
    for (const semantic of [/either direction/i, /internal RideMatrix ID/i, /boundary is included/i, /no discount/i, /stack/i, /Distance Slabs/]) {
      assert.match(editor, semantic);
    }
    assert.equal(fareSettings.snapshot().currentVersion, 0, "viewing does not seed configuration");
  });

  test("Operational-base radius discounts create, edit, enable, disable and remove with history, leaving other settings unchanged", async () => {
    fareSettings.reset();
    operationalBase = verifiedRadiusBase();
    airportFees.reset();
    poiManagement.reset();
    airportFees.records.push(slabAirport("rm-lhr", "Heathrow Airport"));
    const { path, getPage, post } = radiusClient("sid=radius-crud");
    const slabPost = additionalSlabsClient("sid=radius-crud").post;
    assert.equal((await slabPost("/settings/fare-settings/distance-slabs", "0", slabFields("3.00"))).status, 303);
    const discountsPost = discountsClient("sid=radius-crud").post;
    assert.equal((await discountsPost("1", {
      name: "Heathrow postcode promotion", locationKey: "airport:rm-lhr", postcodePrecision: "outward", postcodes: "DT1",
      discountPercentage: "20", startDate: "", endDate: "", enabled: "yes"
    })).status, 303);
    const before = fareSettings.snapshot().configuration;

    const created = await post("2", radiusFields({ radiusMiles: "10.500" }));
    assert.equal(created.status, 303);
    assert.equal(created.headers.get("location"), `${path}?saved=1`);
    let snapshot = fareSettings.snapshot();
    const [rule] = snapshot.configuration.radiusLocationDiscounts!;
    assert.deepEqual({ ...rule, id: "" }, {
      id: "",
      name: "Base area to Heathrow",
      location: { type: "airport", id: "rm-lhr" },
      radiusMiles: "10.5",
      discountPercentage: "15",
      startDate: "",
      endDate: "",
      enabled: false,
      radiusCentre: "operational-base",
      discountBasis: "standard-distance-slabs-base-fare"
    });
    assert.equal(snapshot.history[0].actorEmail, "bookings@romanairporttransfers.co.uk");

    const list = await (await getPage()).text();
    assert.match(list, /Base area to Heathrow/);
    assert.match(list, /Heathrow Airport/);
    assert.match(list, /Disabled/);
    assert.match(list, /Configuration history/);
    assert.match(await (await getPage(`/${rule.id}/edit`)).text(), /value="10\.5"/);

    assert.equal((await post("3", radiusFields({ ruleId: rule.id, radiusMiles: "12", startDate: "2027-01-01", endDate: "2027-12-31" }))).status, 303);
    assert.deepEqual(fareSettings.snapshot().configuration.radiusLocationDiscounts![0], { ...rule, radiusMiles: "12", startDate: "2027-01-01", endDate: "2027-12-31" });
    assert.equal((await post("4", { ruleAction: "enable", ruleId: rule.id })).status, 303);
    assert.equal(fareSettings.snapshot().configuration.radiusLocationDiscounts![0].enabled, true);
    assert.match(await (await getPage()).text(), /Enabled/);
    assert.equal((await post("5", { ruleAction: "disable", ruleId: rule.id })).status, 303);
    assert.equal(fareSettings.snapshot().configuration.radiusLocationDiscounts![0].enabled, false);
    assert.match(await (await getPage(`/${rule.id}/remove`)).text(), /Yes, remove this discount/);
    assert.equal((await post("6", { ruleAction: "delete", ruleId: rule.id })).status, 303);

    snapshot = fareSettings.snapshot();
    assert.deepEqual(snapshot.configuration.radiusLocationDiscounts, []);
    assert.equal(snapshot.history.length, 7, "each change is appended to Fare Settings history");
    const { radiusLocationDiscounts: _after, ...otherAfter } = snapshot.configuration;
    const { radiusLocationDiscounts: _before, ...otherBefore } = before;
    assert.deepEqual(otherAfter, otherBefore, "postcode discounts, slabs, surcharges and the dead-mileage free radius are unchanged");

    assert.equal((await getPage("/missing/edit")).status, 404);
    assert.equal((await post("7", { ruleAction: "delete", ruleId: "missing" })).status, 404);
  });

  test("Operational-base radius discounts reject invalid, overlapping and unverified-base rules clearly", async () => {
    fareSettings.reset();
    operationalBase = verifiedRadiusBase();
    airportFees.reset();
    airportFees.records.push(slabAirport("rm-lhr", "Heathrow Airport"));
    const { post, getPage } = radiusClient("sid=radius-invalid");

    const invalid = await post("0", radiusFields({ radiusMiles: "0", discountPercentage: "101", startDate: "2027-02-01", endDate: "2027-01-01", locationKey: "Heathrow Airport" }));
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.text();
    assert.match(invalidBody, /radius greater than 0/);
    assert.match(invalidBody, /percentage greater than 0 and no more than 100/);
    assert.match(invalidBody, /end date cannot be before the start date/);
    assert.match(invalidBody, /missing or no longer available/);
    assert.match(invalidBody, /id="radius-discount-radius"[^>]*value="0"[^>]*aria-invalid="true"/);
    assert.equal(fareSettings.snapshot().currentVersion, 0);

    assert.equal((await post("0", radiusFields({ name: "First", enabled: "yes" }))).status, 303);
    const overlap = await post("1", radiusFields({ name: "Second", radiusMiles: "20", startDate: "2027-01-01" }));
    assert.equal(overlap.status, 400);
    assert.match(await overlap.text(), /already has the operational-base radius discount &(?:quot|#34);First&(?:quot|#34);.*cannot be stacked, combined or chosen between/s);
    assert.equal(fareSettings.snapshot().configuration.radiusLocationDiscounts?.length, 1);

    const stale = await post("0", radiusFields({ name: "Stale", startDate: "2030-01-01" }));
    assert.equal(stale.status, 409);

    const [first] = fareSettings.snapshot().configuration.radiusLocationDiscounts!;
    assert.equal((await post("1", { ruleAction: "disable", ruleId: first.id })).status, 303);
    const saved = operationalBase;
    operationalBase = { ...saved!, coordinatesVerified: false };
    try {
      const page = await (await getPage()).text();
      assert.match(page, /The operational base has no verified coordinates/);
      const unverified = await post("2", radiusFields({ name: "Later", startDate: "2030-01-01" }));
      assert.equal(unverified.status, 400);
      assert.match(await unverified.text(), /operational base has no verified coordinates/);
      const enable = await post("2", { ruleAction: "enable", ruleId: first.id });
      assert.equal(enable.status, 400);
      assert.equal(fareSettings.snapshot().configuration.radiusLocationDiscounts![0].enabled, false);
    } finally {
      operationalBase = saved;
    }
  });

  test("Operational-base radius discount changes keep System Settings authorization", async () => {
    fareSettings.reset();
    for (const suffix of ["", "/new", "/any-rule/edit", "/any-rule/remove"]) {
      const denied = await fetch(`${baseUrl}/settings/fare-settings/operational-base-radius-discounts${suffix}`, {
        headers: withSession("sid=radius-denied", ["admin", "staff", "tech_support"]),
        redirect: "manual"
      });
      assert.equal(denied.status, 403, suffix);
      const anonymous = await fetch(`${baseUrl}/settings/fare-settings/operational-base-radius-discounts${suffix}`, { redirect: "manual" });
      assert.equal(anonymous.status, 302, suffix);
    }
    const anonymousPost = await fetch(`${baseUrl}/settings/fare-settings/operational-base-radius-discounts`, { method: "POST", redirect: "manual" });
    assert.notEqual(anonymousPost.status, 303);
    assert.equal(fareSettings.snapshot().currentVersion, 0);
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
    for (const destination of ["distance-slabs", "additional-distance-slabs", "additional-distance-slabs/new", "minimum-fare-rules", "fixed-fares", "location-based-discounts", "location-based-discounts/new", "operational-base-radius-discounts", "operational-base-radius-discounts/new"]) {
      const denied = await fetch(`${baseUrl}/settings/fare-settings/${destination}`, {
        headers: withSession(`sid=fare-denied-${destination}`, ["admin", "staff", "tech_support"]),
        redirect: "manual"
      });
      assert.equal(denied.status, 403);
      assert.match(await denied.text(), /does not include the System Control role required for System settings/);
    }
    const anonymous = await fetch(`${baseUrl}/settings/fare-settings`, {
      headers: { cookie: "sid=fare-anonymous" },
      redirect: "manual"
    });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get("location"), "/access");
  });

  const listedVersions = (html: string) => [...html.matchAll(/<li><strong>Version (\d+)<\/strong>/g)].map((match) => Number(match[1]));
  const feeScheduleHistoryLeaves = [
    { scheme: "london-lez", path: "/settings/toll-fees/london-lez-ulez-congestion-charge/london-lez/fee-settings" },
    { scheme: "london-ulez", path: "/settings/toll-fees/london-lez-ulez-congestion-charge/london-ulez/fee-settings" },
    { scheme: "dartford-crossing", path: "/settings/toll-fees/dartford-crossing/fee-settings" },
    { scheme: "blackwall-silvertown-tunnels", path: "/settings/toll-fees/blackwall-silvertown-tunnels/fee-settings" }
  ] as const;

  test("every Fare Settings page shows at most 3 recent history entries and links to full history only when there are more", async () => {
    const headers = withSession("sid=fare-history-recent", ["superuser"]);
    const configurable = fareSettingsCategories.filter((category) => category.configurable);
    assert.ok(configurable.some((category) => category.slug === "additional-distance-slabs"));

    fareSettings.reset();
    fareSettings.seedHistory(3);
    for (const category of configurable) {
      const body = await (await fetch(`${baseUrl}/settings/fare-settings/${category.slug}`, { headers })).text();
      assert.deepEqual(listedVersions(body), [3, 2, 1], `${category.slug} shows all of a short history`);
      assert.doesNotMatch(body, /View all history/, `${category.slug} has no full-history link at exactly 3 entries`);
    }

    fareSettings.seedHistory(25);
    for (const category of configurable) {
      const body = await (await fetch(`${baseUrl}/settings/fare-settings/${category.slug}`, { headers })).text();
      assert.deepEqual(listedVersions(body), [25, 24, 23], `${category.slug} shows only the newest 3 entries`);
      assert.match(body, /<a href="\/settings\/fare-settings\/history">View all history<span class="visually-hidden"> for Fare Settings configuration<\/span><\/a>/);
      assert.match(body, /Showing the 3 most recent of 25 versions, newest first\./);
    }
    assert.equal(fareSettings.snapshot().history.length, 25, "rendering never removes stored history");
    fareSettings.reset();
  });

  test("Fare Settings history page paginates newest first and validates the page parameter", async () => {
    const headers = withSession("sid=fare-history-page", ["superuser"]);
    const historyPath = "/settings/fare-settings/history";
    fareSettings.reset();
    const empty = await (await fetch(`${baseUrl}${historyPath}`, { headers })).text();
    assert.match(empty, /No changes have been saved yet\./);
    assert.match(empty, /Page 1 of 1/);

    fareSettings.seedHistory(45);
    const first = await fetch(`${baseUrl}${historyPath}`, { headers });
    const firstBody = await first.text();
    assert.equal(first.status, 200);
    assert.deepEqual(listedVersions(firstBody), Array.from({ length: 20 }, (_, index) => 45 - index));
    assert.match(firstBody, /aria-label="Configuration history pagination"/);
    assert.match(firstBody, /Showing <strong>1<\/strong>-<strong>20<\/strong> of <strong>45<\/strong>/);
    assert.match(firstBody, /Page 1 of 3/);
    assert.match(firstBody, /<span class="pagination-bar__link pagination-bar__link--disabled" aria-disabled="true">Previous<\/span>/);
    assert.match(firstBody, /href="\/settings\/fare-settings\/history\?page=2" rel="next">Next</);
    assert.match(firstBody, /<a href="\/settings\/fare-settings">Fare Settings<\/a>/);

    const second = await (await fetch(`${baseUrl}${historyPath}?page=2`, { headers })).text();
    assert.deepEqual(listedVersions(second), Array.from({ length: 20 }, (_, index) => 25 - index));
    assert.match(second, /href="\/settings\/fare-settings\/history" rel="prev">Previous</);
    assert.match(second, /href="\/settings\/fare-settings\/history\?page=3" rel="next">Next</);

    const last = await (await fetch(`${baseUrl}${historyPath}?page=3`, { headers })).text();
    assert.deepEqual(listedVersions(last), [5, 4, 3, 2, 1]);
    assert.match(last, /Page 3 of 3/);
    assert.match(last, /aria-disabled="true">Next<\/span>/);

    for (const invalid of ["abc", "0", "-1", "1.5", "2abc", ""]) {
      const response = await fetch(`${baseUrl}${historyPath}?page=${encodeURIComponent(invalid)}`, { headers });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /Page 1 of 3/, `invalid page ${JSON.stringify(invalid)} falls back to page 1`);
      assert.equal(listedVersions(body)[0], 45);
    }
    const outOfRange = await fetch(`${baseUrl}${historyPath}?page=99`, { headers });
    assert.equal(outOfRange.status, 200);
    const outOfRangeBody = await outOfRange.text();
    assert.match(outOfRangeBody, /Page 3 of 3/, "out-of-range pages show the last page");
    assert.deepEqual(listedVersions(outOfRangeBody), [5, 4, 3, 2, 1]);
    fareSettings.reset();
  });

  test("draft fee schedule pages show 3 recent versions, link to a paginated history, and keep version numbering", async () => {
    const headers = withSession("sid=fee-history", ["superuser"]);
    for (const leaf of feeScheduleHistoryLeaves) {
      feeSchedules.reset();
      const initial = await (await fetch(`${baseUrl}${leaf.path}`, { headers })).text();
      // Migration 0035 appended a structured version 2 on top of each legacy draft except Dartford.
      assert.deepEqual(listedVersions(initial), leaf.scheme === "dartford-crossing" ? [1] : [2, 1]);
      assert.doesNotMatch(initial, /View all history/, `${leaf.scheme} has no full-history link with one version`);

      feeSchedules.seedHistory(leaf.scheme, 23);
      const settings = await (await fetch(`${baseUrl}${leaf.path}`, { headers })).text();
      assert.deepEqual(listedVersions(settings), [23, 22, 21], `${leaf.scheme} shows only the newest 3 versions`);
      assert.ok(settings.includes(`<a href="${leaf.path}/history">View all history`), `${leaf.scheme} links to its own history`);

      const firstPage = await fetch(`${baseUrl}${leaf.path}/history`, { headers });
      const firstBody = await firstPage.text();
      assert.equal(firstPage.status, 200);
      assert.match(firstBody, leaf.scheme === "dartford-crossing" ? /Draft version history/ : /Version history/);
      assert.deepEqual(listedVersions(firstBody), Array.from({ length: 20 }, (_, index) => 23 - index));
      assert.match(firstBody, /Page 1 of 2/);
      assert.ok(firstBody.includes(`href="${leaf.path}/history?page=2" rel="next"`));
      assert.ok(firstBody.includes(`<a href="${leaf.path}">`), "breadcrumb links back to the fee settings page");

      const secondBody = await (await fetch(`${baseUrl}${leaf.path}/history?page=2`, { headers })).text();
      assert.deepEqual(listedVersions(secondBody), [3, 2, 1]);
      const clamped = await (await fetch(`${baseUrl}${leaf.path}/history?page=500`, { headers })).text();
      assert.deepEqual(listedVersions(clamped), [3, 2, 1]);
      const invalid = await (await fetch(`${baseUrl}${leaf.path}/history?page=nope`, { headers })).text();
      assert.match(invalid, /Page 1 of 2/);
    }

    // Saving still appends the next version on top of the existing history.
    feeSchedules.reset();
    feeSchedules.seedHistory("london-lez", 23);
    const lezPath = feeScheduleHistoryLeaves[0].path;
    const page = await fetch(`${baseUrl}${lezPath}`, { headers });
    const pageBody = await page.text();
    const csrfCookie = page.headers.get("set-cookie")?.match(/rm_csrf=[^;]+/)?.[0];
    const token = pageBody.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrfCookie);
    assert.ok(token);
    sessionsByCookie.set(`sid=fee-history; ${csrfCookie}`, sessionsByCookie.get("sid=fee-history"));
    const form = roadChargeForm("london-lez", token, 23);
    const saved = await fetch(`${baseUrl}${lezPath}`, {
      method: "POST",
      headers: { cookie: `sid=fee-history; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "manual"
    });
    assert.equal(saved.status, 303);
    assert.deepEqual(feeSchedules.history("london-lez").map((entry) => entry.version), Array.from({ length: 24 }, (_, index) => 24 - index));
    const afterSave = await (await fetch(`${baseUrl}${lezPath}`, { headers })).text();
    assert.deepEqual(listedVersions(afterSave), [24, 23, 22]);
    feeSchedules.reset();
  });

  test("configuration history pages enforce System Settings authorization", async () => {
    fareSettings.reset();
    fareSettings.seedHistory(25);
    const paths = ["/settings/fare-settings/history", ...feeScheduleHistoryLeaves.map((leaf) => `${leaf.path}/history`)];
    for (const path of paths) {
      const denied = await fetch(`${baseUrl}${path}`, {
        headers: withSession("sid=history-denied", ["admin", "staff", "tech_support"]),
        redirect: "manual"
      });
      assert.equal(denied.status, 403, `${path} denies non-superusers`);
      const deniedBody = await denied.text();
      assert.match(deniedBody, /does not include the System Control role required for System settings/);
      assert.doesNotMatch(deniedBody, /<strong>Version \d+<\/strong>/);

      const anonymous = await fetch(`${baseUrl}${path}?page=2`, { headers: { cookie: "sid=history-anonymous" }, redirect: "manual" });
      assert.equal(anonymous.status, 302, `${path} redirects anonymous sessions`);
      assert.equal(anonymous.headers.get("location"), "/access");
    }
    fareSettings.reset();
  });
});
