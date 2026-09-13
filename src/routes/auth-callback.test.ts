import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express from "express";
import { createAuthCallbackRouter } from "./auth-callback";

let authServer: http.Server;
let appServer: http.Server;
let baseUrl: string;
let sessionResponse: object;

before(async () => {
  authServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(sessionResponse));
  });
  await new Promise<void>((resolve) => authServer.listen(4000, "127.0.0.1", resolve));

  const app = express();
  app.use(
    createAuthCallbackRouter({
      logLogin: async (event) => {
        events.push(event);
      }
    })
  );
  appServer = app.listen(0);
  await new Promise<void>((resolve) => appServer.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => authServer.close(() => resolve()));
});

let events: Array<Record<string, unknown>> = [];

test("successful internal callback logs only after authentication and preserves redirect", async () => {
  events = [];
  sessionResponse = {
    authenticated: true,
    user: { id: "staff-1", email: "STAFF@EXAMPLE.COM", roles: ["tech_support"] }
  };

  const response = await fetch(`${baseUrl}/auth/callback`, {
    headers: { "user-agent": "test-agent" },
    redirect: "manual"
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/tech-support");
  assert.deepEqual(events, [
    {
      eventName: "staff_login_succeeded",
      accountId: "staff-1",
      loginIdentifier: "STAFF@EXAMPLE.COM",
      success: true,
      ipAddress: "::ffff:127.0.0.1",
      userAgent: "test-agent"
    }
  ]);
});

test("unauthenticated callback logs rejection without credentials or success", async () => {
  events = [];
  sessionResponse = { authenticated: false };

  const response = await fetch(`${baseUrl}/auth/callback`, { redirect: "manual" });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/access");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventName, "staff_login_failed");
  assert.equal(events[0].failureCategory, "unauthorized");
  assert.equal(events[0].success, false);
  assert.equal("password" in events[0], false);
  assert.equal("token" in events[0], false);
});
