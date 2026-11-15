import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, TestDatabaseContext } from "../database/test-helper";
import { createCsrfProtection } from "../middleware/csrf";
import { errorHandler } from "../middleware/error-handler";
import { SessionAccount } from "../services/api";
import { getSetupOverview } from "../services/system-setup";
import { createSetupRouter } from "./setup";

const actor = {
  userId: "11111111-1111-1111-1111-111111111111",
  email: "installer@example.com",
  roles: ["admin"]
};
const testRoles = [
  "admin",
  "superuser",
  "driver",
  "staff",
  "customer",
  "corporate",
  "partner",
  "tour_operator",
  "affiliate",
  "tech_support"
];
const validAddress = {
  formattedAddress: "10 Downing Street, London SW1A 2AA, UK",
  houseNameNumber: "10",
  addressLine1: "Downing Street",
  addressLine2: "",
  addressLine3: "Greater London",
  cityTown: "London",
  county: "Greater London",
  state: "England",
  postcode: "SW1A 2AA",
  countryCode: "GB",
  countryName: "United Kingdom"
};
const selectedOperationalAddress = {
  ...validAddress,
  latitude: "51.5034",
  longitude: "-0.1276",
  providerName: "google",
  providerPlaceId: "ChIJsetup-place"
};

let db: TestDatabaseContext;
let server: http.Server;
let baseUrl: string;
let session: SessionAccount;
let previousAllowlist: string | undefined;
let previousBrowserKey: string | undefined;

