import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import express from "express";
import { createRoleSectionsRouter, grantingRoles, workspaceModules } from "./role-sections";

// Role keys the Staff directory shows for bookings@romanairporttransfers.co.uk
// (admin, customer, driver, partner, staff, superuser, tech_support).
const BOOKINGS_ROLES = ["admin", "customer", "driver", "partner", "staff", "superuser", "tech_support"];

describe("role workspaces authorize against the /auth/session role contract", () => {
  let authServer: http.Server;
  let appServer: http.Server;
  let baseUrl: string;
  const sessionsByCookie = new Map<string, unknown>();
  const seenCookies: Array<string | undefined> = [];

  before(async () => {
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
    app.use(createRoleSectionsRouter({ appTitle: "RideMatrix Test" }));
    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
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
    assert.match(body, /no system settings are configurable here yet/);
    assert.doesNotMatch(body, /Unable to continue/);
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
    assert.match(body, /does not include the System Control \(superuser\) role required for System settings/);
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
