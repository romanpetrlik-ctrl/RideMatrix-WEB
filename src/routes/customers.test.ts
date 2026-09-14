import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import path from "node:path";
import type { SessionAccount } from "../services/api";
import type { CustomerRecord } from "../services/customers";
import { createCustomersRouter } from "./customers";

function createTestCustomer(): CustomerRecord {
  return {
    id: "cust-test-1",
    title: null,
    givenName: "Ada",
    surname: "Lovelace",
    email: "ada@example.com",
    phone: "+447700900123",
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    lastLoginAt: null,
    lastBookingAt: null,
    inactiveAt: null,
    anonymizedAt: null,
    erasureRequestedAt: null,
    retentionHoldUntil: null,
    retentionHoldReason: null,
    purgeAfter: null,
    status: "Active",
    notes: null,
    address: "10 Downing Street, London SW1A 2AA",
    houseNameNumber: null,
    addressLine1: null,
    addressLine2: null,
    addressLine3: null,
    cityTown: null,
    county: null,
    state: null,
    postcode: null,
    company: null,
    preferredContact: "Unknown",
    source: "manual",
    latitude: 51.5034,
    longitude: -0.1276,
    geocodedAt: "2026-09-14T00:00:00.000Z",
    geocodeStatus: "exact",
    bookings: []
  };
}

