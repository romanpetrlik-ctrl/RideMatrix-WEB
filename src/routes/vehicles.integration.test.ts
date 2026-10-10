import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import express from "express";
import { initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext, safeCleanupTestDatabase } from "../database/test-helper";
import { createCsrfProtection } from "../middleware/csrf";
import { CSRF_COOKIE_NAME } from "../services/csrf";
import { SessionAccount } from "../services/api";
import { operationalMenuRows } from "./dashboard";
import { createVehiclesRouter } from "./vehicles";

const DRIVER_ID = "a0000000-0000-0000-0000-000000000002";
const SECOND_DRIVER_ID = "a0000000-0000-0000-0000-000000000003";
const ADMIN_USER_ID = "a0000000-0000-0000-0000-000000000001";

describe("vehicle management end-to-end workflow", () => {
  let dbContext: TestDatabaseContext | undefined;
  let appServer: Server;
  let baseUrl: string;
  let session: SessionAccount = { authenticated: false };

  before(async () => {
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

  function vehicleFields(token: string, registration: string, status: string): Array<[string, string]> {
    return [["_csrf", token], ["registration", registration], ["make", "Toyota"], ["model", "Prius"], ["year", "2022"],
      ["fuelType", "HYBRID"], ["passengerCapacity", "4"], ["status", status], ["classKeys", "standard_sedan_hatchback"],
      ["capacity_xl_suitcase", "1"], ["capacity_cabin_bag", "2"]];
  }

  async function createVehicle(registration: string, status: string): Promise<string> {
    const form = await openForm("/vehicles/new");
    const response = await postForm("/vehicles/new", vehicleFields(form.token, registration, status), form.cookie);
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

    const noMatch = await (await fetch(`${baseUrl}/vehicles?status=active&q=ma1`)).text();
    assert.match(noMatch, /No active vehicles found/);

    const ignoredStatus = await (await fetch(`${baseUrl}/vehicles?status=bogus`)).text();
    assert.match(ignoredStatus, /MA1 NT/);
    assert.match(ignoredStatus, /AB12 CDE/);
  });

  test("create and edit show validation errors instead of failing", async () => {
    signIn(["admin"]);
    const form = await openForm("/vehicles/new");
    const duplicate = await postForm("/vehicles/new", vehicleFields(form.token, "AB12 CDE", "active"), form.cookie);
    assert.equal(duplicate.status, 400);
    const duplicateBody = await duplicate.text();
    assert.match(duplicateBody, /already exists/);
    assert.match(duplicateBody, /action="\/vehicles\/new"/);

    const id = (await query<{ id: string }>("SELECT id FROM vehicles WHERE registration = 'AB12 CDE'")).rows[0].id;
    const edit = await openForm(`/vehicles/${id}/edit`);
    assert.match(edit.body, /name="year"[^>]*value="2022"/);
    const invalid = await postForm(`/vehicles/${id}/edit`, [["_csrf", edit.token], ["registration", ""], ["make", "Toyota"],
      ["model", "Prius"], ["fuelType", "HYBRID"], ["passengerCapacity", "4"], ["status", "active"], ["classKeys", "standard_sedan_hatchback"]], edit.cookie);
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /Registration, make, and model are required/);

    const updated = await postForm(`/vehicles/${id}/edit`, vehicleFields(edit.token, "AB12 CDE", "maintenance"), edit.cookie);
    assert.equal(updated.status, 302);
    assert.equal(updated.headers.get("location"), `/vehicles/${id}?notice=updated`);
    const activeBody = await (await fetch(`${baseUrl}/vehicles?status=active`)).text();
    assert.doesNotMatch(activeBody, /AB12 CDE/);
    await postForm(`/vehicles/${id}/edit`, vehicleFields(edit.token, "AB12 CDE", "active"), edit.cookie);

    const missing = await postForm("/vehicles/does-not-exist/edit", vehicleFields(edit.token, "ZZ1", "active"), edit.cookie);
    assert.equal(missing.status, 404);
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

    let response = await upload({ documentType: "insurance", expiresOn: "2099-01-01" }, new Blob(["<html>"], { type: "text/html" }), "x.html");
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=document-invalid-file`);
    response = await upload({ documentType: "insurance", expiresOn: "2000-01-01" }, pdf, "insurance.pdf");
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=document-invalid-expiry`);
    response = await upload({ documentType: "passport", expiresOn: "2099-01-01" }, pdf, "insurance.pdf");
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=document-invalid-type`);
    response = await upload({ documentType: "insurance", documentNumber: "POL-1", expiresOn: "2099-01-01" }, pdf, "insurance\".pdf");
    assert.equal(response.headers.get("location"), `/vehicles/${id}?notice=document-added`);

    const detailBody = await (await fetch(`${baseUrl}/vehicles/${id}?notice=document-added`)).text();
    assert.match(detailBody, /Document uploaded\./);
    assert.match(detailBody, /Status: Valid/);
    const documentId = /href="\/vehicles\/documents\/([^"?]+)\?download=1"/.exec(detailBody)?.[1];
    assert.ok(documentId);

    const download = await fetch(`${baseUrl}/vehicles/documents/${documentId}?download=1`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/pdf");
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(download.headers.get("cache-control") || "", /no-store/);
    assert.match(download.headers.get("content-disposition") || "", /^attachment; filename="insurance[a-z0-9._ -]*\.pdf"$/i);

    signIn(["driver"]);
    const denied = await fetch(`${baseUrl}/vehicles/documents/${documentId}`, { redirect: "manual" });
    assert.equal(denied.status, 403);
    const deniedUpload = await upload({ documentType: "insurance", expiresOn: "2099-01-01" }, pdf, "insurance.pdf");
    assert.equal(deniedUpload.status, 403);
    const docs = await query<{ count: number }>("SELECT count(*)::int AS count FROM vehicle_documents WHERE vehicle_id = $1", [id]);
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
