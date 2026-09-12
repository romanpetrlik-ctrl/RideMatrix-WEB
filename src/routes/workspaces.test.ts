import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { getLandingRoute } from "./auth-callback";
import { findSelectedOperationalAction, operationalMenuRows } from "./dashboard";
import { availableWorkspaceModules, canAccessWorkspace, workspaceModules } from "./role-sections";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Missing block marker: ${marker}`);
  const openBraceIndex = source.indexOf("{", markerIndex);
  assert.notEqual(openBraceIndex, -1, `Missing opening brace for: ${marker}`);

  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, index);
      }
    }
  }

  assert.fail(`Unterminated block for: ${marker}`);
}

function extractRuleBody(source: string, selector: string): string {
  const expression = new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`);
  const match = source.match(expression);
  assert.ok(match, `Missing rule for selector: ${selector}`);
  return match[1];
}

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
    assert.match(template, new RegExp(`class="[^"]*\\b${escapeRegExp(className)}\\b`));
  }
});

test("workspace and customer-detail CSS rules stay intact", () => {
  const css = readFileSync(path.join(process.cwd(), "public/css/app.css"), "utf8");
  const workspaceGrid = extractRuleBody(css, ".workspace-tile-grid");
  const workspaceTileForm = extractRuleBody(css, ".workspace-tile-form");
  const workspaceTile = extractRuleBody(css, ".workspace-tile");
  const workspaceTileTitle = extractRuleBody(css, ".workspace-tile__title");
  const workspaceTileDescription = extractRuleBody(css, ".workspace-tile__description");
  const workspaceTileAction = extractRuleBody(css, ".workspace-tile__action");
  const mobile820 = extractBlock(css, "@media (max-width: 820px)");
  const customerDetailLayout = extractRuleBody(css, ".customer-detail-layout");
  const customerDetailLayoutChildren = extractRuleBody(css, ".customer-detail-layout > *");
  const customerDetailMap = extractRuleBody(css, ".customer-detail-layout__map");
  const customerToolbarButtons = extractRuleBody(css, ".site-header .context-toolbar .button:focus");

  assert.match(workspaceGrid, /grid-template-columns: repeat\(auto-fit, minmax\(220px, 1fr\)\);/);
  assert.match(workspaceGrid, /gap: 0\.85rem;/);
  assert.match(workspaceTileForm, /height: 100%;/);
  assert.match(workspaceTile, /width: 100%;/);
  assert.match(workspaceTile, /height: 100%;/);
  assert.match(workspaceTile, /min-height: 118px;/);
  assert.match(workspaceTileTitle, /font-weight: 700;/);
  assert.match(workspaceTileDescription, /line-height: 1\.4;/);
  assert.match(workspaceTileAction, /opacity: 0\.75;/);
  assert.match(mobile820, /\.dashboard-tile-grid,\s*\.workspace-tile-grid\s*\{[^}]*grid-template-columns: 1fr;/);

  assert.match(customerDetailLayout, /grid-template-columns: minmax\(0, 3fr\) minmax\(16rem, 1fr\);/);
  assert.match(customerDetailLayout, /align-items: stretch;/);
  assert.match(customerDetailLayoutChildren, /height: 100%;/);
  assert.match(customerDetailMap, /display: flex;/);
  assert.match(customerDetailMap, /flex-direction: column;/);
  assert.match(css, /@media \(max-width: 900px\)\s*\{[\s\S]*?\.customer-detail-layout\s*\{[^}]*grid-template-columns: 1fr;/);
  assert.match(customerToolbarButtons, /color: var\(--rm-antique-white\);/);
});