before(async () => {
  previousAllowlist = process.env.INITIAL_SETUP_ALLOWED_EMAILS;
  previousBrowserKey = process.env.GOOGLE_MAPS_BROWSER_API_KEY;
  process.env.INITIAL_SETUP_ALLOWED_EMAILS = actor.email;
  process.env.GOOGLE_MAPS_BROWSER_API_KEY = "test-browser-key";
  db = await createTestDatabaseContext("test_setup_journey");
  await db.createAuthTables();
  await initializeDatabase();

  const app = express();
  app.set("view engine", "ejs");
  app.set("views", `${process.cwd()}/src/views`);
  app.use(express.urlencoded({ extended: true }));
  app.use(rateLimit({ windowMs: 60_000, limit: 1000 }));
  app.use(createCsrfProtection({ cookieSecure: false }));
  app.use(createSetupRouter({ appTitle: "RideMatrix Test", loadSession: async () => session }));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await query(`TRUNCATE staff_profiles, system_setup_bootstrap, system_setup_state, system_setup_steps,
    system_setup_audit_events, system_test_accounts, operators, user_roles, roles, users CASCADE`);
  await query(
    `INSERT INTO roles (id, key) SELECT row_number() OVER (), role_key
       FROM unnest($1::text[]) AS role_key`,
    [testRoles]
  );
  await query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'Active')`, [actor.userId, actor.email]);
  session = { authenticated: true, user: { id: actor.userId, email: actor.email, roles: actor.roles } };
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await safeCleanupTestDatabase(db);
  if (previousAllowlist === undefined) delete process.env.INITIAL_SETUP_ALLOWED_EMAILS;
  else process.env.INITIAL_SETUP_ALLOWED_EMAILS = previousAllowlist;
  if (previousBrowserKey === undefined) delete process.env.GOOGLE_MAPS_BROWSER_API_KEY;
  else process.env.GOOGLE_MAPS_BROWSER_API_KEY = previousBrowserKey;
});

async function csrfFor(path: string): Promise<{ cookie: string; token: string }> {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const token = (await response.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(token);
  return { cookie, token };
}

async function postForm(path: string, values: Record<string, string>): Promise<Response> {
  const { cookie, token } = await csrfFor(path);
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...values, _csrf: token }),
    redirect: "manual"
  });
}

async function postDocument(content: Buffer, mimeType = "application/pdf", filename = "pho-licence.pdf"): Promise<Response> {
  const { cookie, token } = await csrfFor("/setup/licence-document");
  const body = new FormData();
  body.set("_csrf", token);
  body.set("licenceDocument", new Blob([Uint8Array.from(content).buffer as ArrayBuffer], { type: mimeType }), filename);
  return fetch(`${baseUrl}/setup/licence-document`, {
    method: "POST",
    headers: { cookie, origin: baseUrl },
    body,
    redirect: "manual"
  });
}

test("operator can complete every setup step, with validation, persistence, authorization and completed lock", async () => {
  let response = await fetch(`${baseUrl}/setup`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/bootstrap-superuser");
  const bootstrap = await (await fetch(`${baseUrl}/setup/bootstrap-superuser`)).text();
  assert.match(bootstrap, /Confirm your administrator account/);
  assert.match(bootstrap, /name="_csrf"/);

  response = await postForm("/setup/bootstrap-superuser", {
    installerEmail: actor.email,
    name: "  Alex ",
    surname: " Operator  "
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/operator-profile");

  session = {
    authenticated: true,
    user: { id: "22222222-2222-2222-2222-222222222222", email: "other@example.com", roles: ["admin"] }
  };
  assert.equal((await fetch(`${baseUrl}/setup/operator-profile`)).status, 403);
  session = { authenticated: true, user: { id: actor.userId, email: actor.email, roles: actor.roles } };

  response = await postForm("/setup/operator-profile", {
    legalName: "Unfinished Company Ltd",
    tradingName: "RideMatrix",
    licenceHolderName: ""
  });
  assert.equal(response.status, 200);
  let html = await response.text();
  assert.match(html, /Licence holder name is required/);
  assert.match(html, /value="Unfinished Company Ltd"/);

  response = await postForm("/setup/operator-profile", {
    legalName: " RideMatrix Operators Ltd ",
    tradingName: "RideMatrix",
    licenceHolderName: "Alex Operator"
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/registered-pho-address");
  html = await (await fetch(`${baseUrl}/setup/operator-profile`)).text();
  assert.match(html, /value="RideMatrix Operators Ltd"/);
  response = await postForm("/setup/operator-profile", {
    legalName: "RideMatrix Operators Ltd",
    tradingName: "RideMatrix",
    licenceHolderName: "Alex Operator"
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/registered-pho-address");

  const registeredForm = await (await fetch(`${baseUrl}/setup/registered-pho-address`)).text();
  assert.match(registeredForm, /name="formattedAddress"/);
  assert.match(registeredForm, /Save registered address and continue/);
  response = await postForm("/setup/registered-pho-address", {
    ...validAddress,
    formattedAddress: "",
    latitude: "",
    longitude: "",
    providerName: "",
    providerPlaceId: ""
  });
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /Formatted address is required/);
  assert.match(html, /Save registered address and continue/);
  assert.match(html, /value="Downing Street"/);

  response = await postForm("/setup/registered-pho-address", validAddress);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/operational-address");
  html = await (await fetch(`${baseUrl}/setup/registered-pho-address`)).text();
  assert.match(html, /value="10 Downing Street, London SW1A 2AA, UK"/);

  const operationalForm = await (await fetch(`${baseUrl}/setup/operational-address`)).text();
  assert.match(operationalForm, /Select your operating address from Google Places/);
  assert.match(operationalForm, /setup-address-autocomplete\.js/);
  assert.match(operationalForm, /data-address-autocomplete-browser-key="test-browser-key"/);
  assert.match(operationalForm, /type="hidden" id="latitude" name="latitude"/);
  response = await postForm("/setup/operational-address", {
    ...selectedOperationalAddress,
    providerPlaceId: "",
    latitude: "51.5034",
    longitude: "-0.1276"
  });
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /Select the operational address from Google Places/);
  assert.match(html, /value="10 Downing Street, London SW1A 2AA, UK"/);
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM operator_addresses WHERE address_type = 'operational'`)).rows[0].count, 0);

  response = await postForm("/setup/operational-address", selectedOperationalAddress);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/pho-licence");
  let overview = await getSetupOverview();
  assert.equal(overview.addressDetails.operational?.providerPlaceId, "ChIJsetup-place");
  assert.equal(Number(overview.addressDetails.operational?.latitude), 51.5034);
  assert.equal(Number(overview.addressDetails.operational?.longitude), -0.1276);
  html = await (await fetch(`${baseUrl}/setup/operational-address`)).text();
  assert.match(html, /id="providerPlaceId" name="providerPlaceId" value="ChIJsetup-place"/);
  assert.match(html, /id="latitude" name="latitude" value="51\.5034"/);

  const authorities = await query<{ id: string; name: string }>(
    `SELECT id, name FROM licensing_authorities WHERE active = TRUE ORDER BY preference_order, lower(name), id LIMIT 1`
  );
  assert.ok(authorities.rows[0]);
  const licenceForm = await (await fetch(`${baseUrl}/setup/pho-licence`)).text();
  assert.match(licenceForm, /name="licensingAuthorityId"/);
  assert.ok(licenceForm.includes(`value="${authorities.rows[0].id}"`));
  response = await postForm("/setup/pho-licence", {
    licenceNumber: "PHO-12345",
    licensingAuthorityId: authorities.rows[0].id,
    validFrom: "2026-02-31",
    validTo: ""
  });
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /Enter a valid date/);
  assert.match(html, /value="PHO-12345"/);
  response = await postForm("/setup/pho-licence", {
    licenceNumber: "PHO-12345",
    licensingAuthorityId: "unknown-authority",
    validFrom: "2026-01-01",
    validTo: "2026-12-31"
  });
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /Selected licensing authority is not available/);
  assert.match(html, /value="PHO-12345"/);
  assert.match(html, /value="unknown-authority" selected disabled/);

  response = await postForm("/setup/pho-licence", {
    licenceNumber: "PHO-12345",
    licensingAuthorityId: authorities.rows[0].id,
    validFrom: "2026-01-01",
    validTo: "2026-12-31"
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/licence-document");
  html = await (await fetch(`${baseUrl}/setup/pho-licence`)).text();
  assert.match(html, /value="PHO-12345"/);
  assert.match(html, /value="2026-01-01"/);

  const documentCsrf = await csrfFor("/setup/licence-document");
  response = await fetch(`${baseUrl}/setup/review`, {
    method: "POST",
    headers: {
      cookie: documentCsrf.cookie,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ confirmSetup: "yes", _csrf: documentCsrf.token }),
    redirect: "manual"
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/licence-document");
  assert.equal((await getSetupOverview()).setupCompleted, false);

  const missingCsrf = await csrfFor("/setup/licence-document");
  const csrflessDocument = new FormData();
  csrflessDocument.set("licenceDocument", new Blob([Buffer.from("%PDF-1.7 no csrf")], { type: "application/pdf" }), "no-csrf.pdf");
  response = await fetch(`${baseUrl}/setup/licence-document`, {
    method: "POST",
    headers: { cookie: missingCsrf.cookie, origin: baseUrl },
    body: csrflessDocument,
    redirect: "manual"
  });
  assert.equal(response.status, 403);
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM operator_licence_documents`)).rows[0].count, 0);

  const invalidMimeResponse = await postDocument(Buffer.from("not a PDF"), "text/plain", "licence.txt");
  assert.equal(invalidMimeResponse.status, 200);
  assert.match(await invalidMimeResponse.text(), /Only PDF, PNG, or JPEG/);
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM operator_licence_documents`)).rows[0].count, 0);
  const invalidContentResponse = await postDocument(Buffer.from("not a PDF"), "application/pdf");
  assert.equal(invalidContentResponse.status, 200);
  assert.match(await invalidContentResponse.text(), /does not match a supported licence document format/);
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM operator_licence_documents`)).rows[0].count, 0);

  const oversizedResponse = await postDocument(Buffer.alloc(10 * 1024 * 1024 + 1, 0x41));
  assert.equal(oversizedResponse.status, 200);
  assert.match(await oversizedResponse.text(), /10 MB or smaller/);
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM operator_licence_documents`)).rows[0].count, 0);

  const uploadResponse = await postDocument(Buffer.from("%PDF-1.7\nsetup licence document"));
  assert.equal(uploadResponse.status, 302);
  assert.equal(uploadResponse.headers.get("location"), "/setup/review");
  const document = await query<{ original_filename: string; mime_type: string; content: Buffer }>(
    `SELECT original_filename, mime_type, content FROM operator_licence_documents WHERE is_latest = TRUE`
  );
  assert.equal(document.rows[0]?.original_filename, "pho-licence.pdf");
  assert.equal(document.rows[0]?.mime_type, "application/pdf");
  assert.equal(document.rows[0]?.content.toString(), "%PDF-1.7\nsetup licence document");

  const review = await (await fetch(`${baseUrl}/setup/review`)).text();
  assert.match(review, /Review your setup details/);
  assert.match(review, /PHO-12345/);
  response = await postForm("/setup/review", {});
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Confirm setup completion before continuing/);
  assert.equal((await getSetupOverview()).setupCompleted, false);

  response = await postForm("/setup/review", { confirmSetup: "yes" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/completed");
  overview = await getSetupOverview();
  assert.equal(overview.setupCompleted, true);
  assert.equal(overview.currentStep, "completed");
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM system_setup_audit_events WHERE event_name = 'initial_setup_completed'`)).rows[0].count, 1);

  const completed = await (await fetch(`${baseUrl}/setup/completed`)).text();
  assert.match(completed, /Your RideMatrix setup is complete/);
  assert.equal((await fetch(`${baseUrl}/setup`, { redirect: "manual" })).headers.get("location"), "/setup/completed");
  assert.equal((await fetch(`${baseUrl}/setup/operator-profile`, { redirect: "manual" })).headers.get("location"), "/setup/completed");
  const completedCsrf = await csrfFor("/setup/completed");
  response = await fetch(`${baseUrl}/setup/operator-profile`, {
    method: "POST",
    headers: {
      cookie: completedCsrf.cookie,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      legalName: "Changed after completion",
      tradingName: "",
      licenceHolderName: "Changed",
      _csrf: completedCsrf.token
    }),
    redirect: "manual"
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/setup/completed");
  assert.equal((await getSetupOverview()).operator?.legalName, "RideMatrix Operators Ltd");
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM system_setup_audit_events WHERE event_name = 'initial_setup_completed'`)).rows[0].count, 1);
});
