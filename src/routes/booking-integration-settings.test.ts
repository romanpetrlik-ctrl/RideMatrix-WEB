import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import type { SessionAccount } from "../services/api";
import type { MicrosoftDispatchCalendarSettings } from "../services/microsoft-dispatch-calendar-settings";
import { createBookingIntegrationSettingsRouter } from "./booking-integration-settings";

const BASE = "/settings/booking-integrations";
const dispatchCalendar: MicrosoftDispatchCalendarSettings = {
  tenantId: "tenant-id",
  clientId: "application-id",
  calendarUser: "dispatch@example.test",
  calendarId: "calendar-id",
  configured: true,
  clientSecretSaved: true,
  enabled: false,
  tested: true,
  encryptionAvailable: true,
  source: "database",
  updatedAt: "2030-01-01T00:00:00Z",
  updatedByEmail: null
};

function sessionFor(roles: string[]): SessionAccount {
  return { authenticated: true, user: { id: "superuser-1", email: "settings@example.test", roles } };
}

function createServer(session: SessionAccount, overrides: Record<string, unknown> = {}) {
  const app = express();
  app.set("views", path.join(process.cwd(), "src/views"));
  app.set("view engine", "ejs");
  app.use(express.urlencoded({ extended: false }));
  app.use(createCsrfProtection({ appTitle: "Integration Settings Test", cookieSecure: false }));
  app.use(createBookingIntegrationSettingsRouter({
    appTitle: "Integration Settings Test",
    loadSession: async () => session,
    getBookingSettings: async () => ({
      minimumOnlineNoticeHours: 12,
      updatedAt: "2030-01-01T00:00:00Z",
      updatedByEmail: null
    }),
    getStripeSummary: async () => ({
      enabled: false,
      mode: "test",
      testConfigured: false,
      liveConfigured: false,
      encryptionAvailable: true,
      publicUrlConfigured: false,
      verifiedMode: null,
      updatedAt: null,
      updatedByEmail: null
    }),
    getEmailSettings: async () => ({
      enabled: false,
      deliveryMode: "ses",
      sesConfig: { configured: false, host: "", port: 587, from: "" },
      mailpitConfig: { configured: false, host: "", port: 1025, from: "ridematrix@localhost" },
      deliveryConfigured: false,
      verifiedDeliveryMode: null,
      deliveryTested: false,
      updatedAt: "2030-01-01T00:00:00Z",
      updatedByEmail: null
    }),
    getDispatchCalendarSettings: async () => dispatchCalendar,
    ...overrides
  }));
  return app.listen(0);
}

async function withServer<T>(
  session: SessionAccount,
  run: (baseUrl: string) => Promise<T>,
  overrides: Record<string, unknown> = {}
): Promise<T> {
  const server = createServer(session, overrides);
  const port = (server.address() as { port: number }).port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function csrfFor(baseUrl: string): Promise<{ cookie: string; token: string }> {
  const page = await fetch(`${baseUrl}${BASE}`);
  const cookie = page.headers.get("set-cookie")?.split(";")[0];
  const body = await page.text();
  const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(cookie);
  assert.ok(token);
  return { cookie, token };
}

test("booking integration settings remain superuser-only", async () => {
  await withServer(sessionFor(["admin"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}`);
    assert.equal(response.status, 403);
  });
});

test("booking integration settings show Microsoft calendar form without rendering its secret", async () => {
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /Microsoft 365 dispatch calendar/);
    assert.match(body, /Test connection and calendar access/);
    assert.match(body, /Enable synchronization/);
    assert.match(body, /name="clientSecret" type="password"/);
    assert.match(body, /name="calendarId"[^>]+value="calendar-id"/);
  });
});

test("Microsoft dispatch calendar credentials require CSRF and are passed to the save service", async () => {
  let saved: Record<string, unknown> | undefined;
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const { cookie, token } = await csrfFor(baseUrl);
    const response = await fetch(`${baseUrl}${BASE}/calendar/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({
        _csrf: token,
        tenantId: "tenant-a",
        clientId: "client-a",
        clientSecret: "secret-a",
        calendarUser: "dispatch@example.test",
        calendarId: "calendar-a"
      }),
      redirect: "manual"
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${BASE}?notice=calendar-saved`);
  }, {
    saveDispatchCalendarCredentials: async (input: Record<string, unknown>) => {
      saved = input;
      return dispatchCalendar;
    }
  });
  assert.equal(saved?.tenantId, "tenant-a");
  assert.equal(saved?.calendarId, "calendar-a");
  assert.equal(saved?.actorEmail, "settings@example.test");
});

test("Microsoft calendar connection test and enable actions are CSRF protected", async () => {
  let tested = false;
  let enabled: boolean | undefined;
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const { cookie, token } = await csrfFor(baseUrl);
    const testResponse = await fetch(`${baseUrl}${BASE}/calendar/test`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ _csrf: token }),
      redirect: "manual"
    });
    assert.equal(testResponse.status, 303);
    assert.equal(testResponse.headers.get("location"), `${BASE}?notice=calendar-tested`);
    const enableResponse = await fetch(`${baseUrl}${BASE}/calendar/switch`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ _csrf: token, enabled: "on" }),
      redirect: "manual"
    });
    assert.equal(enableResponse.status, 303);
    assert.equal(enableResponse.headers.get("location"), `${BASE}?notice=calendar-enabled`);
  }, {
    testDispatchCalendarConnection: async () => { tested = true; },
    setDispatchCalendarEnabled: async ({ enabled: value }: { enabled: boolean }) => { enabled = value; }
  });
  assert.equal(tested, true);
  assert.equal(enabled, true);
});
