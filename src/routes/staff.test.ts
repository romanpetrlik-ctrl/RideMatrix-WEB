import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express from "express";
import { closeDatabase, initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import { createStaffRouter } from "./staff";

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
  assert.match(body, /No staff users yet/);
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
