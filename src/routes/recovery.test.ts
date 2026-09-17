import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import express from "express";
import { createRecoveryRouter } from "./recovery";

describe("GET /recovery", { concurrency: false }, () => {
  type MockSession = {
    authenticated: boolean;
    user?: {
      id: string;
      email: string;
      roles: string[];
      active_role?: string;
    };
  };

  let appServer: Server;
  let baseUrl: string;
  let mockSession: MockSession = { authenticated: false };
  let loadSessionError: Error | null = null;

  before(async () => {
    const app = express();
    app.set("view engine", "ejs");
    app.set("views", path.join(process.cwd(), "src/views"));
    app.use(express.urlencoded({ extended: true }));
    app.use(createRecoveryRouter({
      appTitle: "RideMatrix Test",
      loadSession: async () => {
        if (loadSessionError) {
          throw loadSessionError;
        }

        return mockSession;
      }
    }));
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).send(`error:${error.message}`);
    });

    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
  });

  test("redirects unauthenticated visitors to /access", async () => {
    loadSessionError = null;
    mockSession = { authenticated: false };

    const response = await fetch(`${baseUrl}/recovery`, { redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
  });

  test("returns 403 for authenticated users without the superuser role", async () => {
    loadSessionError = null;
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
    loadSessionError = null;
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

  test("forwards session-loading failures to Express error handling for recovery routes", async () => {
    loadSessionError = new Error("session lookup failed");

    const [indexResponse, backupResponse] = await Promise.all([
      fetch(`${baseUrl}/recovery`, { redirect: "manual" }),
      fetch(`${baseUrl}/recovery/backup`, { redirect: "manual" })
    ]);
    const [indexBody, backupBody] = await Promise.all([
      indexResponse.text(),
      backupResponse.text()
    ]);

    assert.equal(indexResponse.status, 500);
    assert.equal(backupResponse.status, 500);
    assert.match(indexBody, /^error:session lookup failed$/);
    assert.match(backupBody, /^error:session lookup failed$/);
    loadSessionError = null;
  });
});
