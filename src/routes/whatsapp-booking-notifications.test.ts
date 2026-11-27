import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import { SessionAccount } from "../services/api";
import type { WhatsAppSettingsRouterOptions } from "./whatsapp-booking-notifications";
import { createWhatsAppBookingNotificationsRouter } from "./whatsapp-booking-notifications";

const BASE = "/settings/messaging";

function sessionFor(roles: string[]): SessionAccount {
  return {
    authenticated: true,
    user: { id: "settings-user", email: "settings@example.com", roles, active_role: roles[0] }
  };
}

function createServer(session: SessionAccount, overrides: Partial<WhatsAppSettingsRouterOptions> = {}) {
  const app = express();
  app.set("views", path.join(process.cwd(), "src/views"));
  app.set("view engine", "ejs");
  app.use(express.urlencoded({ extended: false }));
  app.use(createCsrfProtection({ appTitle: "WhatsApp Settings Test", cookieSecure: false }));
  app.use(createWhatsAppBookingNotificationsRouter({
    appTitle: "WhatsApp Settings Test",
    loadSession: async () => session,
    getSwitch: async () => ({ enabled: false, updatedAt: "2030-01-01T00:00:00Z", updatedByEmail: null }),
    getEmailSettings: async () => ({ enabled: false, deliveryMode: "ses", updatedAt: "2030-01-01T00:00:00Z", updatedByEmail: null }),
    listSettings: async () => [],
    isApiConfigured: () => false,
    ...overrides
  }));
  return app.listen(0);
}

async function withServer<T>(
  session: SessionAccount,
  run: (baseUrl: string) => Promise<T>,
  overrides: Partial<WhatsAppSettingsRouterOptions> = {}
): Promise<T> {
  const server = createServer(session, overrides);
  const port = (server.address() as { port: number }).port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("Messaging settings are forbidden to non-superusers", async () => {
  await withServer(sessionFor(["admin"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}`, { redirect: "manual" });
    assert.equal(response.status, 403);
  });
});

test("Messaging settings redirect unauthenticated visitors to access", async () => {
  await withServer({ authenticated: false }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}/whatsapp/templates`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
  });
});

test("Messaging hierarchy pages render their child navigation", async () => {
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const messagingResponse = await fetch(`${baseUrl}${BASE}`);
    assert.equal(messagingResponse.status, 200);
    const messagingBody = await messagingResponse.text();
    assert.match(messagingBody, /WhatsApp \(On\/Off\)/);
    assert.match(messagingBody, /Configure Email \(On\/Off\)/);
    assert.match(messagingBody, /Email templates/);

    const whatsappResponse = await fetch(`${baseUrl}${BASE}/whatsapp`);
    assert.equal(whatsappResponse.status, 200);
    assert.match(await whatsappResponse.text(), /WhatsApp messaging on/);

    const templatesResponse = await fetch(`${baseUrl}${BASE}/whatsapp/templates`);
    assert.equal(templatesResponse.status, 200);
    const templatesBody = await templatesResponse.text();
    assert.match(templatesBody, /<h1>Templates<\/h1>/);
    assert.match(templatesBody, /WhatsApp API is not configured/);
  });
});

test("WhatsApp settings POST without a CSRF token is rejected before any save", async () => {
  let saved = false;
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ enabled: "on" }),
      redirect: "manual"
    });
    assert.notEqual(response.status, 303, "a POST without a CSRF token must not save");
    assert.ok(response.status >= 400, `expected rejection, got ${response.status}`);
  }, {
    saveSwitch: async () => {
      saved = true;
      return { enabled: true, deliveryMode: "ses", updatedAt: "2030-01-01T00:00:00Z", updatedByEmail: "settings@example.com" };
    }
  });
  assert.equal(saved, false);
});

test("WhatsApp cannot be switched on before API configuration is present", async () => {
  let saved = false;
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const page = await fetch(`${baseUrl}${BASE}/whatsapp`);
    const cookie = page.headers.get("set-cookie")?.split(";")[0];
    const body = await page.text();
    const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(cookie);
    assert.ok(token);

    const response = await fetch(`${baseUrl}${BASE}/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie
      },
      body: new URLSearchParams({ _csrf: token, enabled: "on" }),
      redirect: "manual"
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${BASE}/whatsapp?notice=configuration-required`);
  }, {
    saveSwitch: async () => {
      saved = true;
      return { enabled: true, deliveryMode: "ses", updatedAt: "2030-01-01T00:00:00Z", updatedByEmail: "settings@example.com" };
    }
  });
  assert.equal(saved, false);
});
