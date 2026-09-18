import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express from "express";
import { createSetupGateMiddleware } from "./setup-gate";

let server: http.Server;
let baseUrl = "";

let authenticated = true;
let setupCompleted = false;

before(async () => {
  const app = express();
  app.use(
    createSetupGateMiddleware({
      loadSession: async () =>
        authenticated
          ? {
              authenticated: true,
              user: {
                id: "u-1",
                email: "admin@ridematrix.uk",
                roles: ["admin"]
              }
            }
          : { authenticated: false },
      loadSetupOverview: async () => ({
        bootstrapCompleted: true,
        setupCompleted,
        currentStep: setupCompleted ? "completed" : "operator_profile",
        operatorId: setupCompleted ? "op-1" : null,
        operator: null,
        addresses: { registeredPho: false, operational: false },
        licence: null,
        latestDocument: null
      })
    })
  );

  app.get("/dashboard", (_req, res) => res.status(200).send("dashboard"));
  app.get("/setup/operator-profile", (_req, res) => res.status(200).send("setup"));
  app.get("/access", (_req, res) => res.status(200).send("access"));

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("redirects authenticated users to /setup while setup is incomplete", async () => {
  authenticated = true;
  setupCompleted = false;

  const response = await fetch(`${baseUrl}/dashboard`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup");
});

test("does not gate /setup paths", async () => {
  authenticated = true;
  setupCompleted = false;

  const response = await fetch(`${baseUrl}/setup/operator-profile`);
  assert.equal(response.status, 200);
});

test("does not gate when setup is completed", async () => {
  authenticated = true;
  setupCompleted = true;

  const response = await fetch(`${baseUrl}/dashboard`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "dashboard");
});

test("does not gate unauthenticated users", async () => {
  authenticated = false;
  setupCompleted = false;

  const response = await fetch(`${baseUrl}/dashboard`);
  assert.equal(response.status, 200);
});
