import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ejs from "ejs";
import { normalizeStaffDisplayName } from "../services/staff";

test("display names are optional, trimmed, bounded and never derived from email", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.equal(normalizeStaffDisplayName(value), null);
  }
  assert.equal(normalizeStaffDisplayName("  Žaneta O’Neill  "), "Žaneta O’Neill");
  assert.equal(normalizeStaffDisplayName("A".repeat(100)), "A".repeat(100));
  for (const value of ["A".repeat(101), "Name\nOther", "Name\u0000", [], {}, 123]) {
    assert.throws(() => normalizeStaffDisplayName(value));
  }
});

test("directory renders escaped name above email and neutral fallback for absent or blank names", async () => {
  const html = await ejs.renderFile(path.join(process.cwd(), "src/views/pages/staff/index.ejs"), {
    title: "Staff",
    appTitle: "RideMatrix Test",
    email: "admin@example.com",
    staffCount: 3,
    staff: ['<script>alert("name")</script>', null, "   "].map((displayName, i) => ({
      id: `staff-${i}`,
      email: `colleague${i}@example.com`,
      displayName,
      status: "Active",
      roleLabels: ["Staff"],
      auditHref: `/staff/staff-${i}/audit`,
      formattedCreatedAt: "—",
      formattedLastLoginAt: "Never"
    }))
  });
  assert.match(html, /&lt;script&gt;alert\(&#34;name&#34;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.equal((html.match(/Name not provided/g) || []).length, 2);
  assert.match(html, /staff-table__name">[^]*?<\/strong>\s*<a class="staff-table__email/);
  assert.match(html, /colleague0@example.com/);
  assert.match(html, /Sorted alphabetically by email address/);
  assert.match(html, /data-staff-details/);
  assert.match(html, /href="\/staff\/staff-0\/profile">Edit name/);
});
