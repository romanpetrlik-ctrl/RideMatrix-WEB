import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import express from "express";
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
        assert.match(destinationBody, /Not configured yet/);
        const selectedSubnav = destinationBody.match(/<a class="toll-fees-subnav__item"[^>]*aria-current="page"[^>]*>/g) ?? [];
        assert.equal(selectedSubnav.length, 1, "exactly one subpage should be marked as selected");
        assert.ok(selectedSubnav[0].includes(`${scheme.path}/${destination.path}`), "the selected subpage should match the current destination");
        assert.match(destinationBody, /does not (display maps, )?calculate fees, or charge customers|does not calculate fees or charge customers/);
      }
    }
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
