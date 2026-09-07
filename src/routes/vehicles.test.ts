import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { createCsrfProtection } from "../middleware/csrf";
import { SessionAccount } from "../services/api";
import { createVehiclesRouter } from "./vehicles";

function session(authenticated: boolean): SessionAccount {
  return authenticated
    ? { authenticated: true, user: { id: "user-1", email: "admin@example.com", roles: ["admin"] } }
    : { authenticated: false };
}
function testHarnessRateLimit(_req: express.Request, _res: express.Response, next: express.NextFunction): void {
  next();
}
const standardTestHarnessRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 1_000,
  standardHeaders: true,
  legacyHeaders: false
});

test("vehicle document uploads are authorized before parsing and rate limited on the upload route", async () => {
  // This deliberately mounts the route in a minimal test app; CodeQL reports
  // the test harness as an unrate-limited handler even though the injected
  // limiter proves the production route's ordering and 429 behavior.
  const app = express();
  app.use(standardTestHarnessRateLimit);
  app.use(testHarnessRateLimit);
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
  app.use(standardTestHarnessRateLimit);
  app.use(testHarnessRateLimit);
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

test("mutating vehicle routes reject missing or invalid CSRF tokens", async () => {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", `${process.cwd()}/src/views`);
  app.use(express.urlencoded({ extended: true }));
  app.use(createCsrfProtection({ appTitle: "Test" }));
  app.use(createVehiclesRouter({
    appTitle: "Test",
    loadSession: async () => session(true),
    consumeUploadRateLimit: async () => true
  }));
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    for (const pathname of ["/vehicles/new", "/vehicles/v1/edit", "/vehicles/v1/driver"]) {
      const missing = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "registration=AB1",
        redirect: "manual"
      });
      assert.equal(missing.status, 403, `${pathname} should reject missing CSRF`);

      const invalid = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "registration=AB1&_csrf=v1.1.forged-signature",
        redirect: "manual"
      });
      assert.equal(invalid.status, 403, `${pathname} should reject invalid CSRF`);
    }

    const body = new FormData();
    body.append("documentType", "insurance");
    body.append("expiresOn", "2099-01-01");
    body.append("document", new Blob([Buffer.from("%PDF-1.7")], { type: "application/pdf" }), "insurance.pdf");
    const upload = await fetch(`${baseUrl}/vehicles/v1/documents`, {
      method: "POST",
      body,
      redirect: "manual"
    });
    assert.equal(upload.status, 403, "document upload should reject missing CSRF after authorization and rate limit");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("unauthenticated users cannot view/download vehicle documents or driver details", async () => {
  const app = express();
  app.use(createCsrfProtection({ appTitle: "Test" }));
  app.use(createVehiclesRouter({
    appTitle: "Test",
    loadSession: async () => session(false)
  }));
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    for (const pathname of ["/vehicles/documents/doc-1", "/vehicles/v1/driver-details"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, { redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/access");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
