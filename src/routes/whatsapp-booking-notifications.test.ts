import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import { SessionAccount } from "../services/api";
import { createWhatsAppBookingNotificationsRouter } from "./whatsapp-booking-notifications";

const BASE = "/settings/messaging/whatsapp/booking-notifications";

function sessionFor(roles: string[]): SessionAccount {
  return {
    authenticated: true,
    user: { id: "settings-user", email: "settings@example.com", roles, active_role: roles[0] }
  };
}

function createServer(session: SessionAccount) {
  const app = express();
  app.set("views", path.join(process.cwd(), "src/views"));
  app.set("view engine", "ejs");
  app.use(express.urlencoded({ extended: false }));
  app.use(createCsrfProtection({ appTitle: "WhatsApp Settings Test", cookieSecure: false }));
  app.use(createWhatsAppBookingNotificationsRouter({
    appTitle: "WhatsApp Settings Test",
    loadSession: async () => session
  }));
  return app.listen(0);
}

async function withServer<T>(session: SessionAccount, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(session);
  const port = (server.address() as { port: number }).port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("WhatsApp booking notification settings are forbidden to non-superusers", async () => {
  await withServer(sessionFor(["admin"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}`, { redirect: "manual" });
    assert.equal(response.status, 403);
  });
});

test("WhatsApp booking notification settings redirect unauthenticated visitors to access", async () => {
  await withServer({ authenticated: false }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}/booking_accepted`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
  });
});

test("WhatsApp booking notification POST without a CSRF token is rejected before any save", async () => {
  await withServer(sessionFor(["superuser"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}${BASE}/booking_accepted`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ enabled: "on", templateName: "booking_accepted", templateLanguage: "en_GB" }),
      redirect: "manual"
    });
    assert.notEqual(response.status, 303, "a POST without a CSRF token must not save");
    assert.ok(response.status >= 400, `expected rejection, got ${response.status}`);
  });
});
