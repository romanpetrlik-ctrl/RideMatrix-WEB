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
