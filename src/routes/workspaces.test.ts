import assert from "node:assert/strict";
import test from "node:test";
import { getLandingRoute } from "./auth-callback";
import { dashboardSections } from "./dashboard";
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

test("Administration customer management tile opens the customer list", () => {
  const customerTile = dashboardSections.flatMap((section) => section.tiles)
    .find((tile) => tile.key === "customers");
  assert.equal(customerTile?.href, "/customers");
});
