import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import express from "express";
import { initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext, safeCleanupTestDatabase } from "../database/test-helper";
import { getCustomerCount } from "../services/customers";
import { SessionAccount } from "../services/api";
import { getPermissionsForRoles } from "../services/staff-users";
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
    staff: 3,
    customer: 4
  };

  before(async () => {
    dbContext = await createTestDatabaseContext("test_staff_routes");
    await dbContext.createAuthTables();
    await initializeDatabase();

    await query(
      `INSERT INTO roles (id, key, description) VALUES
        ($1, 'staff', 'Dispatcher / staff user'),
        ($2, 'customer', 'Customer')
       ON CONFLICT (id) DO NOTHING`,
      [ROLE_IDS.staff, ROLE_IDS.customer]
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
    await safeCleanupTestDatabase(dbContext);
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
      user: { id: "u-1", email: "staff@ridematrix.com", roles: ["staff"] }
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
      [ROLE_IDS.driver, ROLE_IDS.staff]
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
    assert.match(body, /Staff/);
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

  test("the directory renders a summary card, a structured table, and separate role badges", async () => {
    mockSession = {
      authenticated: true,
      user: { id: "u-3", email: "admin@ridematrix.com", roles: ["admin"], active_role: "admin" }
    };

    const body = await (await fetch(`${baseUrl}/staff`)).text();

    assert.match(body, /class="staff-stat-card"/);
    assert.match(body, /class="staff-table"/);
    assert.match(body, /<a class="staff-button staff-button--primary" href="\/staff\/invite">/);
    assert.match(body, /<span class="staff-role-badge">Driver<\/span>/);
    assert.match(body, /<span class="staff-role-badge">Staff<\/span>/);
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
      [ROLE_IDS.staff]
    );

    const withInternalRole = await (await fetch(`${baseUrl}/staff`)).text();
    assert.match(
      withInternalRole,
      /bookings@romanairporttransfers\.co\.uk/,
      "bookings@ must appear once it also holds the internal staff role"
    );
  });

  describe("login audit history", () => {
    const DRIVER_ID = "a0000000-0000-0000-0000-000000000002";
    const adminSession: MockSession = {
      authenticated: true,
      user: { id: "u-3", email: "admin@ridematrix.com", roles: ["admin"], active_role: "admin" }
    };

    before(async () => {
      await query(`DELETE FROM staff_login_audit`);
      await query(
        `INSERT INTO staff_login_audit
          (id, occurred_at, event_name, account_id, login_identifier, success, failure_category, ip_address, user_agent)
         VALUES
          ('route-evt-1', '2025-03-04T09:10:11.000Z', 'staff_login_succeeded', $1, 'driver@ridematrix.com', TRUE, NULL, '198.51.100.7', 'Mozilla/5.0 <script>alert("ua")</script>'),
          ('route-evt-2', '2025-03-05T09:10:11.000Z', 'staff_login_failed', $1, 'driver@ridematrix.com', FALSE, 'unauthorized', '198.51.100.8', NULL),
          ('route-evt-3', '2025-03-06T09:10:11.000Z', 'staff_login_succeeded', 'someone-else', 'other@ridematrix.com', TRUE, NULL, '192.0.2.99', 'Other-Agent')`,
        [DRIVER_ID]
      );
    });

    after(async () => {
      await query(`DELETE FROM staff_login_audit`);
    });

    test("the directory shows the last login derived from staff_login_audit and links each record to its history", async () => {
      mockSession = adminSession;

      const body = await (await fetch(`${baseUrl}/staff`)).text();

      assert.match(body, /4 Mar 2025/);
      assert.match(body, /id="staff-login-history-hint"/);
      assert.match(
        body,
        new RegExp(`<a class="staff-table__email staff-table__email-link" href="/staff/${DRIVER_ID}/audit" aria-describedby="staff-login-history-hint">driver@ridematrix\\.com</a>`)
      );
    });

    test("an authorized admin sees successful and failed events for the selected account only", async () => {
      mockSession = adminSession;

      const response = await fetch(`${baseUrl}/staff/${DRIVER_ID}/audit`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control") || "", /no-store/);

      const body = await response.text();
      assert.match(body, /Login history/);
      assert.match(body, /driver@ridematrix\.com/);
      assert.match(body, /2 login events/);
      assert.match(body, /Succeeded/);
      assert.match(body, /Failed/);
      assert.match(body, /staff_login_succeeded/);
      assert.match(body, /staff_login_failed/);
      assert.match(body, /Unauthorized/);
      assert.match(body, /198\.51\.100\.7/);
      assert.match(body, /198\.51\.100\.8/);
      assert.match(body, /<time datetime="2025-03-04T09:10:11.000Z">/);
      assert.doesNotMatch(body, /192\.0\.2\.99/);
      assert.doesNotMatch(body, /Other-Agent/);
      assert.doesNotMatch(body, /other@ridematrix\.com/);
    });

    test("embedded details reuse protected account-scoped history without the navigation shell", async () => {
      mockSession = adminSession;
      const response = await fetch(`${baseUrl}/staff/${DRIVER_ID}/audit?dialog=1`);
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      assert.match(body, /User details/);
      assert.match(body, /driver@ridematrix\.com/);
      assert.match(body, /Created/);
      assert.match(body, /Driver/);
      assert.match(body, /2 login events/);
      assert.match(body, /198\.51\.100\.7/);
      assert.doesNotMatch(body, /Other-Agent|192\.0\.2\.99|other@ridematrix\.com/);
      assert.doesNotMatch(body, /Back to staff directory|currentUserEmail/);
      assert.doesNotMatch(body, /<script>alert\("ua"\)<\/script>/);

      mockSession = { authenticated: false };
      const signedOut = await fetch(`${baseUrl}/staff/${DRIVER_ID}/audit?dialog=1`, { redirect: "manual" });
      assert.equal(signedOut.status, 302);
      assert.equal(signedOut.headers.get("location"), "/access");
      assert.match(signedOut.headers.get("cache-control") || "", /no-store/);

      mockSession = { authenticated: true, user: { id: DRIVER_ID, email: "driver@ridematrix.com", roles: ["driver"] } };
      const forbidden = await fetch(`${baseUrl}/staff/${DRIVER_ID}/audit?dialog=1`);
      assert.equal(forbidden.status, 403);
      assert.match(forbidden.headers.get("cache-control") || "", /no-store/);
      assert.doesNotMatch(await forbidden.text(), /198\.51\.100\.7/);

      mockSession = adminSession;
      const missing = await fetch(`${baseUrl}/staff/unknown/audit?dialog=1`);
      assert.equal(missing.status, 404);
      assert.doesNotMatch(await missing.text(), /198\.51\.100\.7/);
    });

    test("user-controlled audit values are HTML-escaped", async () => {
      mockSession = adminSession;

      const body = await (await fetch(`${baseUrl}/staff/${DRIVER_ID}/audit`)).text();

      assert.doesNotMatch(body, /<script>alert\("ua"\)<\/script>/);
      assert.match(body, /&lt;script&gt;alert\(&#34;ua&#34;\)&lt;\/script&gt;/);
    });

    test("an account without events renders an empty history", async () => {
      mockSession = adminSession;

      const response = await fetch(`${baseUrl}/staff/b0000000-0000-0000-0000-000000000001/audit`);
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(body, /No login events recorded/);
    });

    test("unauthenticated requests are redirected to /access", async () => {
      mockSession = { authenticated: false };

      const response = await fetch(`${baseUrl}/staff/${DRIVER_ID}/audit`, { redirect: "manual" });

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/access");
    });

    test("users without staff-management authorization receive 403 and no audit data", async () => {
      mockSession = {
        authenticated: true,
        user: { id: DRIVER_ID, email: "driver@ridematrix.com", roles: ["driver", "staff"] }
      };

      const response = await fetch(`${baseUrl}/staff/${DRIVER_ID}/audit`, { redirect: "manual" });
      const body = await response.text();

      assert.equal(response.status, 403);
      assert.match(body, /Unable to continue/);
      assert.doesNotMatch(body, /198\.51\.100\.7/);
    });

    test("unknown, non-staff, and malformed account ids return 404", async () => {
      mockSession = adminSession;

      for (const accountId of [
        "ffffffff-0000-0000-0000-000000000000",
        "c0000000-0000-0000-0000-000000000001",
        encodeURIComponent("1' OR '1'='1"),
        "x".repeat(65)
      ]) {
        const response = await fetch(`${baseUrl}/staff/${accountId}/audit`, { redirect: "manual" });
        const body = await response.text();
        assert.equal(response.status, 404, `expected 404 for ${accountId}`);
        assert.doesNotMatch(body, /198\.51\.100/);
      }
    });
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
      `INSERT INTO roles (id, key, description) VALUES
         (10, 'superuser', 'Superuser'),
         (11, 'staff', 'Staff'),
         (12, 'tech_support', 'Technical support'),
         (14, 'customer', 'Customer'),
         (15, 'partner', 'Partner')
       ON CONFLICT (id) DO NOTHING`
    );
    await query(
      `INSERT INTO permissions (id, key, description) VALUES
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
    await safeCleanupTestDatabase(dbContext);
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
      `SELECT r.key AS name
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE lower(u.email) = $1
        ORDER BY r.key`,
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

  test("a production-shaped role catalogue renders the internal role checkboxes", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const namedRoles = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM roles WHERE name IS NOT NULL`
    );
    const response = await fetch(`${baseUrl}/staff/invite`);
    const body = await response.text();

    assert.equal(namedRoles.rows[0].count, 0);
    assert.equal(response.status, 200);
    assert.match(body, /Create \/ Invite user/);
    assert.match(body, /value="superuser"/);
    assert.match(body, /value="admin"/);
    assert.match(body, /value="staff"/);
    assert.match(body, /value="driver"/);
    assert.match(body, /value="tech_support"/);
    assert.match(body, />System Control</);
    assert.match(body, />Administration</);
    assert.match(body, />Staff</);
    assert.match(body, />Driver</);
    assert.match(body, />Technical Support</);
    assert.doesNotMatch(body, /value="dispatcher"/);
  });

  test("the invite form renders a styled card with individual role option cards", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const body = await (await fetch(`${baseUrl}/staff/invite`)).text();
    const roleOptions = body.match(/<li class="staff-role-option/g) || [];

    assert.match(body, /class="staff-card staff-form-card"/);
    assert.match(body, /class="staff-role-options"/);
    assert.ok(roleOptions.length >= 5, "each assignable role must render its own option card");
    assert.match(body, /class="staff-button staff-button--primary"/);
  });

  test("permission lookup reads grants from permissions.key", async () => {
    assert.deepEqual(await getPermissionsForRoles(["admin"]), ["manage_users"]);
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
      roles: ["staff", "driver", "tech_support"]
    });

    assert.equal(response.status, 200);
    assert.equal(await countUsers("multi.role@example.com"), 1);
    assert.deepEqual(await getRolesOf("multi.role@example.com"), [
      "driver",
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
