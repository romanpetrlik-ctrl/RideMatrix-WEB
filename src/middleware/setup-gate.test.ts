import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createSetupGateMiddleware } from "./setup-gate";

let authenticated = true;
let setupCompleted = false;

async function withServer(gateFlag: string | undefined, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const previousGateFlag = process.env.INITIAL_SETUP_GATE_ENABLED;
  if (gateFlag === undefined) {
    delete process.env.INITIAL_SETUP_GATE_ENABLED;
  } else {
    process.env.INITIAL_SETUP_GATE_ENABLED = gateFlag;
  }

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
        addressDetails: { registeredPho: null, operational: null },
        licence: null,
        latestDocument: null
      })
    })
  );

  app.get("/dashboard", (_req, res) => res.status(200).send("dashboard"));
  app.get("/setup/operator-profile", (_req, res) => res.status(200).send("setup"));
  app.get("/access", (_req, res) => res.status(200).send("access"));

  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousGateFlag === undefined) {
      delete process.env.INITIAL_SETUP_GATE_ENABLED;
    } else {
      process.env.INITIAL_SETUP_GATE_ENABLED = previousGateFlag;
    }
  }
}

test("does not redirect authenticated users to /setup when the gate is disabled by default", async () => {
  authenticated = true;
  setupCompleted = false;

  await withServer(undefined, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/dashboard`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "dashboard");
  });
});

test("redirects authenticated users to /setup when the gate is explicitly enabled", async () => {
  authenticated = true;
  setupCompleted = false;

  await withServer("true", async (baseUrl) => {
    const response = await fetch(`${baseUrl}/dashboard`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/setup");
  });
});

test("does not gate /setup paths", async () => {
  authenticated = true;
  setupCompleted = false;

  await withServer("true", async (baseUrl) => {
    const response = await fetch(`${baseUrl}/setup/operator-profile`);
    assert.equal(response.status, 200);
  });
});

test("does not gate when setup is completed", async () => {
  authenticated = true;
  setupCompleted = true;

  await withServer("true", async (baseUrl) => {
    const response = await fetch(`${baseUrl}/dashboard`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "dashboard");
  });
});

test("does not gate unauthenticated users", async () => {
  authenticated = false;
  setupCompleted = false;

  await withServer("true", async (baseUrl) => {
    const response = await fetch(`${baseUrl}/dashboard`);
    assert.equal(response.status, 200);
  });
});
