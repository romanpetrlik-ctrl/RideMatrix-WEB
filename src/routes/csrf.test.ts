import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import express from "express";
import { initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import { createCsrfProtection } from "../middleware/csrf";
import { CSRF_COOKIE_NAME } from "../services/csrf";
import { createAccountRouter } from "./account";
import { createStaffRouter } from "./staff";

describe("CSRF protection on state-changing HTML forms", () => {
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

  before(async () => {
    dbContext = await createTestDatabaseContext("test_csrf_routes");
    await dbContext.createAuthTables();
    await initializeDatabase();

    await query(
      `INSERT INTO roles (id, name, description) VALUES
         (20, 'staff', 'Staff'),
         (21, 'superuser', 'System control')
       ON CONFLICT (id) DO NOTHING`
    );
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES (1, 2)
       ON CONFLICT DO NOTHING`
    );

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
    app.set("views", path.join(process.cwd(), "src/views"));
    app.use(express.urlencoded({ extended: true }));
    app.use(createCsrfProtection({ appTitle: "RideMatrix Test" }));
    app.use(createStaffRouter({ appTitle: "RideMatrix Test" }));
    app.use(createAccountRouter({ appTitle: "RideMatrix Test" }));

    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
    await dbContext.cleanup();
  });

  function signIn(email: string, roles: string[]): void {
    mockSession = {
      authenticated: true,
      user: { id: `session-${email}`, email, roles, active_role: roles[0] }
    };
  }

  function signOut(): void {
    mockSession = { authenticated: false };
  }

  function readCsrfCookie(response: Response): string {
    const setCookies = response.headers.getSetCookie();
    const cookie = setCookies.find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`));

    assert.ok(cookie, "expected the CSRF cookie to be issued");
    return cookie.split(";")[0];
  }

  function readTokenField(body: string): string {
    const match = /name="_csrf" value="([^"]+)"/.exec(body);
    assert.ok(match, "expected a hidden CSRF field in the rendered form");
    return match[1];
  }

  async function openForm(pathname: string): Promise<{ cookie: string; token: string; body: string }> {
    const response = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
    const body = await response.text();

    return { cookie: readCsrfCookie(response), token: readTokenField(body), body };
  }

  async function postForm(
    pathname: string,
    fields: Record<string, string | string[]>,
    cookie?: string
  ): Promise<Response> {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        value.forEach((entry) => params.append(key, entry));
      } else {
        params.append(key, value);
      }
    }

    return fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {})
      },
      body: params.toString(),
      redirect: "manual"
    });
  }

  async function countUsers(email: string): Promise<number> {
    const result = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM users WHERE lower(email) = $1`,
      [email.toLowerCase()]
    );

    return result.rows[0].count;
  }

  test("the invite form renders a CSRF token and never exposes it in a URL", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const form = await openForm("/staff/invite");

    assert.ok(form.token.length > 0);
    assert.match(form.body, /name="_csrf"/);
    assert.doesNotMatch(form.body, new RegExp(`_csrf=${form.token}`));
    assert.match(form.cookie, new RegExp(`^${CSRF_COOKIE_NAME}=`));
  });

  test("the CSRF cookie is httpOnly and SameSite=Lax", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const response = await fetch(`${baseUrl}/staff/invite`, { redirect: "manual" });
    await response.text();
    const cookie = response.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`));

    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
  });

  test("POST /staff/invite succeeds with a valid token", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const form = await openForm("/staff/invite");
    const response = await postForm(
      "/staff/invite",
      { email: "csrf.valid@example.com", roles: "staff", _csrf: form.token },
      form.cookie
    );

    assert.equal(response.status, 200);
    assert.equal(await countUsers("csrf.valid@example.com"), 1);
  });

  test("POST /staff/invite without a token is rejected with 403", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const form = await openForm("/staff/invite");
    const response = await postForm(
      "/staff/invite",
      { email: "csrf.missing@example.com", roles: "staff" },
      form.cookie
    );

    assert.equal(response.status, 403);
    assert.equal(await countUsers("csrf.missing@example.com"), 0);
  });

  test("POST /staff/invite with an invalid token is rejected with 403", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const form = await openForm("/staff/invite");
    const response = await postForm(
      "/staff/invite",
      { email: "csrf.invalid@example.com", roles: "staff", _csrf: "v1.1.forged-signature" },
      form.cookie
    );

    assert.equal(response.status, 403);
    assert.equal(await countUsers("csrf.invalid@example.com"), 0);
  });

  test("a token issued to one session cannot be replayed by another session", async () => {
    signIn("admin@ridematrix.com", ["admin"]);
    const victimForm = await openForm("/staff/invite");

    signIn("root@ridematrix.com", ["superuser"]);
    const attackerForm = await openForm("/staff/invite");

    const response = await postForm(
      "/staff/invite",
      { email: "csrf.replay@example.com", roles: "staff", _csrf: victimForm.token },
      attackerForm.cookie
    );

    assert.equal(response.status, 403);
    assert.equal(await countUsers("csrf.replay@example.com"), 0);
  });

  test("unauthenticated POST requests still redirect to /access", async () => {
    signIn("admin@ridematrix.com", ["admin"]);
    const form = await openForm("/staff/invite");

    signOut();
    const response = await postForm(
      "/staff/invite",
      { email: "csrf.anonymous@example.com", roles: "staff", _csrf: form.token },
      form.cookie
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
    assert.equal(await countUsers("csrf.anonymous@example.com"), 0);
  });

  test("CSRF validation does not bypass authorization checks", async () => {
    signIn("driver@ridematrix.com", ["driver"]);

    const response = await fetch(`${baseUrl}/staff/invite`, { redirect: "manual" });
    await response.text();

    assert.equal(response.status, 403);
  });

  test("the existing workspace switch form keeps working with a valid token", async () => {
    signIn("admin@ridematrix.com", ["admin"]);

    const form = await openForm("/choose-role");
    const accepted = await postForm(
      "/choose-role",
      { module: "administration", _csrf: form.token },
      form.cookie
    );

    assert.equal(accepted.status, 302);
    assert.equal(accepted.headers.get("location"), "/dashboard");

    const rejected = await postForm("/choose-role", { module: "administration" }, form.cookie);
    assert.equal(rejected.status, 403);
  });
});
