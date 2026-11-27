import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import type { SessionAccount } from "../services/api";
import type { EmailTemplate } from "../services/email-templates";
import { createEmailSettingsRouter } from "./email-settings";

const BASE = "/settings/messaging/email";
const template: EmailTemplate = {
  eventType: "payment_link",
  subjectTemplate: "Payment for {{reference}}",
  bodyTemplate: "Pay here: {{paymentUrl}}",
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
  app.use(createCsrfProtection({ appTitle: "Email Settings Test", cookieSecure: false }));
  app.use(createEmailSettingsRouter({
    appTitle: "Email Settings Test",
    loadSession: async () => session,
    getSettings: async () => ({ enabled: false, deliveryMode: "ses", updatedAt: "2030-01-01T00:00:00Z", updatedByEmail: null }),
    saveSettings: async () => undefined,
    listTemplates: async () => [template],
    getTemplate: async () => template,
    saveTemplate: async () => template,
    isDeliveryConfigured: () => true,
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

test("email settings and templates are restricted to superusers", async () => {
  await withServer(sessionFor(["admin"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}/templates`);
    assert.equal(response.status, 403);
  });
});

test("email templates provide a preview and supported-variable reference", async () => {
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}/templates/payment_link`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Preview/);
    assert.match(body, /https:\/\/checkout\.stripe\.com\/example/);
    assert.match(body, /{{payerName}}/);
  });
});

test("email settings page offers SES and Mailpit delivery modes", async () => {
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /Mailpit sandbox/);
    assert.match(body, /Amazon SES/);
  });
});

test("email settings cannot be switched on without the selected SMTP configuration", async () => {
  let saved = false;
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}`, { redirect: "manual" });
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    const body = await response.text();
    const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(cookie);
    assert.ok(token);
    const post = await fetch(`${baseUrl}${BASE}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ _csrf: token, deliveryMode: "ses", enabled: "on" }),
      redirect: "manual"
    });
    assert.equal(post.status, 303);
    assert.equal(post.headers.get("location"), `${BASE}?notice=configuration-required`);
  }, {
    isDeliveryConfigured: () => false,
    saveSettings: async () => {
      saved = true;
    }
  });
  assert.equal(saved, false);
});

test("Mailpit sandbox can be enabled without SES when its SMTP endpoint is configured", async () => {
  let saved: { enabled: boolean; deliveryMode: string } | undefined;
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const page = await fetch(`${baseUrl}${BASE}`);
    const cookie = page.headers.get("set-cookie")?.split(";")[0];
    const body = await page.text();
    const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(cookie);
    assert.ok(token);
    const response = await fetch(`${baseUrl}${BASE}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ _csrf: token, deliveryMode: "mailpit", enabled: "on" }),
      redirect: "manual"
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${BASE}?notice=saved`);
  }, {
    isDeliveryConfigured: (mode: string) => mode === "mailpit",
    saveSettings: async ({ enabled, deliveryMode }: { enabled: boolean; deliveryMode: string }) => {
      saved = { enabled, deliveryMode };
    }
  });
  assert.deepEqual(saved, { enabled: true, deliveryMode: "mailpit" });
});

test("email delivery mode cannot be changed while email messaging is enabled", async () => {
  let saved = false;
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const page = await fetch(`${baseUrl}${BASE}`);
    const cookie = page.headers.get("set-cookie")?.split(";")[0];
    const body = await page.text();
    const token = body.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(cookie);
    assert.ok(token);
    const response = await fetch(`${baseUrl}${BASE}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ _csrf: token, deliveryMode: "mailpit", enabled: "on" }),
      redirect: "manual"
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${BASE}?notice=mode-change-requires-off`);
  }, {
    getSettings: async () => ({ enabled: true, deliveryMode: "ses", updatedAt: "2030-01-01T00:00:00Z", updatedByEmail: null }),
    saveSettings: async () => {
      saved = true;
    }
  });
  assert.equal(saved, false);
});
