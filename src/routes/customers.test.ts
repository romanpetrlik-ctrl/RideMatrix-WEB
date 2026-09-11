import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import path from "node:path";
import type { SessionAccount } from "../services/api";
import { createCustomersRouter } from "./customers";

function createTestServer(session: SessionAccount) {
  const app = express();
  app.set("views", path.join(process.cwd(), "src/views"));
  app.set("view engine", "ejs");
  app.use(express.urlencoded({ extended: false }));
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

test("phone preview accepts the Czech mobile regression values", async () => {
  for (const value of ["+420774521617", "00420774521617", "+420777888999", "+420724982564"]) {
    const response = await requestPreview(adminSession, value);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.valid, true);
    assert.equal(body.country.isoCode, "CZ");
  }
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

test("customer register GET ignores the obsolete fontPreview query parameter", async () => {
  const server = createTestServer(adminSession);
  try {
    const address = server.address() as { port: number };
    const standard = await fetch(`http://127.0.0.1:${address.port}/customers/register?type=private`);
    const preview = await fetch(
      `http://127.0.0.1:${address.port}/customers/register?type=private&fontPreview=lato-headings`
    );
    const standardBody = await standard.text();
    const previewBody = await preview.text();

    assert.equal(standard.status, 200);
    assert.equal(preview.status, 200);
    assert.match(standardBody, /family=Lato:wght@400;700&family=Open\+Sans:wght@400;600;700&display=swap/);
    assert.match(previewBody, /family=Lato:wght@400;700&family=Open\+Sans:wght@400;600;700&display=swap/);
    assert.doesNotMatch(standardBody, /font-preview--lato-headings/);
    assert.doesNotMatch(previewBody, /font-preview--lato-headings/);
    assert.equal(previewBody, standardBody);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("customer register validation errors still render without fontPreview in the view model", async () => {
  const server = createTestServer(adminSession);
  try {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/customers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        givenName: "",
        surname: "",
        email: "bad",
        phone: "123",
        preferredContact: "Unknown"
      })
    });
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /Please correct the following errors:/);
    assert.match(body, /First name is required\./);
    assert.match(body, /Surname is required\./);
    assert.match(body, /Email address is not valid\./);
    assert.match(body, /Phone number is not valid\./);
    assert.match(body, /House name \/ number is required\./);
    assert.match(body, /Address line 1 is required\./);
    assert.match(body, /City \/ Town is required\./);
    assert.match(body, /Postcode is required\./);
    assert.match(body, /id="houseNameNumber"[^>]*required/);
    assert.match(body, /id="addressLine1"[^>]*required/);
    assert.match(body, /id="cityTown"[^>]*required/);
    assert.match(body, /id="postcode"[^>]*required/);
    assert.match(body, /family=Lato:wght@400;700&family=Open\+Sans:wght@400;600;700&display=swap/);
    assert.doesNotMatch(body, /font-preview--lato-headings/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
