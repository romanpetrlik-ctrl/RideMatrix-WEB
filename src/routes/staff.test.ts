import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import express from "express";
import { initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import { getCustomerCount } from "../services/customers";
import { SessionAccount } from "../services/api";
import { createStaffRouter } from "./staff";

describe("GET /staff (staff directory)", () => {
  type MockSession = {
    authenticated: boolean;
    user?: {
      id: string;
      email: string;
      roles: string[];
      active_role?: string;
    };
  };

  let dbContext: TestDatabaseContext;
  let authServer: http.Server;
  let appServer: http.Server;
  let baseUrl: string;
  let mockSession: MockSession = { authenticated: false };

  const ROLE_IDS = {
    admin: 1,
    driver: 2,
    dispatcher: 3,
    customer: 4
  };

  before(async () => {
    dbContext = await createTestDatabaseContext("test_staff_routes");
    await dbContext.createAuthTables();
    await initializeDatabase();

    await query(
      `INSERT INTO roles (id, name, description) VALUES
        ($1, 'dispatcher', 'Dispatcher'),
        ($2, 'customer', 'Customer')
       ON CONFLICT (id) DO NOTHING`,
      [ROLE_IDS.dispatcher, ROLE_IDS.customer]
    );

    // The auth service that owns the auth tables lives outside this repository;
    // stand up a minimal stand-in for its /auth/session endpoint so the route
    // can be exercised end-to-end without a real network dependency.
    authServer = http.createServer((req, res) => {
      if (req.url === "/auth/session") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(mockSession));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => authServer.listen(4000, "127.0.0.1", resolve));

    const app = express();
    app.set("view engine", "ejs");
    app.set("views", `${process.cwd()}/src/views`);
    app.use(createStaffRouter({ appTitle: "RideMatrix Test" }));

    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    const port = (appServer.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
    await dbContext.cleanup();
  });

  test("unauthenticated requests are redirected to /access", async () => {
    mockSession = { authenticated: false };

    const response = await fetch(`${baseUrl}/staff`, { redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
  });

  test("authenticated users without staff-management authorization receive the existing 403 response", async () => {
    mockSession = {
      authenticated: true,
      user: { id: "u-1", email: "dispatcher@ridematrix.com", roles: ["dispatcher"] }
    };

    const response = await fetch(`${baseUrl}/staff`, { redirect: "manual" });

    assert.equal(response.status, 403);
    const body = await response.text();
    assert.match(body, /Unable to continue/);
  });

  test("renders an empty state before any staff users exist", async () => {
    mockSession = {
      authenticated: true,
      user: { id: "u-2", email: "admin@ridematrix.com", roles: ["admin"], active_role: "admin" }
    };

    const response = await fetch(`${baseUrl}/staff`);

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /0 staff records/);
    assert.match(body, /No internal staff accounts are available\./);
  });

  test("authorized admin sees internal users, excludes customer-only users, and lists each user once with all roles", async () => {
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES
        ('a0000000-0000-0000-0000-000000000002', $1),
        ('a0000000-0000-0000-0000-000000000002', $2)
       ON CONFLICT DO NOTHING`,
      [ROLE_IDS.driver, ROLE_IDS.dispatcher]
    );

    await query(
      `INSERT INTO users (id, email, status) VALUES
        ('c0000000-0000-0000-0000-000000000001', 'customer.route.test@ridematrix.com', 'Active')
       ON CONFLICT (id) DO NOTHING`
    );
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES
        ('c0000000-0000-0000-0000-000000000001', $1)
       ON CONFLICT DO NOTHING`,
      [ROLE_IDS.customer]
    );

    mockSession = {
      authenticated: true,
      user: { id: "u-3", email: "admin@ridematrix.com", roles: ["admin"], active_role: "admin" }
    };

    const response = await fetch(`${baseUrl}/staff`);
    assert.equal(response.status, 200);

    const body = await response.text();
    const driverOccurrences = body.match(/driver@ridematrix\.com/g) || [];

    assert.equal(driverOccurrences.length, 1, "driver@ridematrix.com must appear exactly once");
    assert.match(body, /Driver/);
    assert.match(body, /Dispatch/);
    assert.doesNotMatch(body, /customer\.route\.test@ridematrix\.com/);
  });

  test("the create/invite action is available directly from the staff list", async () => {
    mockSession = {
      authenticated: true,
      user: { id: "u-3", email: "admin@ridematrix.com", roles: ["admin"], active_role: "admin" }
    };

    const response = await fetch(`${baseUrl}/staff`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /href="\/staff\/invite"/);
  });

  test("bookings@romanairporttransfers.co.uk is listed only while it holds an internal role", async () => {
    await query(
      `INSERT INTO users (id, email, status) VALUES
        ('b0000000-0000-0000-0000-000000000001', 'bookings@romanairporttransfers.co.uk', 'Active')
       ON CONFLICT (id) DO NOTHING`
    );
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES
        ('b0000000-0000-0000-0000-000000000001', $1)
       ON CONFLICT DO NOTHING`,
      [ROLE_IDS.customer]
    );

    mockSession = {
      authenticated: true,
      user: { id: "u-3", email: "admin@ridematrix.com", roles: ["admin"], active_role: "admin" }
    };

    const withoutInternalRole = await (await fetch(`${baseUrl}/staff`)).text();
    assert.doesNotMatch(
      withoutInternalRole,
      /bookings@romanairporttransfers\.co\.uk/,
      "a customer-only bookings@ account must not appear in the staff list"
    );

    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES
        ('b0000000-0000-0000-0000-000000000001', $1)
       ON CONFLICT DO NOTHING`,
      [ROLE_IDS.dispatcher]
    );

    const withInternalRole = await (await fetch(`${baseUrl}/staff`)).text();
    assert.match(
      withInternalRole,
      /bookings@romanairporttransfers\.co\.uk/,
      "bookings@ must appear once it also holds an internal (dispatcher) role"
    );
  });
});

describe("GET/POST /staff/invite (create / invite user)", () => {
  let dbContext: TestDatabaseContext;
  let server: http.Server;
  let baseUrl: string;
  let currentSession: SessionAccount = { authenticated: false };
  let invitationRequests: string[] = [];
  let invitationDeliveryFails = false;

  before(async () => {
    dbContext = await createTestDatabaseContext("test_staff_invite");
    await dbContext.createAuthTables();
    await initializeDatabase();

    // Extend the base auth fixture with the internal role catalogue and the
    // permissions used by the staff-management authorization rules.
    await query(
      `INSERT INTO roles (id, name, description) VALUES
         (10, 'superuser', 'Superuser'),
         (11, 'staff', 'Staff'),
         (12, 'tech_support', 'Technical support'),
         (13, 'dispatcher', 'Dispatcher'),
         (14, 'customer', 'Customer'),
         (15, 'partner', 'Partner')
       ON CONFLICT (id) DO NOTHING`
    );
    await query(
      `INSERT INTO permissions (id, name, description) VALUES
         (10, 'manage_user_roles', 'Manage user roles')
       ON CONFLICT (id) DO NOTHING`
    );
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES
         (1, 2),
         (10, 2),
         (10, 10)
       ON CONFLICT DO NOTHING`
    );

    const app = express();
    app.set("view engine", "ejs");
    app.set("views", path.join(process.cwd(), "src/views"));
    app.use(express.urlencoded({ extended: true }));
    app.use(
      createStaffRouter({
        appTitle: "RideMatrix",
        loadSession: async () => currentSession,
        requestAccessCode: async (email: string) => {
          if (invitationDeliveryFails) {
            throw new Error("Access code delivery is not configured.");
          }

          invitationRequests.push(email);
        }
      })
    );

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await dbContext.cleanup();
  });

  function signIn(email: string, roles: string[]): void {
    currentSession = {
      authenticated: true,
      user: { id: "session-user", email, roles, active_role: roles[0] }
    };
  }

  function signOut(): void {
    currentSession = { authenticated: false };
  }

  async function postInvite(body: Record<string, string | string[]>): Promise<Response> {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(body)) {
      if (Array.isArray(value)) {
        value.forEach((entry) => params.append(key, entry));
      } else {
        params.append(key, value);
      }
    }

    return fetch(`${baseUrl}/staff/invite`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    });
  }

  async function getRolesOf(email: string): Promise<string[]> {
    const result = await query<{ name: string }>(
      `SELECT r.name
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE lower(u.email) = $1
        ORDER BY r.name`,
      [email.toLowerCase()]
    );

    return result.rows.map((row) => row.name);
  }

  async function countUsers(email: string): Promise<number> {
    const result = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM users WHERE lower(email) = $1`,
      [email.toLowerCase()]
    );

    return result.rows[0].count;
  }

  test("an authorized administrator can open the create/invite form", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const response = await fetch(`${baseUrl}/staff/invite`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Create \/ Invite user/);
    assert.match(body, /value="staff"/);
    assert.match(body, /value="dispatcher"/);
  });

  test("customer and partner roles are not offered by the internal invite flow", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const body = await (await fetch(`${baseUrl}/staff/invite`)).text();

    assert.doesNotMatch(body, /value="customer"/);
    assert.doesNotMatch(body, /value="partner"/);
  });

  test("the form never exposes passwords, login codes, or other secrets", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const body = await (await fetch(`${baseUrl}/staff/invite`)).text();

    assert.doesNotMatch(body, /password/i);
    assert.doesNotMatch(body, /login_code/i);
    assert.doesNotMatch(body, /type="password"/);
  });

  test("unauthenticated access redirects to /access", async () => {
    signOut();

    const response = await fetch(`${baseUrl}/staff/invite`, { redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");

    const posted = await postInvite({ email: "someone@example.com", roles: "staff" });
    assert.equal(posted.status, 302);
    assert.equal(posted.headers.get("location"), "/access");
  });

  test("an authenticated but unauthorized user receives 403 instead of a redirect", async () => {
    signIn("driver@ridematrix.com", ["driver"]);

    const response = await fetch(`${baseUrl}/staff/invite`, { redirect: "manual" });

    assert.equal(response.status, 403);

    const posted = await postInvite({ email: "someone@example.com", roles: "staff" });
    assert.equal(posted.status, 403);
  });

  test("a valid email and role create exactly one user and one user_roles row", async () => {
    signIn("admin@ridematrix.com", ["admin"]);
    invitationRequests = [];

    const response = await postInvite({ email: "  New.Staff@Example.com ", roles: "staff" });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /new\.staff@example\.com/);
    assert.match(body, /Staff/);

    assert.equal(await countUsers("new.staff@example.com"), 1);
    assert.deepEqual(await getRolesOf("new.staff@example.com"), ["staff"]);
    assert.deepEqual(invitationRequests, ["new.staff@example.com"]);
  });

  test("the new account is created with the Pending status when the schema supports it", async () => {
    const result = await query<{ status: string }>(
      `SELECT status FROM users WHERE lower(email) = $1`,
      ["new.staff@example.com"]
    );

    assert.equal(result.rows[0].status, "Pending");
  });

  test("multiple selected roles are persisted without creating duplicate users", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const response = await postInvite({
      email: "multi.role@example.com",
      roles: ["staff", "dispatcher", "tech_support"]
    });

    assert.equal(response.status, 200);
    assert.equal(await countUsers("multi.role@example.com"), 1);
    assert.deepEqual(await getRolesOf("multi.role@example.com"), [
      "dispatcher",
      "staff",
      "tech_support"
    ]);
  });

  test("a missing role selection is rejected", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const response = await postInvite({ email: "no.role@example.com" });
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /Select at least one role/);
    assert.match(body, /value="no\.role@example\.com"/);
    assert.equal(await countUsers("no.role@example.com"), 0);
  });

  test("an unknown role is rejected", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const response = await postInvite({ email: "bad.role@example.com", roles: "root" });

    assert.equal(response.status, 400);
    assert.equal(await countUsers("bad.role@example.com"), 0);
  });

  test("customer and partner roles cannot be assigned through the invite flow", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    for (const role of ["customer", "partner"]) {
      const response = await postInvite({ email: `${role}.attempt@example.com`, roles: role });

      assert.equal(response.status, 400);
      assert.equal(await countUsers(`${role}.attempt@example.com`), 0);
    }
  });

  test("an invalid email is rejected without losing the role selection", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const response = await postInvite({ email: "not-an-email", roles: "staff" });
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /Enter a valid email address/);
    assert.match(body, /id="role-staff"[\s\S]*?checked/);
  });

  test("an unauthorized administrator cannot delegate superuser by tampering with the POST body", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const response = await postInvite({
      email: "escalation@example.com",
      roles: ["staff", "superuser"],
      confirmSuperuser: "yes"
    });
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /not authorized to delegate/);
    assert.equal(await countUsers("escalation@example.com"), 0);
  });

  test("superuser delegation requires the explicit confirmation", async () => {
    signIn("root@ridematrix.com", ["superuser"]);

    const response = await postInvite({ email: "unconfirmed@example.com", roles: "superuser" });

    assert.equal(response.status, 400);
    assert.equal(await countUsers("unconfirmed@example.com"), 0);
  });

  test("an authorized creator can create the future superuser account", async () => {
    signIn("root@ridematrix.com", ["superuser"]);
    invitationDeliveryFails = true;

    const response = await postInvite({
      email: "roman.petrlik@hotmail.com",
      roles: "superuser",
      confirmSuperuser: "yes"
    });
    const body = await response.text();

    invitationDeliveryFails = false;

    assert.equal(response.status, 200);
    assert.match(body, /Invitation pending/);
    assert.equal(await countUsers("roman.petrlik@hotmail.com"), 1);
    assert.deepEqual(await getRolesOf("roman.petrlik@hotmail.com"), ["superuser"]);
  });

  test("a duplicate active email is handled without creating a second account", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const response = await postInvite({ email: "New.Staff@example.com", roles: "staff" });
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /already exists/);
    assert.equal(await countUsers("new.staff@example.com"), 1);
  });

  test("existing auth accounts and customer persistence remain intact", async () => {
    const existing = await query<{ email: string }>(
      `SELECT email FROM users WHERE email IN ('admin@ridematrix.com', 'driver@ridematrix.com') ORDER BY email`
    );

    assert.deepEqual(
      existing.rows.map((row) => row.email),
      ["admin@ridematrix.com", "driver@ridematrix.com"]
    );
    assert.deepEqual(await getRolesOf("admin@ridematrix.com"), []);
    assert.equal(await getCustomerCount(), 18);
  });
});
