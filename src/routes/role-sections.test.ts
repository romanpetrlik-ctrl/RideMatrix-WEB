import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import express from "express";
import { createRoleSectionsRouter, grantingRoles, tollFeeCategories, workspaceModules } from "./role-sections";

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
    assert.match(categoryBody, /Not configured yet/);
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
      const categoryUrl = `${baseUrl}/settings/toll-fees/${category.slug}`;
      const response = await fetch(categoryUrl, { headers });
      assert.equal(response.status, 200, `${category.title} category should be reachable`);
      const body = await response.text();
      assert.ok(body.includes(category.title), `${category.title} should be visible`);
      const categoryPath = `/settings/toll-fees/${category.slug}`;
      assert.ok(body.includes(`${categoryPath}/reference-data`), "reference data destination should be linked");
      assert.ok(body.includes(`${categoryPath}/fee-settings`), "fee settings destination should be linked");
      assert.equal((body.match(/class="toll-fees-subnav__item"/g) ?? []).length, 2);
      assert.match(body, /aria-label="Breadcrumb"/);
      assert.match(body, /href="\/settings\/toll-fees">Toll &amp; Fees<\/a>/);

      for (const destination of [
        { path: "reference-data", title: "Reference data (managed)", explanation: /versioned geographic boundaries/ },
        { path: "fee-settings", title: "Fee settings", explanation: /configurable fee schedules/ }
      ]) {
        const destinationResponse = await fetch(`${categoryUrl}/${destination.path}`, { headers });
        assert.equal(destinationResponse.status, 200, `${category.title} ${destination.title} should be reachable`);
        const destinationBody = await destinationResponse.text();
        assert.ok(destinationBody.includes(destination.title), `${destination.title} should be visible`);
        assert.match(destinationBody, destination.explanation);
        assert.match(destinationBody, /Not configured yet/);
        const selectedSubnav = destinationBody.match(/<a class="toll-fees-subnav__item"[^>]*aria-current="page"[^>]*>/g) ?? [];
        assert.equal(selectedSubnav.length, 1, "exactly one subpage should be marked as selected");
        assert.ok(selectedSubnav[0].includes(`${categoryPath}/${destination.path}`), "the selected subpage should match the current destination");
        assert.match(destinationBody, /does not (display maps, )?calculate fees, or charge customers|does not calculate fees or charge customers/);
      }
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
