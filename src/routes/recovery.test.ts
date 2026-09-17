import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import express from "express";
import { createRecoveryRouter } from "./recovery";

describe("GET /recovery", () => {
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
    app.use(createRecoveryRouter({ appTitle: "RideMatrix Test" }));

    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
  });

  test("redirects unauthenticated visitors to /access", async () => {
    mockSession = { authenticated: false };

    const response = await fetch(`${baseUrl}/recovery`, { redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
  });

  test("returns 403 for authenticated users without the superuser role", async () => {
    mockSession = {
      authenticated: true,
      user: { id: "u-staff", email: "staff@ridematrix.com", roles: ["staff"], active_role: "staff" }
    };

    const response = await fetch(`${baseUrl}/recovery`, { redirect: "manual" });
    const body = await response.text();

    assert.equal(response.status, 403);
    assert.match(body, /Unable to continue/);
  });

  test("keeps recovery workflow pages reachable for authorized superusers", async () => {
    mockSession = {
      authenticated: true,
      user: { id: "u-root", email: "root@ridematrix.com", roles: ["superuser"], active_role: "superuser" }
    };

    const indexResponse = await fetch(`${baseUrl}/recovery`);
    const indexBody = await indexResponse.text();
    assert.equal(indexResponse.status, 200);
    assert.match(indexBody, /Help \/ Recovery/);
    assert.match(indexBody, /href="\/recovery\/backup"/);

    const [backupResponse, warningResponse, restartResponse] = await Promise.all([
      fetch(`${baseUrl}/recovery/backup`),
      fetch(`${baseUrl}/recovery/warning`),
      fetch(`${baseUrl}/recovery/restart`)
    ]);
    const [backupBody, warningBody, restartBody] = await Promise.all([
      backupResponse.text(),
      warningResponse.text(),
      restartResponse.text()
    ]);

    assert.equal(backupResponse.status, 200);
    assert.equal(warningResponse.status, 200);
    assert.equal(restartResponse.status, 200);
    assert.match(backupBody, /href="\/recovery">Back to Help \/ Recovery/);
    assert.match(warningBody, /href="\/recovery">Back to Help \/ Recovery/);
    assert.match(restartBody, /href="\/recovery">Back to Help \/ Recovery/);
  });
});
