import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext, safeCleanupTestDatabase } from "../database/test-helper";
import { createCsrfProtection } from "../middleware/csrf";
import { CSRF_COOKIE_NAME } from "../services/csrf";
import { SessionAccount } from "../services/api";
import { operationalMenuRows } from "./dashboard";

let createVehiclesRouter: typeof import("./vehicles.js")["createVehiclesRouter"];
let createVehicleDocument: typeof import("../services/vehicles.js")["createVehicleDocument"];
let listVehicles: typeof import("../services/vehicles.js")["listVehicles"];
let vaultRoot: string;
const previousVaultRoot = process.env.DOCUMENT_VAULT_ROOT;

const DRIVER_ID = "a0000000-0000-0000-0000-000000000002";
const SECOND_DRIVER_ID = "a0000000-0000-0000-0000-000000000003";
const ADMIN_USER_ID = "a0000000-0000-0000-0000-000000000001";

describe("vehicle management end-to-end workflow", () => {
  let dbContext: TestDatabaseContext | undefined;
  let appServer: Server;
  let baseUrl: string;
  let session: SessionAccount = { authenticated: false };

  before(async () => {
    vaultRoot = await mkdtemp(path.join(os.tmpdir(), "ridematrix-vehicle-vault-"));
    process.env.DOCUMENT_VAULT_ROOT = vaultRoot;
    ({ createVehiclesRouter } = await import("./vehicles.js"));
    ({ createVehicleDocument, listVehicles } = await import("../services/vehicles.js"));
    dbContext = await createTestDatabaseContext("test_vehicle_routes");
    await dbContext.createAuthTables();
    await initializeDatabase();
    await query(`INSERT INTO users (id, email) VALUES ($1, 'second.driver@ridematrix.com') ON CONFLICT DO NOTHING`, [SECOND_DRIVER_ID]);
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 2), ($2, 2), ($3, 1) ON CONFLICT DO NOTHING`,
      [DRIVER_ID, SECOND_DRIVER_ID, ADMIN_USER_ID]
    );

    const app = express();
    app.set("view engine", "ejs");
    app.set("views", path.join(process.cwd(), "src/views"));
    app.use(rateLimit({ windowMs: 60_000, limit: 1_000, standardHeaders: true, legacyHeaders: false }));
    app.use(express.urlencoded({ extended: true }));
    app.use(createCsrfProtection({ appTitle: "RideMatrix Test" }));
    app.use(createVehiclesRouter({ appTitle: "RideMatrix Test", loadSession: async () => session }));
    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (appServer) await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await safeCleanupTestDatabase(dbContext);
    if (previousVaultRoot === undefined) delete process.env.DOCUMENT_VAULT_ROOT;
    else process.env.DOCUMENT_VAULT_ROOT = previousVaultRoot;
    if (vaultRoot) await rm(vaultRoot, { recursive: true, force: true });
  });

  function signIn(roles: string[]): void {
    session = { authenticated: true, user: { id: ADMIN_USER_ID, email: "admin@ridematrix.com", roles } };
  }

  async function openForm(pathname: string): Promise<{ cookie: string; token: string; body: string }> {
    const response = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
    assert.equal(response.status, 200, `${pathname} should render`);
    const body = await response.text();
    const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`));
    const token = /name="_csrf" value="([^"]+)"/.exec(body)?.[1];
    assert.ok(cookie && token, `${pathname} should issue a CSRF token`);
    return { cookie: cookie.split(";")[0], token, body };
  }

  async function postForm(pathname: string, fields: Array<[string, string]>, cookie: string): Promise<Response> {
    return fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual"
    });
  }

  function vehicleFields(token: string, registration: string, status: string, passengerCapacity = "4"): Array<[string, string]> {
    return [["_csrf", token], ["registration", registration], ["make", "Toyota"], ["model", "Prius"], ["year", "2022"],
      ["fuelType", "HYBRID"], ["passengerCapacity", passengerCapacity], ["status", status], ["classKeys", "standard_sedan_hatchback"],
      ["vehicleLicenseType", "hackney_carriage"], ["vehicleLicenseBadge", "HC-001"],
      ["capacity_xl_suitcase", "1"], ["capacity_cabin_bag", "2"]];
  }

  const documentFieldByType = {
    v5c: "document_v5c",
    council_mechanical_check: "document_council_mechanical_check",
    hire_reward_insurance: "document_hire_reward_insurance",
    hc_phv_license_issued: "document_hc_phv_license_issued",
    mot: "document_mot"
  } as const;

  async function postVehicleMultipart(pathname: string, fields: Array<[string, string]>, cookie: string, includeAllDocuments = true): Promise<Response> {
    const body = new FormData();
    for (const [key, value] of fields) body.append(key, value);
    if (includeAllDocuments) {
      for (const [type, fieldName] of Object.entries(documentFieldByType)) {
        body.append(fieldName, new Blob([Buffer.from("%PDF-1.7 test")], { type: "application/pdf" }), `${type}.pdf`);
      }
    }
    return fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { cookie },
      body,
      redirect: "manual"
    });
  }

  async function createVehicle(registration: string, status: string): Promise<string> {
    const form = await openForm("/vehicles/new");
    const response = await postVehicleMultipart("/vehicles/new", vehicleFields(form.token, registration, status), form.cookie);
    assert.equal(response.status, 302);
    const location = response.headers.get("location") || "";
    const match = /^\/vehicles\/([^/?]+)\?notice=created$/.exec(location);
    assert.ok(match, `unexpected create redirect ${location}`);
    return decodeURIComponent(match[1]);
  }

  test("authorization denials: anonymous users are redirected and non-staff managers are forbidden", async () => {
    session = { authenticated: false };
    for (const pathname of ["/vehicles", "/vehicles?status=active", "/vehicles/new"]) {
      const response = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/access");
    }

    signIn(["driver"]);
    for (const pathname of ["/vehicles", "/vehicles?status=active", "/vehicles/new"]) {
      const response = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
      assert.equal(response.status, 403, `${pathname} should be forbidden for drivers`);
      assert.match(response.headers.get("cache-control") || "", /no-store/);
    }
    const anonymousForm = await fetch(`${baseUrl}/vehicles`, { redirect: "manual" });
    const cookie = (anonymousForm.headers.getSetCookie()[0] || "").split(";")[0];
    const denied = await postForm("/vehicles/new", [["registration", "DENIED1"]], cookie);
    assert.equal(denied.status, 403);
    const count = await query<{ count: number }>("SELECT count(*)::int AS count FROM vehicles WHERE registration = 'DENIED1'");
    assert.equal(count.rows[0].count, 0);
  });

  test("admins can create, list, search, and filter active vehicles", async () => {
    signIn(["admin"]);
    const activeId = await createVehicle("ab12 cde", "active");
    const createdCapacity = await query<{ passenger_capacity: number }>("SELECT passenger_capacity FROM vehicles WHERE id=$1", [activeId]);
    assert.equal(createdCapacity.rows[0].passenger_capacity, 4);
    await createVehicle("MA1 NT", "maintenance");
    await createVehicle("IN4 CTV", "inactive");

    const all = await fetch(`${baseUrl}/vehicles`);
    assert.equal(all.status, 200);
    assert.match(all.headers.get("cache-control") || "", /no-store/);
    const allBody = await all.text();
    assert.match(allBody, /AB12 CDE/);
    assert.match(allBody, /MA1 NT/);
    assert.match(allBody, /IN4 CTV/);

    const active = await fetch(`${baseUrl}/vehicles?status=active`);
    assert.equal(active.status, 200);
    const activeBody = await active.text();
    assert.match(activeBody, /<h1>Active vehicles<\/h1>/);
    assert.match(activeBody, new RegExp(`href="/vehicles/${activeId}"`));
    assert.doesNotMatch(activeBody, /MA1 NT/);
    assert.doesNotMatch(activeBody, /IN4 CTV/);
    assert.match(activeBody, /<option value="active" selected>/);

    const searched = await (await fetch(`${baseUrl}/vehicles?q=ma1`)).text();
    assert.match(searched, /MA1 NT/);
    assert.doesNotMatch(searched, /AB12 CDE/);

    const registrationNoSpacing = await (await fetch(`${baseUrl}/vehicles?status=active&q=ab12cde`)).text();
    assert.match(registrationNoSpacing, /AB12 CDE/);
    assert.doesNotMatch(registrationNoSpacing, /No active vehicles found/);

    const classSearch = await (await fetch(`${baseUrl}/vehicles?status=active&q=standard_sedan`)).text();
    assert.match(classSearch, /AB12 CDE/);
    assert.doesNotMatch(classSearch, /No active vehicles found/);

    const noMatch = await (await fetch(`${baseUrl}/vehicles?status=active&q=ma1`)).text();
    assert.match(noMatch, /No active vehicles found/);

    const ignoredStatus = await (await fetch(`${baseUrl}/vehicles?status=bogus`)).text();
    assert.match(ignoredStatus, /MA1 NT/);
    assert.match(ignoredStatus, /AB12 CDE/);
  });

  test("create and edit show validation errors instead of failing", async () => {
    signIn(["admin"]);
    const form = await openForm("/vehicles/new");
    const duplicate = await postVehicleMultipart("/vehicles/new", vehicleFields(form.token, "AB12 CDE", "active"), form.cookie);
    assert.equal(duplicate.status, 400);
    const duplicateBody = await duplicate.text();
    assert.match(duplicateBody, /already exists/);
    assert.match(duplicateBody, /action="\/vehicles\/new"/);

    const id = (await query<{ id: string }>("SELECT id FROM vehicles WHERE registration = 'AB12 CDE'")).rows[0].id;
    const edit = await openForm(`/vehicles/${id}/edit`);
    assert.match(edit.body, /<option value="2022" selected>2022<\/option>/);
    assert.match(edit.body, /<option value="4" selected>4<\/option>/);
    const missingPassengerCapacity = await postForm(`/vehicles/${id}/edit`, [["_csrf", edit.token], ["registration", "AB12 CDE"], ["make", "Toyota"],
      ["model", "Prius"], ["year", "2021"], ["fuelType", "HYBRID"], ["passengerCapacity", ""], ["status", "active"],
      ["vehicleLicenseType", "hackney_carriage"], ["classKeys", "standard_sedan_hatchback"]], edit.cookie);
    assert.equal(missingPassengerCapacity.status, 400);
    assert.match(await missingPassengerCapacity.text(), /Passenger capacity must be an integer between 1 and 8/);
    const invalid = await postForm(`/vehicles/${id}/edit`, [["_csrf", edit.token], ["registration", ""], ["make", "Toyota"],
      ["model", "Prius"], ["year", "2021"], ["fuelType", "HYBRID"], ["passengerCapacity", "6"], ["status", "active"],
      ["vehicleLicenseType", "hackney_carriage"], ["classKeys", "standard_sedan_hatchback"]], edit.cookie);
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.text();
    assert.match(invalidBody, /Registration, make, and model are required/);
    assert.match(invalidBody, /<option value="2021" selected>2021<\/option>/);
    assert.match(invalidBody, /<option value="6" selected>6<\/option>/);

    const updated = await postForm(`/vehicles/${id}/edit`, vehicleFields(edit.token, "AB12 CDE", "maintenance", "7"), edit.cookie);
    assert.equal(updated.status, 302);
    assert.equal(updated.headers.get("location"), `/vehicles/${id}?notice=updated`);
    const activeBody = await (await fetch(`${baseUrl}/vehicles?status=active`)).text();
    assert.doesNotMatch(activeBody, /AB12 CDE/);
    await postForm(`/vehicles/${id}/edit`, vehicleFields(edit.token, "AB12 CDE", "active", "5"), edit.cookie);
    const persisted = await query<{ vehicle_license_type: string; vehicle_license_badge: string; passenger_capacity: number }>(
      "SELECT vehicle_license_type, vehicle_license_badge, passenger_capacity FROM vehicles WHERE id=$1",
      [id]
    );
    assert.deepEqual(persisted.rows[0], { vehicle_license_type: "hackney_carriage", vehicle_license_badge: "HC-001", passenger_capacity: 5 });

    const missing = await postForm("/vehicles/does-not-exist/edit", vehicleFields(edit.token, "ZZ1", "active"), edit.cookie);
    assert.equal(missing.status, 404);
  });

  test("vehicle create/edit forms separate save and upload actions", async () => {
    signIn(["admin"]);
    const createForm = await openForm("/vehicles/new");
    assert.match(createForm.body, /Save record first\./);
    for (const field of Object.values(documentFieldByType)) assert.doesNotMatch(createForm.body, new RegExp(`name="${field}"`));
    const vehicleId = await createVehicle("DOC RNDR", "active");
    const editForm = await openForm(`/vehicles/${vehicleId}/edit`);
    assert.match(editForm.body, /Upload documents from the vehicle detail page/);
    assert.match(editForm.body, new RegExp(`href="/vehicles/${vehicleId}"`));
  });

  test("save record without docs succeeds", async () => {
    signIn(["admin"]);
    const form = await openForm("/vehicles/new");
    assert.match(form.body, /<form method="post" action="\/vehicles\/new">/);
    assert.match(form.body, /<button class="button button--primary" type="submit">Save record<\/button>/);
    const response = await postForm("/vehicles/new", vehicleFields(form.token, "NODOCS", "active"), form.cookie);
    assert.equal(response.status, 302);
    const location = response.headers.get("location") || "";
    assert.match(location, /^\/vehicles\/[^/?]+\?notice=created$/);
    const createdId = decodeURIComponent(location.split("/")[2]?.split("?")[0] || "");
    const editForm = await openForm(`/vehicles/${createdId}/edit`);
    assert.match(editForm.body, new RegExp(`<form method="post" action="/vehicles/${createdId}/edit">`));
    const docs = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM entity_documents WHERE entity_type='vehicle' AND entity_id=$1",
      [createdId]
    );
    assert.equal(docs.rows[0].count, 0);
  });

  test("upload multiple files in one category succeeds", async () => {
    signIn(["admin"]);
    const vehicleId = await createVehicle("DOC MULTI", "active");
    const detail = await openForm(`/vehicles/${vehicleId}`);
    const body = new FormData();
    body.append("_csrf", detail.token);
    body.append("category", "mec");
    body.append("documents", new Blob([Buffer.from("%PDF-1.7 page one")], { type: "application/pdf" }), "mec-1.pdf");
    body.append("documents", new Blob([Buffer.from("%PDF-1.7 page two")], { type: "application/pdf" }), "mec-2.pdf");
    const upload = await fetch(`${baseUrl}/vehicles/${vehicleId}/record-documents/upload`, {
      method: "POST",
      headers: { cookie: detail.cookie },
      body
    });
    assert.equal(upload.status, 200);
    const docs = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM entity_documents WHERE entity_type='vehicle' AND entity_id=$1 AND category='mec'",
      [vehicleId]
    );
    assert.equal(docs.rows[0].count, 2);
    const audit = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM document_access_events
       WHERE document_id IN (SELECT id FROM entity_documents WHERE entity_type='vehicle' AND entity_id=$1 AND category='mec') AND action='upload'`,
      [vehicleId]
    );
    assert.equal(audit.rows[0].count, 2);
    const directory = await listVehicles({ search: "DOC MULTI" });
    assert.equal(directory.vehicles.find((item) => item.id === vehicleId)?.documentsCount, 2);
    const listed = await fetch(`${baseUrl}/vehicles/${vehicleId}/record-documents?category=mec`);
    assert.equal(listed.status, 200);
    const payload = await listed.json() as { documents: Array<{ original_filename: string }> };
    assert.equal(payload.documents.length, 2);
  });

  test("single staged multi-category upload persists all categories in one submit", async () => {
    signIn(["admin"]);
    const vehicleId = await createVehicle("DOC BATCH", "active");
    const detail = await openForm(`/vehicles/${vehicleId}`);
    const body = new FormData();
    body.append("_csrf", detail.token);
    body.append("documentsByCategory[mec]", new Blob([Buffer.from("%PDF-1.7 mec one")], { type: "application/pdf" }), "mec-1.pdf");
    body.append("documentsByCategory[mec]", new Blob([Buffer.from("%PDF-1.7 mec two")], { type: "application/pdf" }), "mec-2.pdf");
    body.append("documentsByCategory[v5c]", new Blob([Buffer.from("%PDF-1.7 v5c one")], { type: "application/pdf" }), "v5c-1.pdf");
    const upload = await fetch(`${baseUrl}/vehicles/${vehicleId}/record-documents/upload`, {
      method: "POST",
      headers: { cookie: detail.cookie, accept: "application/json" },
      body
    });
    assert.equal(upload.status, 200);
    const payload = await upload.json() as { notice: string; statuses: Array<{ status: string; category: string }> };
    assert.equal(payload.notice, "document-added");
    assert.equal(payload.statuses.length, 3);
    assert.ok(payload.statuses.every((item) => item.status === "success"));
    const docs = await query<{ category: string; count: number }>(
      `SELECT category, count(*)::int AS count FROM entity_documents
       WHERE entity_type='vehicle' AND entity_id=$1
       GROUP BY category ORDER BY category`,
      [vehicleId]
    );
    assert.deepEqual(docs.rows, [
      { category: "mec", count: 2 },
      { category: "v5c", count: 1 }
    ]);
  });

  test("upload limits remain category-scoped and still validate CSRF", async () => {
    signIn(["admin"]);
    const vehicleId = await createVehicle("DOC LIMIT", "active");
    const detail = await openForm(`/vehicles/${vehicleId}`);
    const maxFiles = Number(/Max (\d+) files per category/.exec(detail.body)?.[1]);
    assert.ok(maxFiles > 0);
    const makeBody = (token?: string) => {
      const body = new FormData();
      if (token) body.append("_csrf", token);
      body.append("category", "v5c");
      for (let index = 0; index <= maxFiles; index += 1) {
        body.append("documents", new Blob([Buffer.from("%PDF-1.7 test")], { type: "application/pdf" }), `limit-${index}.pdf`);
      }
      return body;
    };
    const rejectedCsrf = await fetch(`${baseUrl}/vehicles/${vehicleId}/record-documents/upload`, {
      method: "POST",
      headers: { cookie: detail.cookie },
      body: makeBody()
    });
    assert.equal(rejectedCsrf.status, 403);

    const response = await fetch(`${baseUrl}/vehicles/${vehicleId}/record-documents/upload`, {
      method: "POST",
      headers: { cookie: detail.cookie },
      body: makeBody(detail.token)
    });
    assert.equal(response.status, 400);
    const responseBody = await response.text();
    assert.match(responseBody, new RegExp(`Select no more than ${maxFiles} files for V5C`));
    const docs = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM entity_documents WHERE entity_type='vehicle' AND entity_id=$1",
      [vehicleId]
    );
    assert.equal(docs.rows[0].count, 0);
  });

  test("concurrent uploads cannot exceed the per-category file limit", async () => {
    signIn(["admin"]);
    const vehicleId = await createVehicle("DOC CONCURRENT", "active");
    const detail = await openForm(`/vehicles/${vehicleId}`);
    const maxFiles = Number(/Max (\d+) files per category/.exec(detail.body)?.[1]);
    const uploads = await Promise.all(Array.from({ length: maxFiles + 1 }, (_, index) => {
      const body = new FormData();
      body.append("_csrf", detail.token);
      body.append("category", "mot");
      body.append("documents", new Blob([Buffer.from("%PDF-1.7 concurrent")], { type: "application/pdf" }), `concurrent-${index}.pdf`);
      return fetch(`${baseUrl}/vehicles/${vehicleId}/record-documents/upload`, {
        method: "POST",
        headers: { cookie: detail.cookie },
        body
      });
    }));
    const docs = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM entity_documents WHERE entity_type='vehicle' AND entity_id=$1 AND category='mot'",
      [vehicleId]
    );
    assert.equal(docs.rows[0].count, maxFiles);
    assert.ok(uploads.some((response) => response.status === 400));
  });

  test("upload metadata and audit roll back together and remove the written vault file", async () => {
    signIn(["admin"]);
    const vehicleId = await createVehicle("DOC ROLLBACK", "active");
    const detail = await openForm(`/vehicles/${vehicleId}`);
    const vaultFilesBefore = (await readdir(vaultRoot, { recursive: true })).filter((file) => file.endsWith(".pdf"));
    await query("DELETE FROM document_access_events");
    await query(`ALTER TABLE document_access_events ADD CONSTRAINT reject_test_upload_audit CHECK (action <> 'upload')`);
    try {
      const body = new FormData();
      body.append("_csrf", detail.token);
      body.append("category", "v5c");
      body.append("documents", new Blob([Buffer.from("%PDF-1.7 rollback")], { type: "application/pdf" }), "rollback.pdf");
      const response = await fetch(`${baseUrl}/vehicles/${vehicleId}/record-documents/upload`, {
        method: "POST",
        headers: { cookie: detail.cookie },
        body
      });
      assert.equal(response.status, 400);
      const documents = await query<{ count: number }>(
        "SELECT count(*)::int AS count FROM entity_documents WHERE entity_type='vehicle' AND entity_id=$1",
        [vehicleId]
      );
      assert.equal(documents.rows[0].count, 0);
      const vaultFiles = (await readdir(vaultRoot, { recursive: true })).filter((file) => file.endsWith(".pdf"));
      assert.deepEqual(vaultFiles.sort(), vaultFilesBefore.sort());
    } finally {
      await query("ALTER TABLE document_access_events DROP CONSTRAINT reject_test_upload_audit");
    }
  });

  test("required document groups retain legacy vehicle documents and links", async () => {
    signIn(["admin"]);
    const vehicleId = await createVehicle("DOC LEGACY", "active");
    const legacy = await createVehicleDocument({
      vehicleId,
      documentType: "v5c",
      originalFilename: "legacy-v5c.pdf",
      mimeType: "application/pdf",
      content: Buffer.from("%PDF-1.7 legacy"),
      uploadedBy: ADMIN_USER_ID
    });
    const response = await fetch(`${baseUrl}/vehicles/${vehicleId}`);
    const body = await response.text();
    assert.match(body, /legacy-v5c\.pdf/);
    assert.match(body, new RegExp(`/vehicles/documents/${legacy}`));
    assert.match(body, /Status: Uploaded/);
  });

  test("stepwise staged batch reports category failures without dropping successful category uploads", async () => {
    signIn(["admin"]);
    const vehicleId = await createVehicle("DOC PARTIAL", "active");
    const detail = await openForm(`/vehicles/${vehicleId}`);
    const body = new FormData();
    body.append("_csrf", detail.token);
    body.append("documentsByCategory[v5c]", new Blob([Buffer.from("%PDF-1.7 staged v5c")], { type: "application/pdf" }), "staged-v5c.pdf");
    body.append("documentsByCategory[mec]", new Blob(["<html>bad</html>"], { type: "text/html" }), "bad-mec.html");
    const upload = await fetch(`${baseUrl}/vehicles/${vehicleId}/record-documents/upload`, {
      method: "POST",
      headers: { cookie: detail.cookie, accept: "application/json" },
      body
    });
    assert.equal(upload.status, 400);
    const payload = await upload.json() as { notice: string; statuses: Array<{ category: string; status: string; reason?: string }> };
    assert.equal(payload.notice, "document-partial");
    assert.ok(payload.statuses.some((item) => item.category === "v5c" && item.status === "success"));
    assert.ok(payload.statuses.some((item) => item.category === "mec" && item.status === "failed" && /Only valid PDF, JPEG, and PNG documents are accepted/.test(item.reason || "")));
    const docs = await query<{ category: string; count: number }>(
      `SELECT category, count(*)::int AS count FROM entity_documents
       WHERE entity_type='vehicle' AND entity_id=$1
       GROUP BY category ORDER BY category`,
      [vehicleId]
    );
    assert.deepEqual(docs.rows, [{ category: "v5c", count: 1 }]);
  });

  test("upload failure does not remove saved record", async () => {
    signIn(["admin"]);
    const vehicleId = await createVehicle("DOC FAIL", "active");
    const detail = await openForm(`/vehicles/${vehicleId}`);
    const body = new FormData();
    body.append("_csrf", detail.token);
    body.append("category", "v5c");
    body.append("documents", new Blob(["<html>bad</html>"], { type: "text/html" }), "bad.html");
    const upload = await fetch(`${baseUrl}/vehicles/${vehicleId}/record-documents/upload`, {
      method: "POST",
      headers: { cookie: detail.cookie },
      body,
    });
    assert.equal(upload.status, 400);
    const stillExists = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM vehicles WHERE id=$1",
      [vehicleId]
    );
    assert.equal(stillExists.rows[0].count, 1);
  });

  test("detail page renders all required vehicle document rows with uploaded/missing states", async () => {
    signIn(["admin"]);
    const vehicleId = await createVehicle("DOC STATE", "active");
    const detail = await openForm(`/vehicles/${vehicleId}`);
    const uploadBody = new FormData();
    uploadBody.append("_csrf", detail.token);
    uploadBody.append("category", "v5c");
    uploadBody.append("documents", new Blob([Buffer.from("%PDF-1.7 v5c")], { type: "application/pdf" }), "v5c.pdf");
    await fetch(`${baseUrl}/vehicles/${vehicleId}/record-documents/upload`, {
      method: "POST",
      headers: { cookie: detail.cookie },
      body: uploadBody
    });
    const detailBody = await (await fetch(`${baseUrl}/vehicles/${vehicleId}`)).text();
    for (const label of ["V5C", "MEC \/ Council Mechanical Check", "Hire &amp; Reward Insurance", "HC/PHV License issued", "MOT"]) {
      assert.match(detailBody, new RegExp(label));
    }
    assert.match(detailBody, /<strong>MEC \/ Council Mechanical Check<\/strong>/);
    assert.doesNotMatch(detailBody, /<strong>Council Mechanical Check<\/strong>/);
    assert.match(detailBody, /Status: Uploaded/);
    assert.match(detailBody, /Status: Missing/);
    assert.match(detailBody, /record-documents\/upload/);
    assert.match(detailBody, /Upload selected documents/);
    assert.match(detailBody, /record-documents\/.*\/view/);
  });

  test("admins create and edit distinct vehicle licence types and badges", async () => {
    signIn(["admin"]);
    const existingVehicle = (await query<{ id: string }>("SELECT id FROM vehicles WHERE registration = 'AB12 CDE'")).rows[0];
    const vehicleId = existingVehicle?.id || await createVehicle("AB12 CDE", "active");
    const authorityId = "test-vehicle-authority";
    const now = new Date().toISOString();
    await query(
      `INSERT INTO licensing_authorities (id, name, active, preference_order, created_at, updated_at)
       VALUES ($1, 'Test vehicle authority', TRUE, 1, $2, $2) ON CONFLICT (id) DO NOTHING`,
      [authorityId, now]
    );
    const detail = await openForm(`/vehicles/${vehicleId}`);
    const created = await postForm(`/vehicles/${vehicleId}/licenses`, [
      ["_csrf", detail.token], ["licensingAuthorityId", authorityId], ["licenseType", "hackney_carriage"],
      ["vehicleLicenseBadge", "HC-VEH-1"], ["licenseReference", "REF-HC-1"], ["validFrom", "2026-01-01"]
    ], detail.cookie);
    assert.equal(created.headers.get("location"), `/vehicles/${vehicleId}?notice=license-saved`);
    const row = (await query<{ id: string }>(
      "SELECT id FROM vehicle_licensing_authorities WHERE vehicle_id=$1 AND license_type='hackney_carriage'",
      [vehicleId]
    )).rows[0];
    assert.ok(row?.id);

    const reloaded = await openForm(`/vehicles/${vehicleId}`);
    assert.match(reloaded.body, /Vehicle licence badge/);
    assert.match(reloaded.body, /HC-VEH-1/);
    const changed = await postForm(`/vehicles/${vehicleId}/licenses`, [
      ["_csrf", reloaded.token], ["licenseId", row.id], ["licensingAuthorityId", authorityId],
      ["licenseType", "private_hire"], ["vehicleLicenseBadge", "PH-VEH-2"],
      ["licenseReference", "REF-PH-2"], ["validFrom", "2026-02-01"]
    ], reloaded.cookie);
    assert.equal(changed.headers.get("location"), `/vehicles/${vehicleId}?notice=license-saved`);
    const saved = await query<{ license_type: string; vehicle_license_badge: string; license_reference: string }>(
      "SELECT license_type, vehicle_license_badge, license_reference FROM vehicle_licensing_authorities WHERE id=$1",
      [row.id]
    );
    assert.deepEqual(saved.rows[0], {
      license_type: "private_hire", vehicle_license_badge: "PH-VEH-2", license_reference: "REF-PH-2"
    });
    assert.match((await (await fetch(`${baseUrl}/vehicles/${vehicleId}`)).text()), /PH-VEH-2/);
  });

  test("detail page manages driver assignments and preserves assignment history", async () => {
    signIn(["admin"]);
    const id = (await query<{ id: string }>("SELECT id FROM vehicles WHERE registration = 'AB12 CDE'")).rows[0].id;
    const detail = await openForm(`/vehicles/${id}`);
    assert.match(detail.body, /driver@ridematrix\.com/);
    assert.match(detail.body, /No driver has been assigned to this vehicle yet/);

    let response = await postForm(`/vehicles/${id}/driver`, [["_csrf", detail.token], ["driverId", DRIVER_ID]], detail.cookie);
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=driver-updated`);
    response = await postForm(`/vehicles/${id}/driver`, [["_csrf", detail.token], ["driverId", DRIVER_ID]], detail.cookie);
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=driver-unchanged`);
    response = await postForm(`/vehicles/${id}/driver`, [["_csrf", detail.token], ["driverId", ADMIN_USER_ID]], detail.cookie);
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=driver-invalid`);
    response = await postForm(`/vehicles/${id}/driver`, [["_csrf", detail.token], ["driverId", SECOND_DRIVER_ID]], detail.cookie);
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=driver-updated`);

    const otherId = (await query<{ id: string }>("SELECT id FROM vehicles WHERE registration = 'MA1 NT'")).rows[0].id;
    response = await postForm(`/vehicles/${otherId}/driver`, [["_csrf", detail.token], ["driverId", SECOND_DRIVER_ID]], detail.cookie);
    assert.equal(response.headers.get("location"), `/vehicles/${otherId}?notice=driver-updated`, "a driver may be assigned to multiple vehicles");

    const missing = await postForm("/vehicles/does-not-exist/driver", [["_csrf", detail.token], ["driverId", DRIVER_ID]], detail.cookie);
    assert.equal(missing.status, 404);

    const history = await fetch(`${baseUrl}/vehicles/${id}/driver-history`);
    assert.equal(history.status, 200);
    const historyBody = await history.text();
    assert.match(historyBody, /driver@ridematrix\.com[\s\S]*Ended/);
    assert.match(historyBody, /second\.driver@ridematrix\.com[\s\S]*Current/);
    const rows = await query<{ count: number }>("SELECT count(*)::int AS count FROM vehicle_driver_assignments WHERE vehicle_id = $1", [id]);
    assert.equal(rows.rows[0].count, 2);

    const listBody = await (await fetch(`${baseUrl}/vehicles?status=active`)).text();
    assert.match(listBody, /second\.driver@ridematrix\.com/);

    response = await postForm(`/vehicles/${id}/driver`, [["_csrf", detail.token], ["driverId", ""]], detail.cookie);
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=driver-unassigned`);
    const active = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM vehicle_driver_assignments WHERE vehicle_id = $1 AND unassigned_at IS NULL", [id]
    );
    assert.equal(active.rows[0].count, 0);
  });

  test("detail page uploads, previews, and safely downloads compliance documents", async () => {
    signIn(["admin"]);
    const id = (await query<{ id: string }>("SELECT id FROM vehicles WHERE registration = 'AB12 CDE'")).rows[0].id;
    const detail = await openForm(`/vehicles/${id}`);
    const upload = (fields: Record<string, string>, file: Blob, filename: string) => {
      const body = new FormData();
      body.append("_csrf", detail.token);
      for (const [key, value] of Object.entries(fields)) body.append(key, value);
      body.append("document", file, filename);
      return fetch(`${baseUrl}/vehicles/${id}/documents`, { method: "POST", headers: { cookie: detail.cookie }, body, redirect: "manual" });
    };
    const pdf = new Blob([Buffer.from("%PDF-1.7 test")], { type: "application/pdf" });
    const uploadRequiredDocument = (documentType: string, file: Blob, filename: string) => {
      const body = new FormData();
      body.append("_csrf", detail.token);
      body.append("document", file, filename);
      return fetch(`${baseUrl}/vehicles/${id}/record-documents/${documentType}`, {
        method: "POST",
        headers: { cookie: detail.cookie },
        body,
        redirect: "manual"
      });
    };

    let response = await upload({ documentType: "insurance", expiresOn: "2099-01-01" }, new Blob(["<html>"], { type: "text/html" }), "x.html");
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=document-invalid-file`);
    response = await upload({ documentType: "insurance", expiresOn: "2000-01-01" }, pdf, "insurance.pdf");
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=document-invalid-expiry`);
    response = await upload({ documentType: "passport", expiresOn: "2099-01-01" }, pdf, "insurance.pdf");
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=document-invalid-type`);
    response = await upload({ documentType: "insurance", documentNumber: "POL-1", expiresOn: "2099-01-01" }, pdf, "insurance\".pdf");
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=document-added`);
    response = await uploadRequiredDocument("mot", new Blob([Buffer.from("%PDF-1.7 mot replacement")], { type: "application/pdf" }), "mot-replacement.pdf");
    assert.equal(response.status, 200);
    const latestMot = (await query<{ original_filename: string }>(
      `SELECT original_filename FROM entity_documents
       WHERE entity_type='vehicle' AND entity_id=$1 AND category='mot'
       ORDER BY uploaded_at DESC, id DESC LIMIT 1`,
      [id]
    )).rows[0];
    assert.equal(latestMot.original_filename, "mot-replacement.pdf");

    const detailBody = await (await fetch(`${baseUrl}/vehicles/${id}?notice=document-added`)).text();
    assert.match(detailBody, /Document uploaded\./);
    assert.match(detailBody, /Status: Valid/);
    const insuranceDocument = (await query<{ id: string }>(
      "SELECT id FROM vehicle_documents WHERE vehicle_id=$1 AND document_type='insurance' AND is_latest=TRUE",
      [id]
    )).rows[0];
    assert.ok(insuranceDocument?.id);
    const documentId = insuranceDocument.id;

    const download = await fetch(`${baseUrl}/vehicles/documents/${documentId}?download=1`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/pdf");
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(download.headers.get("cache-control") || "", /no-store/);
    assert.match(download.headers.get("content-disposition") || "", /^attachment; filename="insurance[a-z0-9._ -]*\.pdf"$/i);

    const licenseId = (await query<{ id: string }>(
      "SELECT id FROM vehicle_licensing_authorities WHERE vehicle_id=$1 AND license_type='private_hire'",
      [id]
    )).rows[0].id;
    const firstBadgeDocument = Buffer.from("%PDF-1.7 vehicle badge original");
    response = await upload(
      { documentType: "hackney_ph_badge", licenseId, expiresOn: "2099-01-01" },
      new Blob([firstBadgeDocument], { type: "application/pdf" }),
      "vehicle-badge.pdf"
    );
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=document-added`);
    const originalDocumentId = (await query<{ id: string }>(
      "SELECT id FROM vehicle_documents WHERE vehicle_id=$1 AND license_id=$2 AND document_type='hackney_ph_badge'",
      [id, licenseId]
    )).rows[0].id;
    const replacementBytes = Buffer.from("%PDF-1.7 vehicle badge replacement");
    response = await upload(
      { documentType: "hackney_ph_badge", licenseId, expiresOn: "2099-01-01" },
      new Blob([replacementBytes], { type: "application/pdf" }),
      "vehicle-badge-replacement.pdf"
    );
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=document-added`);
    const history = await query<{ id: string; is_latest: boolean; byte_size: string | number; checksum: string; uploaded_by: string }>(
      `SELECT id, is_latest, byte_size, checksum, uploaded_by FROM vehicle_documents
       WHERE vehicle_id=$1 AND license_id=$2 AND document_type='hackney_ph_badge' ORDER BY uploaded_at, id`,
      [id, licenseId]
    );
    assert.equal(history.rows.length, 2);
    assert.equal(history.rows.find((item) => item.id === originalDocumentId)?.is_latest, false);
    const current = history.rows.find((item) => item.is_latest);
    assert.ok(current);
    assert.equal(Number(current.byte_size), replacementBytes.length);
    assert.equal(current.checksum, createHash("sha256").update(replacementBytes).digest("hex"));
    assert.equal(current.uploaded_by, ADMIN_USER_ID);
    const previousDownload = await fetch(`${baseUrl}/vehicles/documents/${originalDocumentId}?download=1`);
    assert.equal(previousDownload.status, 200);
    assert.deepEqual(Buffer.from(await previousDownload.arrayBuffer()), firstBadgeDocument);
    const uploadedRecordDocument = (await query<{ id: string }>(
      "SELECT id FROM entity_documents WHERE entity_type='vehicle' AND entity_id=$1 AND category='mot' ORDER BY uploaded_at DESC, id DESC LIMIT 1",
      [id]
    )).rows[0];
    const recordView = await fetch(`${baseUrl}/vehicles/record-documents/${uploadedRecordDocument.id}/view`);
    assert.equal(recordView.status, 200);
    assert.equal(recordView.headers.get("content-type"), "application/pdf");

    signIn(["driver"]);
    const denied = await fetch(`${baseUrl}/vehicles/documents/${documentId}`, { redirect: "manual" });
    assert.equal(denied.status, 403);
    const deniedRecordView = await fetch(`${baseUrl}/vehicles/record-documents/${uploadedRecordDocument.id}/view`, { redirect: "manual" });
    assert.equal(deniedRecordView.status, 403);
    const deniedUpload = await upload({ documentType: "insurance", expiresOn: "2099-01-01" }, pdf, "insurance.pdf");
    assert.equal(deniedUpload.status, 403);
    const docs = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM vehicle_documents WHERE vehicle_id = $1 AND document_type='insurance'",
      [id]
    );
    assert.equal(docs.rows[0].count, 1);
  });

  test("dashboard Active vehicles destination is the filtered vehicle directory", async () => {
    signIn(["admin"]);
    const vehicleActions = operationalMenuRows.find((row) => row.category === "Vehicles")?.actions || [];
    const activeHref = vehicleActions.find((action) => action.label === "Active vehicles")?.href || "";
    const allHref = vehicleActions.find((action) => action.label === "All vehicles")?.href || "";
    const active = await fetch(`${baseUrl}${activeHref}`, { redirect: "manual" });
    assert.equal(active.status, 200);
    const activeBody = await active.text();
    assert.match(activeBody, /<h1>Active vehicles<\/h1>/);
    assert.doesNotMatch(activeBody, /MA1 NT/);
    const all = await fetch(`${baseUrl}${allHref}`, { redirect: "manual" });
    assert.equal(all.status, 200);
    assert.match(await all.text(), /MA1 NT/);
  });
});
