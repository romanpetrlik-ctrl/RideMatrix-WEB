import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, TestDatabaseContext } from "../database/test-helper";
import { createCsrfProtection } from "../middleware/csrf";
import { SessionAccount } from "../services/api";
import { getStaffUser } from "../services/staff";
import { createStaffRouter } from "./staff";

describe("admin-managed staff display names", () => {
  let db: TestDatabaseContext;
  let server: http.Server;
  let baseUrl: string;
  let session: SessionAccount;
  let accountId: string;
  let superuserAccountId: string;
  const invitations: string[] = [];
  const name = '<img src=x onerror="alert(1)">';
  const manager: SessionAccount = {
    authenticated: true,
    user: { id: "manager", email: "manager@example.com", roles: ["superuser"] }
  };

  before(async () => {
    db = await createTestDatabaseContext("test_staff_names");
    await db.createAuthTables();
    await initializeDatabase();
    const app = express();
    app.set("view engine", "ejs");
    app.set("views", `${process.cwd()}/src/views`);
    app.use(express.urlencoded({ extended: true }));
    app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
    app.use(createCsrfProtection({ cookieSecure: false }));
    app.use(createStaffRouter({
      appTitle: "RideMatrix Test",
      loadSession: async () => session,
      requestAccessCode: async (email) => { invitations.push(email); }
    }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    session = manager;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await safeCleanupTestDatabase(db);
  });

  async function postForm(path: string, body: Record<string, string>): Promise<Response> {
    const form = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
    const cookie = form.headers.get("set-cookie")!.split(";")[0];
    const html = await form.text();
    const token = html.match(/name="_csrf" value="([^"]+)"/)![1];
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...body, _csrf: token }),
      redirect: "manual"
    });
  }

  test("invite saves a trimmed name atomically and retains normal email login-code delivery", async () => {
    const response = await postForm("/staff/invite", {
      email: "named@example.com", roles: "driver", displayName: `  ${name}  `
    });
    assert.equal(response.status, 200);
    assert.deepEqual(invitations, ["named@example.com"]);
    const result = await query(`SELECT id FROM users WHERE email = $1`, ["named@example.com"]);
    accountId = result.rows[0].id;
    assert.equal((await getStaffUser(accountId))?.displayName, name);
    const directory = await fetch(`${baseUrl}/staff`);
    assert.match(directory.headers.get("cache-control") || "", /no-store/);
    const html = await directory.text();
    assert.match(html, /&lt;img src=x onerror=&#34;alert\(1\)&#34;&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /named@example.com/);
  });

  test("staff directory shows Edit roles action and role editor preselects current roles", async () => {
    const directory = await fetch(`${baseUrl}/staff`);
    const html = await directory.text();
    assert.match(html, new RegExp(`href="/staff/${accountId}/roles">Edit roles<`));

    const editor = await fetch(`${baseUrl}/staff/${accountId}/roles`);
    const editorHtml = await editor.text();
    assert.equal(editor.status, 200);
    assert.match(editorHtml, /id="role-driver"[^>]*checked/);
    assert.match(editorHtml, /Managed by installation|No superuser role assigned/);
  });

  test("saving roles updates role badges in staff list and logs audit with before/after", async () => {
    const response = await postForm(`/staff/${accountId}/roles`, {
      roles: "staff",
      expectedSuperuserMembership: "absent"
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/staff?rolesUpdated=1");

    const updated = await getStaffUser(accountId);
    assert.deepEqual(updated?.roles, ["staff"]);

    const listHtml = await (await fetch(`${baseUrl}/staff?rolesUpdated=1`)).text();
    assert.match(listHtml, /Roles updated successfully/);
    assert.match(listHtml, /<span class="staff-role-badge">Staff<\/span>/);
    assert.doesNotMatch(listHtml, /<span class="staff-role-badge">Driver<\/span>/);

    const audit = await query<{ before_roles: string[]; after_roles: string[]; success: boolean }>(
      `SELECT before_roles, after_roles, success
         FROM staff_role_change_audit
        WHERE target_account_id = $1
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [accountId]
    );
    assert.equal(audit.rows[0].success, true);
    assert.deepEqual(audit.rows[0].before_roles.sort(), ["driver"]);
    assert.deepEqual(audit.rows[0].after_roles.sort(), ["staff"]);
  });

  test("edit form escapes stored names; saving and clearing preserves the account", async () => {
    const form = await fetch(`${baseUrl}/staff/${accountId}/profile`);
    assert.equal(form.status, 200);
    assert.match(form.headers.get("cache-control") || "", /no-store/);
    assert.match(await form.text(), /value="&lt;img src=x onerror=&#34;alert\(1\)&#34;&gt;"/);
    let response = await postForm(`/staff/${accountId}/profile`, { displayName: "  Known colleague  " });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/staff");
    assert.equal((await getStaffUser(accountId))?.displayName, "Known colleague");
    response = await postForm(`/staff/${accountId}/profile`, { displayName: "   " });
    assert.equal(response.status, 303);
    const member = await getStaffUser(accountId);
    assert.equal(member?.displayName, null);
    assert.equal(member?.email, "named@example.com");
    assert.deepEqual(member?.roles, ["driver"]);
    assert.match(await (await fetch(`${baseUrl}/staff`)).text(), /Name not provided/);
  });

  test("invalid edit and invite names are rejected without writes or invitation delivery", async () => {
    for (const value of ["X".repeat(101), "Name\nOther"]) {
      assert.equal((await postForm(`/staff/${accountId}/profile`, { displayName: value })).status, 400);
      assert.equal((await getStaffUser(accountId))?.displayName, null);
      assert.equal((await postForm("/staff/invite", {
        email: "invalid@example.com", roles: "driver", displayName: value
      })).status, 400);
    }
    assert.equal(invitations.length, 1);
    assert.equal((await query(`SELECT id FROM users WHERE email = 'invalid@example.com'`)).rows.length, 0);
  });

  test("name mutations require CSRF, session authorization and a staff target", async () => {
    await postForm(`/staff/${accountId}/profile`, { displayName: "Keep this name" });
    const multipart = new FormData();
    multipart.set("displayName", "Tampered");
    assert.equal((await fetch(`${baseUrl}/staff/${accountId}/profile`, {
      method: "POST", body: multipart, redirect: "manual"
    })).status, 403);
    assert.equal((await getStaffUser(accountId))?.displayName, "Keep this name");
    await postForm(`/staff/${accountId}/profile`, { displayName: "" });
    assert.equal((await fetch(`${baseUrl}/staff/${accountId}/profile`, {
      method: "POST", body: new URLSearchParams({ displayName: "Tampered" }), redirect: "manual"
    })).status, 403);
    for (const id of ["unknown", "a0000000-0000-0000-0000-000000000001", encodeURIComponent("' OR 1=1")]) {
      assert.equal((await fetch(`${baseUrl}/staff/${id}/profile`)).status, 404);
    }
    const credentialsForm = await fetch(`${baseUrl}/staff/${accountId}/profile`);
    const cookie = credentialsForm.headers.get("set-cookie")!.split(";")[0];
    const token = (await credentialsForm.text()).match(/name="_csrf" value="([^"]+)"/)![1];
    session = { authenticated: true, user: { id: accountId, email: "named@example.com", roles: ["driver"] } };
    assert.equal((await fetch(`${baseUrl}/staff/${accountId}/profile`)).status, 403);
    assert.equal((await fetch(`${baseUrl}/staff/${accountId}/profile`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token, displayName: "Unauthorized" })
    })).status, 403);
    session = { authenticated: false };
    const response = await fetch(`${baseUrl}/staff/${accountId}/profile`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
    assert.equal((await getStaffUser(accountId))?.displayName, null);
    session = manager;
  });

  test("role editor blocks unauthorized users and immutable superuser changes", async () => {
    await postForm("/staff/invite", {
      email: "super.user@example.com",
      roles: "superuser",
      confirmSuperuser: "yes"
    });
    const superuserIdResult = await query<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE email = $1`,
      ["super.user@example.com"]
    );
    superuserAccountId = superuserIdResult.rows[0].id;

    const csrfForm = await fetch(`${baseUrl}/staff/${accountId}/profile`, { redirect: "manual" });
    const cookie = csrfForm.headers.get("set-cookie")!.split(";")[0];
    const token = (await csrfForm.text()).match(/name="_csrf" value="([^"]+)"/)![1];
    session = { authenticated: true, user: { id: accountId, email: "named@example.com", roles: ["driver"] } };
    assert.equal((await fetch(`${baseUrl}/staff/${accountId}/roles`)).status, 403);
    const unauthorizedPost = await fetch(`${baseUrl}/staff/${accountId}/roles`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token, roles: "driver", expectedSuperuserMembership: "absent" })
    });
    assert.equal(unauthorizedPost.status, 403);
    const unauthorizedAudit = await query<{ success: boolean; reason: string }>(
      `SELECT success, reason
         FROM staff_role_change_audit
        WHERE target_account_id = $1
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [accountId]
    );
    assert.equal(unauthorizedAudit.rows[0].success, false);
    assert.equal(unauthorizedAudit.rows[0].reason, "unauthorized_actor");

    session = manager;
    const blocked = await postForm(`/staff/${superuserAccountId}/roles`, {
      roles: "staff",
      expectedSuperuserMembership: "absent"
    });
    assert.equal(blocked.status, 403);
    const blockedHtml = await blocked.text();
    assert.match(blockedHtml, /managed by installation/i);
    const blockedAudit = await query<{ success: boolean; reason: string }>(
      `SELECT success, reason
         FROM staff_role_change_audit
        WHERE target_account_id = $1
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [superuserAccountId]
    );
    assert.equal(blockedAudit.rows[0].success, false);
    assert.equal(blockedAudit.rows[0].reason, "immutable_superuser");
  });
});
