import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import type { SessionAccount } from "../services/api";
import type { StripeSettingsSummary } from "../services/stripe-settings";
import { createStripeSettingsRouter } from "./stripe-settings";

const BASE = "/settings/payments/stripe";
const summary: StripeSettingsSummary = {
  enabled: false,
  mode: "test",
  testConfigured: true,
  liveConfigured: false,
  encryptionAvailable: true,
  publicUrlConfigured: true,
  verifiedMode: null,
  updatedAt: null,
  updatedByEmail: null
};

function sessionFor(roles: string[]): SessionAccount {
  return { authenticated: true, user: { id: "superuser-1", email: "settings@example.com", roles, active_role: roles[0] } };
}

function createServer(session: SessionAccount, overrides: Record<string, unknown> = {}) {
  const app = express();
  app.set("views", path.join(process.cwd(), "src/views"));
  app.set("view engine", "ejs");
  app.use(express.urlencoded({ extended: false }));
  app.use(createCsrfProtection({ appTitle: "Stripe Settings Test", cookieSecure: false }));
  app.use(createStripeSettingsRouter({
    appTitle: "Stripe Settings Test",
    loadSession: async () => session,
    getSummary: async () => summary,
    saveCredentials: async () => summary,
    testConnection: async () => "test",
    setEnabled: async () => undefined,
    ...overrides
  }));
  return app.listen(0);
}

async function withServer<T>(session: SessionAccount, run: (baseUrl: string) => Promise<T>, overrides: Record<string, unknown> = {}): Promise<T> {
  const server = createServer(session, overrides);
  const port = (server.address() as { port: number }).port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("Stripe settings are restricted to superusers", async () => {
  await withServer(sessionFor(["admin"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}`, { redirect: "manual" });
    assert.equal(response.status, 403);
  });
});

test("Stripe settings page shows credential status without rendering secret values", async () => {
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const body = await response.text();
    assert.match(body, /Stripe API credentials/);
    assert.match(body, /Test keys: Configured/);
    assert.doesNotMatch(body, /sk_test_|whsec_/);
  });
});

test("Stripe credential changes require a CSRF token", async () => {
  let saved = false;
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mode: "test", secretKey: "sk_test_private" }),
      redirect: "manual"
    });
    assert.ok(response.status >= 400);
  }, {
    saveCredentials: async () => {
      saved = true;
      return summary;
    }
  });
  assert.equal(saved, false);
});

test("Stripe secrets are accepted only from a CSRF-protected save and never returned in the page", async () => {
  let receivedSecret = "";
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const page = await fetch(`${baseUrl}${BASE}`);
    const cookie = page.headers.get("set-cookie")?.split(";")[0];
    const body = await page.text();
    const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(cookie);
    assert.ok(token);
    const response = await fetch(`${baseUrl}${BASE}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ _csrf: token, mode: "test", secretKey: "sk_test_private" }),
      redirect: "manual"
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${BASE}?notice=saved`);
  }, {
    saveCredentials: async (input: { secretKey: string }) => {
      receivedSecret = input.secretKey;
      return summary;
    }
  });
  assert.equal(receivedSecret, "sk_test_private");
});
