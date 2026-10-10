import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, TestDatabaseContext } from "../database/test-helper";
import { createCsrfProtection } from "../middleware/csrf";
import { SessionAccount } from "../services/api";
import { getStaffUser } from "../services/staff";
import { bootstrapRealInstallerSuperuser } from "../services/system-setup";
import { createSetupRouter } from "./setup";
import { createStaffRouter } from "./staff";

let db: TestDatabaseContext;
let server: http.Server;
let baseUrl: string;
let session: SessionAccount;
let previousAllowlist: string | undefined;
const actor = {
  userId: "11111111-1111-1111-1111-111111111111",
  email: "installer@example.com",
  roles: ["admin"]
};
const path = "/setup/bootstrap-superuser";

before(async () => {
  previousAllowlist = process.env.INITIAL_SETUP_ALLOWED_EMAILS;
  process.env.INITIAL_SETUP_ALLOWED_EMAILS = actor.email;
  db = await createTestDatabaseContext("test_setup_names");
  await db.createAuthTables();
  await initializeDatabase();
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", `${process.cwd()}/src/views`);
  app.use(express.urlencoded({ extended: true }));
  app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
  app.use(createCsrfProtection({ cookieSecure: false }));
  app.use(createSetupRouter({ appTitle: "RideMatrix Test", loadSession: async () => session }));
  app.use(createStaffRouter({ appTitle: "RideMatrix Test", loadSession: async () => session }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await query(`TRUNCATE staff_profiles, system_setup_bootstrap, system_setup_state,
    system_setup_audit_events, user_roles, roles, users CASCADE`);
  await query(`INSERT INTO roles (id, key) VALUES (1, 'admin'), (2, 'superuser')`);
  await query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'Active')`, [actor.userId, actor.email]);
  session = { authenticated: true, user: { id: actor.userId, email: actor.email, roles: actor.roles } };
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await safeCleanupTestDatabase(db);
  if (previousAllowlist === undefined) delete process.env.INITIAL_SETUP_ALLOWED_EMAILS;
  else process.env.INITIAL_SETUP_ALLOWED_EMAILS = previousAllowlist;
});

async function postForm(body: Record<string, string>): Promise<Response> {
  const form = await fetch(`${baseUrl}${path}`);
  const cookie = form.headers.get("set-cookie")!.split(";")[0];
  const token = (await form.text()).match(/name="_csrf" value="([^"]+)"/)![1];
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ installerEmail: actor.email, ...body, _csrf: token }),
    redirect: "manual"
  });
}

async function assertNoBootstrapWrites(): Promise<void> {
  for (const table of ["staff_profiles", "system_setup_bootstrap", "system_setup_state", "system_setup_audit_events", "user_roles"]) {
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count, 0, table);
  }
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM users`)).rows[0].count, 1);
}

test("wizard renders explicit required personal-name fields and CSRF without inferred names", async () => {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  const html = await response.text();
  assert.match(html, /<label for="name">Name \*<\/label>/);
  assert.match(html, /name="name"[^>]*autocomplete="given-name"[^>]*required[^>]*maxlength="100"[^>]*value=""/);
  assert.match(html, /<label for="surname">Surname \*<\/label>/);
  assert.match(html, /name="surname"[^>]*autocomplete="family-name"[^>]*required[^>]*maxlength="100"[^>]*value=""/);
  assert.match(html, /name="_csrf"/);
});

test("missing, control-character, overlength and invalid-type names preserve safe values without writes", async () => {
  const invalidBodies: Record<string, string>[] = [
    {},
    { name: " ", surname: "Person" },
    { name: "Person", surname: "" },
    { name: "A".repeat(101), surname: "Person" },
    { name: "A".repeat(50), surname: "B".repeat(50) },
    { name: "Bad\nName", surname: "Person" },
    { name: "Person", surname: "Bad\u0085Name" },
    { "name[]": "Person", surname: "Surname" },
    { name: "Person", "surname[x]": "Surname" }
  ];
  for (const body of invalidBodies) {
    const response = await postForm(body);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Please correct the following issues/);
    await assertNoBootstrapWrites();
  }
  const name = '<img src=x onerror="alert(1)">';
  const response = await postForm({ name, surname: "", installerEmail: actor.email });
  const html = await response.text();
  assert.match(html, /value="&lt;img src=x onerror=&#34;alert\(1\)&#34;&gt;"/);
  assert.match(html, /value="installer@example.com"/);
  assert.doesNotMatch(html, /<img src=x/);
  await assertNoBootstrapWrites();
});

