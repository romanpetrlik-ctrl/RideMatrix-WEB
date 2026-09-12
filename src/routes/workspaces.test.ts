import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { getLandingRoute } from "./auth-callback";
import { findSelectedOperationalAction, operationalMenuRows } from "./dashboard";
import { availableWorkspaceModules, canAccessWorkspace, workspaceModules } from "./role-sections";

test("workspace selector exposes only the five internal modules", () => {
  assert.deepEqual(workspaceModules.map((module) => module.title), [
    "Administration",
    "System settings",
    "Staff",
    "Technical Support",
    "Manage VPS"
  ]);
  assert.deepEqual(workspaceModules.map((module) => module.href), [
    "/dashboard", "/settings", "/staff", "/tech-support", "/vps"
  ]);
});

test("workspace authorization is explicit and never treats customer or staff as VPS access", () => {
  assert.deepEqual(availableWorkspaceModules(["customer", "partner", "driver"]), []);
  assert.equal(canAccessWorkspace(["admin"], "administration"), true);
  assert.equal(canAccessWorkspace(["admin"], "staff"), true);
  assert.equal(canAccessWorkspace(["tech_support"], "technical-support"), true);
  assert.equal(canAccessWorkspace(["staff"], "manage-vps"), false);
  assert.equal(canAccessWorkspace(["superuser"], "manage-vps"), true);
});

test("only a single authorized module receives a direct landing route", () => {
  assert.equal(getLandingRoute(["tech_support"]), "/tech-support");
  assert.equal(getLandingRoute(["admin", "superuser"]), "/choose-role");
  assert.equal(getLandingRoute(["customer"]), "/account");
});

test("dashboard operational menu is the canonical navigation", () => {
  assert.deepEqual(operationalMenuRows.map((row) => row.category), [
    "Bookings",
    "Dispatch",
    "Customers",
    "Staff",
    "Pricing",
    "Settings"
  ]);
  assert.equal(operationalMenuRows.flatMap((row) => row.actions).find((action) => action.label === "All customers")?.href, "/customers");
  assert.equal(operationalMenuRows.flatMap((row) => row.actions).find((action) => action.label === "New customer")?.href, "/customers/register");
  assert.equal(operationalMenuRows.flatMap((row) => row.actions).find((action) => action.label === "All staff")?.href, "/staff");
  assert.equal(operationalMenuRows.flatMap((row) => row.actions).find((action) => action.label === "Live board")?.href, "/dashboard?tile=dispatch-live-board");
  assert.equal(operationalMenuRows.flatMap((row) => row.actions).find((action) => action.label === "Live Map")?.href, "/dashboard?tile=dispatch-live-map");
});

test("operational dashboard links resolve to their selected-action notices", () => {
  assert.deepEqual(findSelectedOperationalAction("bookings-upcoming"), {
    category: "Bookings",
    label: "Upcoming",
    externalMode: undefined,
    href: "/dashboard?tile=bookings-upcoming"
  });
  assert.equal(findSelectedOperationalAction("customers"), undefined);
});

test("dashboard template renders only the canonical operational menu", () => {
  const template = readFileSync(path.join(process.cwd(), "src/views/pages/dashboard.ejs"), "utf8");
  assert.match(template, /Operational shortcuts/);
  assert.doesNotMatch(template, /dashboard-layout|Management|Platform/);
});

test("dashboard keeps the admin redirect and authorization guard", () => {
  const route = readFileSync(path.join(process.cwd(), "src/routes/dashboard.ts"), "utf8");
  assert.match(route, /router\.get\("\/admin"/);
  assert.match(route, /return res\.redirect\("\/dashboard"\)/);
  assert.match(route, /if \(!roles\.includes\("admin"\)\)/);
});

test("choose-role keeps workspace selector structure", () => {
  const template = readFileSync(path.join(process.cwd(), "src/views/pages/choose-role.ejs"), "utf8");

  for (const className of [
    "dashboard-layout",
    "workspace-tile-grid",
    "workspace-tile-form",
    "workspace-tile",
    "workspace-tile__title",
    "workspace-tile__description",
    "workspace-tile__action"
  ]) {
    assert.match(template, new RegExp(className));
  }
});

test("workspace and customer-detail CSS rules stay intact", () => {
  const css = readFileSync(path.join(process.cwd(), "public/css/app.css"), "utf8");

  assert.match(css, /\.workspace-tile-grid \{[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(220px, 1fr\)\);[\s\S]*gap: 0\.85rem;/);
  assert.match(css, /\.workspace-tile-form \{[\s\S]*height: 100%;/);
  assert.match(css, /\.workspace-tile \{[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*min-height: 118px;/);
  assert.match(css, /\.workspace-tile__title \{[\s\S]*font-weight: 700;/);
  assert.match(css, /\.workspace-tile__description \{[\s\S]*line-height: 1\.4;/);
  assert.match(css, /\.workspace-tile__action \{[\s\S]*opacity: 0\.75;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.dashboard-tile-grid,[\s\S]*\.workspace-tile-grid \{[\s\S]*grid-template-columns: 1fr;/);

  assert.match(css, /\.customer-detail-layout \{[\s\S]*grid-template-columns: minmax\(0, 3fr\) minmax\(16rem, 1fr\);[\s\S]*align-items: stretch;/);
  assert.match(css, /\.customer-detail-layout > \* \{[\s\S]*height: 100%;/);
  assert.match(css, /\.customer-detail-layout__map \{[\s\S]*display: flex;[\s\S]*flex-direction: column;/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.customer-detail-layout \{[\s\S]*grid-template-columns: 1fr;/);
  assert.match(css, /\.site-header \.context-toolbar \.button,[\s\S]*\.site-header \.context-toolbar \.button:visited,[\s\S]*\.site-header \.context-toolbar \.button:hover,[\s\S]*\.site-header \.context-toolbar \.button:focus \{[\s\S]*color: var\(--rm-antique-white\);/);
});
