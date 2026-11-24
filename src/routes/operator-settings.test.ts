import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import { SessionAccount } from "../services/api";
import { createOperatorSettingsRouter } from "./operator-settings";

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
  app.use(createCsrfProtection({ appTitle: "Operator Settings Test", cookieSecure: false }));
  app.use(createOperatorSettingsRouter({
    appTitle: "Operator Settings Test",
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

test("operator settings are forbidden to roles without System settings access", async () => {
  await withServer(sessionFor(["driver"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/settings/operator`, { redirect: "manual" });
    assert.equal(response.status, 403);
  });
});

test("operator settings redirect unauthenticated visitors to access", async () => {
  await withServer({ authenticated: false }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/settings/operator`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
  });
});

test("operator settings POST without a CSRF token is rejected before any save", async () => {
  await withServer(sessionFor(["admin"]), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/settings/operator`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ section: "profile", legalName: "Hijacked Ltd", licenceHolderName: "Hijacked" }),
      redirect: "manual"
    });
    assert.notEqual(response.status, 303, "a POST without a CSRF token must not save");
    assert.ok(response.status >= 400, `expected rejection, got ${response.status}`);
  });
});