test("ownership and missing-role errors preserve both names and roll back", async () => {
  let response = await postForm({ name: "Given", surname: "Family", installerEmail: "other@example.com" });
  assert.match(await response.text(), /must match the currently authenticated account/);
  await assertNoBootstrapWrites();
  await query(`DELETE FROM roles WHERE key = 'superuser'`);
  response = await postForm({ name: "Given", surname: "Family" });
  const html = await response.text();
  assert.match(html, /Required role/);
  assert.match(html, /value="Given"/);
  assert.match(html, /value="Family"/);
  await assertNoBootstrapWrites();
});

test("CSRF and unauthorized requests cannot persist names or bootstrap", async () => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ installerEmail: actor.email, name: "Given", surname: "Family" }),
    redirect: "manual"
  });
  assert.equal(response.status, 403);
  await assertNoBootstrapWrites();
  session = { authenticated: true, user: { id: "outsider", email: "outsider@example.com", roles: ["customer"] } };
  assert.equal((await fetch(`${baseUrl}${path}`, { redirect: "manual" })).status, 403);
  session = { authenticated: false };
  assert.equal((await fetch(`${baseUrl}${path}`, { redirect: "manual" })).headers.get("location"), "/access");
  await assertNoBootstrapWrites();
});

test("bootstrap persists trimmed names against the verified account and repeated submissions do not overwrite", async () => {
  const response = await postForm({ name: "  Éva  ", surname: " O'Neil  " });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/operator-profile");
  assert.equal((await getStaffUser(actor.userId))?.displayName, "Éva O'Neil");
  await bootstrapRealInstallerSuperuser({ actor, installerEmail: actor.email });
  await bootstrapRealInstallerSuperuser({ actor, installerEmail: actor.email, name: "Changed", surname: "Name" });
  assert.equal((await getStaffUser(actor.userId))?.displayName, "Éva O'Neil");
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM staff_profiles`)).rows[0].count, 1);
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM user_roles`)).rows[0].count, 1);
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM system_setup_audit_events`)).rows[0].count, 1);
  await query(`DELETE FROM staff_profiles`);
  await bootstrapRealInstallerSuperuser({ actor, installerEmail: actor.email });
  assert.equal((await getStaffUser(actor.userId))?.displayName, null);
});

test("concurrent bootstrap submissions create one profile, role assignment and audit event", async () => {
  await Promise.all([
    bootstrapRealInstallerSuperuser({ actor, installerEmail: actor.email, name: "First", surname: "Person" }),
    bootstrapRealInstallerSuperuser({ actor, installerEmail: actor.email, name: "Second", surname: "Person" })
  ]);
  assert.ok(["First Person", "Second Person"].includes((await getStaffUser(actor.userId))!.displayName!));
  for (const table of ["staff_profiles", "system_setup_bootstrap", "user_roles", "system_setup_audit_events"]) {
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count, 1);
  }
});

test("different or unstable auth account IDs cannot acquire a profile or leave partial users", async () => {
  const mismatched = { ...actor, userId: "22222222-2222-2222-2222-222222222222" };
  await assert.rejects(() => bootstrapRealInstallerSuperuser({
    actor: mismatched, installerEmail: actor.email, name: "Given", surname: "Family"
  }), /authenticated account ID and email/);
  await assertNoBootstrapWrites();
  const missing = { ...mismatched, email: "missing@example.com", roles: ["superuser"] };
  await assert.rejects(() => bootstrapRealInstallerSuperuser({
    actor: missing, installerEmail: missing.email, name: "Given", surname: "Family"
  }), /authenticated account ID and email/);
  await assertNoBootstrapWrites();
});

test("profile-write failure rolls back the new role assignment and bootstrap state", async () => {
  await query(`ALTER TABLE staff_profiles ADD CONSTRAINT reject_setup_name CHECK (display_name <> 'Reject Person')`);
  try {
    await assert.rejects(() => bootstrapRealInstallerSuperuser({
      actor, installerEmail: actor.email, name: "Reject", surname: "Person"
    }), /reject_setup_name/);
    await assertNoBootstrapWrites();
  } finally {
    await query(`ALTER TABLE staff_profiles DROP CONSTRAINT reject_setup_name`);
  }
});

test("names remain escaped in Staff and a different installer cannot repeat bootstrap", async () => {
  const name = '<img src=x onerror="alert(1)">';
  await bootstrapRealInstallerSuperuser({ actor, installerEmail: actor.email, name, surname: "Person" });
  assert.equal((await getStaffUser(actor.userId))?.displayName, `${name} Person`);
  const html = await (await fetch(`${baseUrl}/staff`)).text();
  assert.match(html, /&lt;img src=x onerror=&#34;alert\(1\)&#34;&gt; Person/);
  assert.doesNotMatch(html, /<img src=x/);
  await assert.rejects(() => bootstrapRealInstallerSuperuser({
    actor: { ...actor, userId: "22222222-2222-2222-2222-222222222222" },
    installerEmail: actor.email, name: "Other", surname: "Person"
  }), /already been completed/);
});
