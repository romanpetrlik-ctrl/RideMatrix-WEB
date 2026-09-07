import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import { SessionAccount } from "../services/api";
import { createVehiclesRouter } from "./vehicles";

function session(authenticated: boolean): SessionAccount {
  return authenticated
    ? { authenticated: true, user: { id: "user-1", email: "admin@example.com", roles: ["admin"] } }
    : { authenticated: false };
}

test("vehicle document uploads are authorized before parsing and rate limited on the upload route", async () => {
  // This deliberately mounts the route in a minimal test app; CodeQL reports
  // the test harness as an unrate-limited handler even though the injected
  // limiter proves the production route's ordering and 429 behavior.
  const app = express();
  app.use(createCsrfProtection({ appTitle: "Test" }));
  let rateLimitCalls = 0;
  app.use(createVehiclesRouter({
    appTitle: "Test",
    loadSession: async () => session(true),
    consumeUploadRateLimit: async () => {
      rateLimitCalls += 1;
      return false;
    }
  }));
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const body = new FormData();
    body.append("documentType", "Insurance");
    body.append("document", new Blob([Buffer.from("%PDF-1.7")], { type: "application/pdf" }), "insurance.pdf");
    const response = await fetch(`http://127.0.0.1:${address.port}/vehicles/v1/documents`, {
      method: "POST",
      body
    });
    assert.equal(response.status, 429);
    assert.equal(rateLimitCalls, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("unauthenticated users cannot upload vehicle documents", async () => {
  const app = express();
  app.use(createCsrfProtection({ appTitle: "Test" }));
  let rateLimitCalls = 0;
  app.use(createVehiclesRouter({
    appTitle: "Test",
    loadSession: async () => session(false),
    consumeUploadRateLimit: async () => {
      rateLimitCalls += 1;
      return false;
    }
  }));
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/vehicles/v1/documents`, {
      method: "POST",
      body: new FormData(),
      redirect: "manual"
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
    assert.equal(rateLimitCalls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
