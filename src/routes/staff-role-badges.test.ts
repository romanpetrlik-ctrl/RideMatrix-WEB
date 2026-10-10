import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ejs from "ejs";
import { buildStaffRoleBadges } from "./staff";

const STAFF_INDEX_VIEW = path.join(process.cwd(), "src/views/pages/staff/index.ejs");

function renderStaffDirectory(members: Array<{ email: string; roles: string[] }>): Promise<string> {
  return ejs.renderFile(STAFF_INDEX_VIEW, {
    title: "Staff",
    appTitle: "RideMatrix Test",
    email: "admin@ridematrix.com",
    staffCount: members.length,
    staff: members.map((member, index) => ({
      id: String(index + 1),
      email: member.email,
      status: "Active",
      roles: member.roles,
      roleBadges: buildStaffRoleBadges(member.roles),
      formattedCreatedAt: "—",
      formattedLastLoginAt: "Never",
      auditHref: `/staff/${index + 1}/audit`
    }))
  });
}

test("superuser is listed first and flagged; other roles keep their labels", () => {
  assert.deepEqual(buildStaffRoleBadges(["admin", "customer", "superuser", "tech_support"]), [
    { label: "System Control", isSuperuser: true },
    { label: "Administration", isSuperuser: false },
    { label: "Customer", isSuperuser: false },
    { label: "Technical Support", isSuperuser: false }
  ]);
  assert.deepEqual(buildStaffRoleBadges(["admin", "staff"]).filter((badge) => badge.isSuperuser), []);
});

test("staff directory marks superuser roles with a visible SU · System Control badge", async () => {
  const html = await renderStaffDirectory([
    { email: "bookings@romanairporttransfers.co.uk", roles: ["admin", "staff", "superuser"] },
    { email: "dispatcher@ridematrix.com", roles: ["admin", "staff"] }
  ]);

  const superuserBadges = html.match(/<span class="staff-role-badge staff-role-badge--superuser"[^>]*>[\s\S]*?<\/span>/g) ?? [];
  assert.equal(superuserBadges.length, 1);
  assert.match(superuserBadges[0], /<abbr title="Superuser">SU<\/abbr> · System Control/);

  const [bookingsRow, dispatcherRow] = html.split("<tr data-staff-row>").slice(1);
  assert.match(bookingsRow, /staff-role-badge--superuser/);
  assert.doesNotMatch(dispatcherRow, /staff-role-badge--superuser|>SU</);
  assert.match(dispatcherRow, /<span class="staff-role-badge">Administration<\/span>/);
  assert.match(dispatcherRow, /<span class="staff-role-badge">Staff<\/span>/);
});
