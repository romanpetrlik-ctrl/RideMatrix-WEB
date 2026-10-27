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

function countMatches(source: string, expression: RegExp): number {
  return source.match(expression)?.length ?? 0;
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

const mapEnvironmentKeys = [
  "GOOGLE_MAPS_ENABLED",
  "GOOGLE_MAPS_SERVER_API_KEY",
  "GOOGLE_MAPS_BROWSER_API_KEY",
  "GOOGLE_MAPS_MAP_ID",
  "GOOGLE_MAPS_DEFAULT_LATITUDE",
  "GOOGLE_MAPS_DEFAULT_LONGITUDE",
  "NEXT_PUBLIC_GOOGLE_MAPS_ENABLED",
  "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY",
  "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
  "NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID",
  "NEXT_PUBLIC_GOOGLE_MAPS_DEFAULT_LATITUDE",
  "NEXT_PUBLIC_GOOGLE_MAPS_DEFAULT_LONGITUDE"
];

async function withMapEnvironment<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const previous = Object.fromEntries(mapEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of mapEnvironmentKeys) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const key of mapEnvironmentKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const validCustomerForm = new URLSearchParams({
  givenName: "Ada",
  surname: "Lovelace",
  phone: "+447777888999",
  houseNameNumber: "10",
  addressLine1: "Downing Street",
  cityTown: "London",
  postcode: "SW1A 2AA",
  preferredContact: "Unknown"
});

const validBusinessForm = new URLSearchParams({
  customerType: "business",
  registeredName: "Example Ltd",
  officeEmail: "office@example.com",
  officePhone: "020 7946 0018",
  registeredHouseNameNumber: "10",
  registeredAddressLine1: "Downing Street",
  registeredCityTown: "London",
  registeredPostcode: "SW1A 2AA",
  registeredCountry: "United Kingdom",
  registeredAddressLine2: "Westminster",
  registeredAddressLine3: "Office floor",
  registeredCounty: "Greater London",
  registeredState: "England",
  registeredLatitude: "51.5",
  registeredLongitude: "-0.12",
  operationalHouseNameNumber: "Unit 2",
  operationalAddressLine1: "Depot Road",
  operationalAddressLine2: "Industrial Park",
  operationalAddressLine3: "East Gate",
  operationalCityTown: "Poole",
  operationalPostcode: "BH15 1AA",
  operationalCounty: "Dorset",
  operationalState: "England",
  operationalCountry: "United Kingdom",
  operationalLatitude: "50.7",
  operationalLongitude: "0",
  bookerFullName: "Booking Manager",
  bookerEmail: "booker@example.com",
  bookerPhone: "07777 888999",
  bookingAuthRequired: "yes",
  bookingAuthChannel: "both",
  accountsFullName: "Accounts Manager",
  accountsEmail: "accounts@example.com",
  accountsPhone: "+442079460019"
});

test("business registration replaces the placeholder with two independent address and phone components", async () => {
  const server = createTestServer(adminSession);
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/customers/register?type=business`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(html, /Coming later/);
    assert.match(html, /formId|form="business-customer-form"/);
    assert.equal(countMatches(html, /data-address-prefix=/g), 2);
    assert.equal(countMatches(html, /class="address-map-preview"/g), 2);
    for (const name of validBusinessForm.keys()) {
      if (name === "customerType") continue;
      assert.match(html, new RegExp(`id="${name}"\\s+name="${name}"`), name);
      assert.match(html, new RegExp(`<label for="${name}">`), name);
    }
    for (const heading of ["registered-company-heading", "registered-address-heading", "operational-address-heading", "booker-heading", "accounts-heading"]) {
      assert.match(html, new RegExp(`class="private-customer-form__column[^"]*" aria-labelledby="${heading}"`));
    }
    assert.match(html, /private-customer-form__grid business-customer-form__grid/);
    assert.equal(countMatches(html, /data-phone-number>/g), 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("business create validates, normalizes and redirects to the saved customer", async () => {
  let saved: any;
  const server = createTestServer(adminSession, {
    createBusinessCustomer: async (input) => { saved = input; return createTestCustomer(); }
  });
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/customers/register`, {
      method: "POST", body: validBusinessForm, redirect: "manual"
    });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location") || "", /\/customers\/cust-test-1/);
    assert.equal(saved.registeredName, "Example Ltd");
    assert.equal(saved.officePhone, "+442079460018");
    assert.equal(saved.bookingAuthRequired, true);
    assert.equal(saved.bookingAuthChannel, "both");
    assert.equal(saved.registeredAddress.country, "United Kingdom");
    for (const [prefix, address] of [["registered", saved.registeredAddress], ["operational", saved.operationalAddress]] as const) {
      for (const field of ["houseNameNumber", "addressLine1", "addressLine2", "addressLine3", "cityTown", "postcode", "county", "state", "country", "latitude", "longitude"]) {
        const key = prefix + field[0].toUpperCase() + field.slice(1);
        const expected = validBusinessForm.get(key);
        assert.equal(address[field], field === "latitude" || field === "longitude" ? Number(expected) : expected, key);
      }
    }
    assert.equal(saved.accountsPhone, "+442079460019");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("business validation errors preserve the form and never call persistence", async () => {
  let calls = 0;
  const server = createTestServer(adminSession, {
    createBusinessCustomer: async () => { calls++; return createTestCustomer(); }
  });
  try {
    const { port } = server.address() as { port: number };
    const invalid = new URLSearchParams(validBusinessForm);
    invalid.set("officeEmail", "invalid");
    invalid.set("bookingAuthChannel", "");
    invalid.set("accountsFullName", "");
    for (const prefix of ["registered", "operational"]) {
      invalid.set(prefix + "AddressSearch", prefix + " search address");
      invalid.set(prefix + "Address", prefix + " formatted address");
    }
    const response = await fetch(`http://127.0.0.1:${port}/customers/register`, {
      method: "POST", body: invalid
    });
    const html = await response.text();
    assert.equal(response.status, 400);
    for (const [name, value] of invalid) {
      if (name === "customerType" || name === "bookingAuthRequired" || name === "bookingAuthChannel") continue;
      const expected = name === "officePhone" ? "+442079460018" : name === "bookerPhone" ? "+447777888999" : value;
      assert.match(html, new RegExp(`id="${name}"\\s+name="${name}"\\s+value="${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), name);
    }
    assert.match(html, /<option value="yes" selected>Yes<\/option>/);
    for (const prefix of ["registered", "operational"]) {
      assert.match(html, new RegExp(`id="${prefix}AddressSearchManual" value="${prefix} search address"`));
    }
    assert.match(html, /Please correct the following errors/);
    assert.match(html, /id="business-customer-form"/);
    assert.equal(calls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("business registration requires the existing administrator role", async () => {
  let calls = 0;
  const server = createTestServer({
    authenticated: true,
    user: { ...adminSession.user!, roles: ["driver"], active_role: "driver" }
  }, { createBusinessCustomer: async () => { calls++; return createTestCustomer(); } });
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/customers/register`, {
      method: "POST", body: validBusinessForm, redirect: "manual"
    });

    assert.equal(response.status, 403);
    assert.equal(calls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("business customers cannot enter or submit the private editor", async () => {
  const server = createTestServer(adminSession, {
    getCustomerById: async () => ({ ...createTestCustomer(), source: "business", surname: "", company: "Example Ltd" })
  });
  try {
    const { port } = server.address() as { port: number };
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`http://127.0.0.1:${port}/customers/cust-test-1/edit`, {
        method, redirect: "manual", ...(method === "POST" ? { body: validCustomerForm } : {})
      });
      assert.equal(response.status, 302);
      assert.match(response.headers.get("location") || "", /notice=business-read-only/);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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
  for (const [value, expected] of [
    ["07468 329114", "+447468329114"],
    ["+447468329114", "+447468329114"],
    ["+44 7468 329 114", "+447468329114"]
  ]) {
    const response = await requestPreview(adminSession, value);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.valid, true, `${value} should be valid`);
    assert.equal(body.normalized, expected);
    assert.equal(body.country.isoCode, "GB");
  }
});

test("phone preview rejects invalid numbers", async () => {
  for (const value of ["123", "07468"]) {
    const response = await requestPreview(adminSession, value);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.valid, false, `${value} should be invalid`);
  }
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
    assert.match(body, /id="addressSearchAutocomplete" class="private-customer-form__autocomplete-host" data-address-autocomplete-host hidden/);
    assert.match(body, /id="addressSearchManual"/);
    assert.match(body, /<input[^>]*type="hidden"[^>]*id="addressSearch"[^>]*name="addressSearch"/);
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

test("customer registration succeeds when maps are disabled", async () => {
  await withMapEnvironment({}, async () => {
    let created = false;
    const server = createTestServer(adminSession, {
      createCustomer: async () => {
        created = true;
        return createTestCustomer();
      }
    });
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/customers/register`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: validCustomerForm
      });

      assert.equal(response.status, 302);
      assert.match(response.headers.get("location") || "", /^\/customers\/cust-test-1\?/);
      assert.equal(created, true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

test("customer registration succeeds when maps are enabled and renders a configured preview", async () => {
  await withMapEnvironment({
    GOOGLE_MAPS_ENABLED: "true",
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "browser-key",
    GOOGLE_MAPS_DEFAULT_LATITUDE: "51.5034",
    GOOGLE_MAPS_DEFAULT_LONGITUDE: "-0.1276"
  }, async () => {
    let created = false;
    const server = createTestServer(adminSession, {
      createCustomer: async () => {
        created = true;
        return createTestCustomer();
      }
    });
    try {
      const address = server.address() as { port: number };
      const getResponse = await fetch(`http://127.0.0.1:${address.port}/customers/register?type=private`);
      const page = await getResponse.text();
      const postResponse = await fetch(`http://127.0.0.1:${address.port}/customers/register`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: validCustomerForm
      });

      assert.equal(getResponse.status, 200);
      assert.match(page, /class="address-map-preview"/);
      assert.match(page, /data-map-browser-key="browser-key"/);
      assert.match(page, /data-map-latitude="51\.5034"/);
      assert.equal(postResponse.status, 302);
      assert.equal(created, true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

test("customer registration renders the empty map fallback when map configuration is missing", async () => {
  await withMapEnvironment({}, async () => {
    const server = createTestServer(adminSession);
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/customers/register?type=private`);
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(body, /Map integration is not configured\./);
      assert.doesNotMatch(body, /class="address-map-preview"/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
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
    assert.match(body, /id="addressSearchAutocomplete" class="private-customer-form__autocomplete-host" data-address-autocomplete-host hidden/);
    assert.match(body, /id="addressSearchManual"/);
    assert.match(body, /<input[^>]*type="hidden"[^>]*id="addressSearch"[^>]*name="addressSearch"/);
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

test("customer pages render customer dynamic controls without legacy breadcrumb rows", async () => {
  const server = createTestServer(adminSession, {
    getCustomerById: async () => createTestCustomer(),
    listRecentBookingsForCustomer: async () => [],
    listCustomers: async () => ({
      customers: [createTestCustomer()],
      totalRecords: 1,
      totalPages: 1,
      page: 1,
      perPage: 25
    }),
    getCustomerCount: async () => 1
  });

  try {
    const address = server.address() as { port: number };
    const [listBody, detailBody, detailChildBody, editBody, editChildBody, registerBody] = await Promise.all([
      fetch(`http://127.0.0.1:${address.port}/customers`).then((response) => response.text()),
      fetch(`http://127.0.0.1:${address.port}/customers/cust-test-1?returnTo=${encodeURIComponent("/customers")}`).then((response) => response.text()),
      fetch(`http://127.0.0.1:${address.port}/customers/cust-test-1?returnTo=${encodeURIComponent("/customers")}&layout=child`).then((response) => response.text()),
      fetch(`http://127.0.0.1:${address.port}/customers/cust-test-1/edit?returnTo=${encodeURIComponent("/customers")}`).then((response) => response.text()),
      fetch(`http://127.0.0.1:${address.port}/customers/cust-test-1/edit?returnTo=${encodeURIComponent("/customers")}&layout=child`).then((response) => response.text()),
      fetch(`http://127.0.0.1:${address.port}/customers/register?type=private`).then((response) => response.text())
    ]);

    for (const body of [listBody, detailBody, detailChildBody, editBody, editChildBody, registerBody]) {
      assert.equal(countMatches(body, /aria-label="Breadcrumbs"/g), 0);
    }

    assert.match(listBody, /class="context-tab context-tab--dynamic(?: context-tab--active)?" href="[^"]+"(?: aria-current="page")?/);
    assert.equal(countMatches(listBody, /class="context-tab context-tab--dynamic(?: context-tab--active)?"/g), 3);
    for (const body of [detailBody, detailChildBody, editBody, editChildBody, registerBody]) {
      assert.equal(countMatches(body, /class="context-tab context-tab--dynamic(?: context-tab--active)?"/g), 0);
    }
    assert.match(listBody, /class="context-control--dynamic"/);
    assert.match(listBody, /button button--dynamic-cta" href="\/customers\/register">New customer/);
    assert.match(detailBody, /button button--dynamic-cta" href="\/customers\/cust-test-1\/edit\?returnTo=%2Fcustomers">Edit Customer/);
    assert.match(editBody, /button button--dynamic-cta button--execute site-header__action context-bar__action context-bar__action--execute"/);
    for (const body of [listBody, detailBody, detailChildBody, editBody, editChildBody, registerBody]) {
      assert.doesNotMatch(body, /button--admin-cta--dynamic|button--admin-cta--system/);
    }
    assert.doesNotMatch(detailChildBody, /class="system-status-bar"/);
    assert.doesNotMatch(editChildBody, /class="system-status-bar"/);
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
