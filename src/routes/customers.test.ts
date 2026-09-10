import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { SessionAccount } from "../services/api";
import { createCustomersRouter } from "./customers";

function createTestServer(session: SessionAccount) {
  const app = express();
  app.use(createCustomersRouter({
    appTitle: "RideMatrix Test",
    loadSession: async () => session
  }));
  return app.listen(0);
}

async function requestPreview(session: SessionAccount, value: string) {
  const server = createTestServer(session);
  try {
    const address = server.address() as { port: number };
    return await fetch(
      `http://127.0.0.1:${address.port}/customers/phone-preview?value=${encodeURIComponent(value)}`
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const adminSession: SessionAccount = {
  authenticated: true,
  user: { id: "admin-1", email: "admin@example.com", roles: ["admin"], active_role: "admin" }
};

test("phone preview route is registered and returns international metadata", async () => {
  const response = await requestPreview(adminSession, "+420 555 666 777");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.normalized, "+420555666777");
  assert.equal(body.country.isoCode, "CZ");
});

test("phone preview normalizes 00 international prefixes and builds E.164 links", async () => {
  const response = await requestPreview(adminSession, "00420724982564");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.normalized, "+420724982564");
  assert.equal(body.country.isoCode, "CZ");
  assert.equal(body.telHref, "tel:+420724982564");
  assert.equal(body.whatsappHref, "https://wa.me/420724982564");
});

test("phone preview accepts the Czech mobile example and preserves metadata", async () => {
  const response = await requestPreview(adminSession, "+420777888999");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    valid: true,
    normalized: "+420777888999",
    display: "+420 777 888 999",
    country: {
      isoCode: "CZ",
      countryName: "Czechia",
      callingCode: "+420"
    },
    telHref: "tel:+420777888999",
    whatsappHref: "https://wa.me/420777888999"
  });
});

test("phone preview uses GB for local numbers", async () => {
  const response = await requestPreview(adminSession, "07777 888 999");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.normalized, "+447777888999");
  assert.equal(body.country.isoCode, "GB");
});

test("phone preview rejects invalid numbers", async () => {
  const response = await requestPreview(adminSession, "123");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.valid, false);
});

test("phone preview requires authentication and admin authorization", async () => {
  const unauthenticated = await requestPreview({ authenticated: false }, "+420 555 666 777");
  assert.equal(unauthenticated.status, 401);

  const nonAdmin = await requestPreview({
    authenticated: true,
    user: { id: "staff-1", email: "staff@example.com", roles: ["staff"] }
  }, "+420 555 666 777");
  assert.equal(nonAdmin.status, 403);
});
