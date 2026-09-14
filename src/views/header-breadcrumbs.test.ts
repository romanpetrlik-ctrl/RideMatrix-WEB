import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { renderFile } from "ejs";

const headerPath = path.join(process.cwd(), "src/views/partials/header.ejs");

test("header renders one canonical breadcrumb trail when duplicate breadcrumbs are provided", async () => {
  const html = await renderFile(headerPath, {
    appTitle: "RideMatrix",
    pageTitle: "Customers",
    pageMeta: "Manage customers",
    activeRoleLabel: "Administration",
    breadcrumbs: [
      { label: "Administration", href: "/dashboard" },
      { label: "Administration", href: "/dashboard" },
      { label: " Administration ", href: " /dashboard " },
      { label: "Customers" },
      { label: " Customers " }
    ],
    contextBarActions: []
  });

  assert.equal((html.match(/aria-label="Breadcrumbs"/g) || []).length, 1);
  assert.equal((html.match(/site-header__breadcrumb-item/g) || []).length, 2);
  assert.equal((html.match(/site-header__breadcrumb-link" href="\/dashboard">Administration</g) || []).length, 1);
  assert.equal((html.match(/site-header__breadcrumb-current" aria-current="page">Customers</g) || []).length, 1);
});