function createTestServer(
  session: SessionAccount,
  routerOptions: Partial<Parameters<typeof createCustomersRouter>[0]> = {}
) {
  const app = express();
  app.set("views", path.join(process.cwd(), "src/views"));
  app.set("view engine", "ejs");
  app.use(express.urlencoded({ extended: false }));
  app.use(createCustomersRouter({
    appTitle: "RideMatrix Test",
    loadSession: async () => session,
    ...routerOptions
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

test("customer register exposes structured address inputs and only the browser maps key", async () => {
  const previousEnv = {
    GOOGLE_MAPS_ENABLED: process.env.GOOGLE_MAPS_ENABLED,
    GOOGLE_MAPS_SERVER_API_KEY: process.env.GOOGLE_MAPS_SERVER_API_KEY,
    GOOGLE_MAPS_BROWSER_API_KEY: process.env.GOOGLE_MAPS_BROWSER_API_KEY
  };
  process.env.GOOGLE_MAPS_ENABLED = "true";
  process.env.GOOGLE_MAPS_SERVER_API_KEY = "server-key";
  process.env.GOOGLE_MAPS_BROWSER_API_KEY = "browser-key";

  const server = createTestServer(adminSession);
  try {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/customers/register?type=private`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /id="addressSearch"/);
    assert.match(body, /id="houseNameNumber"[^>]*required/);
    assert.match(body, /id="addressLine1"[^>]*required/);
    assert.match(body, /id="addressLine2"/);
    assert.match(body, /id="addressLine3"/);
    assert.match(body, /id="cityTown"[^>]*required/);
    assert.match(body, /id="postcode"[^>]*required/);
    assert.match(body, /data-address-autocomplete-browser-key="browser-key"/);
    assert.doesNotMatch(body, /server-key/);
  } finally {
    process.env.GOOGLE_MAPS_ENABLED = previousEnv.GOOGLE_MAPS_ENABLED;
    process.env.GOOGLE_MAPS_SERVER_API_KEY = previousEnv.GOOGLE_MAPS_SERVER_API_KEY;
    process.env.GOOGLE_MAPS_BROWSER_API_KEY = previousEnv.GOOGLE_MAPS_BROWSER_API_KEY;
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

test("customer edit exposes structured address inputs and only the browser maps key", async () => {
  const previousEnv = {
    GOOGLE_MAPS_ENABLED: process.env.GOOGLE_MAPS_ENABLED,
    GOOGLE_MAPS_SERVER_API_KEY: process.env.GOOGLE_MAPS_SERVER_API_KEY,
    GOOGLE_MAPS_BROWSER_API_KEY: process.env.GOOGLE_MAPS_BROWSER_API_KEY
  };
  process.env.GOOGLE_MAPS_ENABLED = "true";
  process.env.GOOGLE_MAPS_SERVER_API_KEY = "server-key";
  process.env.GOOGLE_MAPS_BROWSER_API_KEY = "browser-key";

  const server = createTestServer(adminSession, {
    getCustomerById: async () => createTestCustomer(),
    listRecentBookingsForCustomer: async () => []
  });
  try {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/customers/cust-test-1/edit`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /id="addressSearch"/);
    assert.match(body, /id="houseNameNumber"/);
    assert.match(body, /id="addressLine1"/);
    assert.match(body, /id="cityTown"/);
    assert.match(body, /id="postcode"/);
    assert.match(body, /data-address-autocomplete-browser-key="browser-key"/);
    assert.match(body, /customer-address-autocomplete\.js/);
    assert.doesNotMatch(body, /server-key/);
  } finally {
    process.env.GOOGLE_MAPS_ENABLED = previousEnv.GOOGLE_MAPS_ENABLED;
    process.env.GOOGLE_MAPS_SERVER_API_KEY = previousEnv.GOOGLE_MAPS_SERVER_API_KEY;
    process.env.GOOGLE_MAPS_BROWSER_API_KEY = previousEnv.GOOGLE_MAPS_BROWSER_API_KEY;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("customers list keeps View unchanged and sends Edit to the real edit route with preserved returnTo state", async () => {
  const server = createTestServer(adminSession, {
    listCustomers: async () => ({
      customers: [createTestCustomer()],
      totalRecords: 1,
      totalPages: 3,
      page: 2,
      perPage: 25
    }),
    getCustomerCount: async () => 1
  });

  try {
    const address = server.address() as { port: number };
    const response = await fetch(
      `http://127.0.0.1:${address.port}/customers?q=ada&status=Active&page=2&perPage=25`
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(
      body,
      /href="\/customers\/cust-test-1\?returnTo=%2Fcustomers%3Fq%3Dada%26status%3DActive%26page%3D2%26perPage%3D25&amp;layout=child"/
    );
    assert.match(
      body,
      /href="\/customers\/cust-test-1\/edit\?returnTo=%2Fcustomers%3Fq%3Dada%26status%3DActive%26page%3D2%26perPage%3D25"/
    );
    assert.doesNotMatch(body, /notice=edit-customer/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("customer detail keeps New Booking unchanged and points Edit Customer to the real edit route", async () => {
  const server = createTestServer(adminSession, {
    getCustomerById: async () => createTestCustomer(),
    listRecentBookingsForCustomer: async () => []
  });

  try {
    const address = server.address() as { port: number };
    const response = await fetch(
      `http://127.0.0.1:${address.port}/customers/cust-test-1?returnTo=${encodeURIComponent("/customers?q=ada&status=Active&page=2&perPage=25")}&layout=child`
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(
      body,
      /href="\/customers\/cust-test-1\?returnTo=%2Fcustomers%3Fq%3Dada%26status%3DActive%26page%3D2%26perPage%3D25&amp;notice=new-booking&amp;layout=child">New Booking<\/a>/
    );
    assert.match(
      body,
      /href="\/customers\/cust-test-1\/edit\?returnTo=%2Fcustomers%3Fq%3Dada%26status%3DActive%26page%3D2%26perPage%3D25&amp;layout=child">Edit Customer<\/a>/
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("customer edit page no longer shows the obsolete edit placeholder notice", async () => {
  const server = createTestServer(adminSession, {
    getCustomerById: async () => createTestCustomer(),
    listRecentBookingsForCustomer: async () => []
  });

  try {
    const address = server.address() as { port: number };
    const response = await fetch(
      `http://127.0.0.1:${address.port}/customers/cust-test-1/edit?returnTo=${encodeURIComponent("/customers?q=ada&status=Active&page=2&perPage=25")}`
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /id="edit-customer-form"/);
    assert.doesNotMatch(body, /edit workflow is still a placeholder/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("legacy detail notice redirects to the real customer edit route", async () => {
  const server = createTestServer(adminSession, {
    getCustomerById: async () => createTestCustomer(),
    listRecentBookingsForCustomer: async () => []
  });

  try {
    const address = server.address() as { port: number };
    const response = await fetch(
      `http://127.0.0.1:${address.port}/customers/cust-test-1?notice=edit-customer&returnTo=${encodeURIComponent("/customers?q=ada&status=Active&page=2&perPage=25")}&layout=child`,
      { redirect: "manual" }
    );

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "/customers/cust-test-1/edit?returnTo=%2Fcustomers%3Fq%3Dada%26status%3DActive%26page%3D2%26perPage%3D25&layout=child"
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
