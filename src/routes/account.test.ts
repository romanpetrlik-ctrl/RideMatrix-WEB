import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import express from "express";
import { createAccountRouter } from "./account";

describe("GET /account (personal account page)", () => {
  type MockSession = {
    authenticated: boolean;
    user?: {
      id: string;
      email: string;
      roles: string[];
      active_role?: string;
    };
  };

  let authServer: http.Server;
  let appServer: http.Server;
  let baseUrl: string;
  let mockSession: MockSession = { authenticated: false };

  before(async () => {
    // getSessionAccount() reads API_BASE_URL once at import time (defaulting
    // to http://127.0.0.1:4000), so the stand-in auth server for this suite
    // must also listen on port 4000, matching the pattern used by
    // src/routes/staff.test.ts.
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
    app.use(createAccountRouter({ appTitle: "RideMatrix Test" }));

    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    const port = (appServer.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
  });

  test("unauthenticated requests are redirected to /access", async () => {
    mockSession = { authenticated: false };

    const response = await fetch(`${baseUrl}/account`, { redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
  });

  test("renders the personal account page for a staff-role user instead of the staff list", async () => {
    mockSession = {
      authenticated: true,
      user: { id: "u-1", email: "staff.member@ridematrix.com", roles: ["staff"], active_role: "staff" }
    };

    const response = await fetch(`${baseUrl}/account`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Signed in as:.*staff\.member@ridematrix\.com/);
    assert.doesNotMatch(body, /staff records/);
    assert.doesNotMatch(body, /staff-table/);
  });

  test("renders the personal account page for an admin user without redirecting to /staff", async () => {
    mockSession = {
      authenticated: true,
      user: { id: "u-2", email: "admin@ridematrix.com", roles: ["admin"], active_role: "admin" }
    };

    const response = await fetch(`${baseUrl}/account`, { redirect: "manual" });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Account/);
    assert.match(body, /Signed in as:.*admin@ridematrix\.com/);
  });
});
