import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import path from "node:path";
import { createCsrfProtection } from "../middleware/csrf";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, TestDatabaseContext } from "../database/test-helper";
import {
  addLicense,
  assignBookingWithLicensing,
  createLicensingAuthority,
  getBookingAssignmentPage,
  saveVehicleLicense,
  unassignBookingVehicle
} from "../services/licensing";
import { SessionAccount } from "../services/api";
import { createVehicle } from "../services/vehicles";
import { createCustomersRouter } from "./customers";

const ADMIN_ID = "a0000000-0000-0000-0000-000000000001";
const DRIVER_A_ID = "a0000000-0000-0000-0000-000000000002";
const DRIVER_B_ID = "a0000000-0000-0000-0000-000000000003";
const CUSTOMER_ID = "assignment-test-customer";
const AUTHORITY_A = "assignment-authority-a";
const AUTHORITY_B = "assignment-authority-b";
const LEGACY_ONLY_AUTHORITY = "assignment-legacy-only-authority";
const SERVICE_DATE = "2026-11-15";

const adminSession: SessionAccount = {
  authenticated: true,
  user: { id: ADMIN_ID, email: "admin@example.com", roles: ["admin"], active_role: "admin" }
};
const nonAdminSession: SessionAccount = {
  authenticated: true,
  user: { id: DRIVER_A_ID, email: "driver@example.com", roles: ["driver"], active_role: "driver" }
};

let dbContext: TestDatabaseContext | undefined;
let vehicleMain: string;
let vehicleA: string;
let vehicleB: string;
let vehicleMissingBadge: string;
let operatorLicenceA: string;
let driverLicenceA: string;
let driverMainLicenceA: string;
let vehicleLicenceA: string;
let vehicleLicenceAPrivateHire: string;
let vehicleLicenceMainB: string;
let vehicleLicenceB: string;
let vehicleALicence: string;
let missingBadgeVehicleLicence: string;
let currentSession = adminSession;

function createServer() {
  const app = express();
  app.set("views", path.join(process.cwd(), "src/views"));
  app.set("view engine", "ejs");
  app.use(express.urlencoded({ extended: false }));
  app.use(createCsrfProtection({ appTitle: "Assignment Test", cookieSecure: false }));
  app.use(createCustomersRouter({
    appTitle: "Assignment Test",
    loadSession: async () => currentSession
  }));
  return app.listen(0);
}

async function addBooking(id: string): Promise<void> {
  await query(
    `INSERT INTO customer_bookings
       (id, customer_id, reference, service_date, pickup, dropoff, status, total_fare_amount, created_at)
     VALUES ($1,$2,$3,$4,'A','B','Scheduled',1.00,$5)`,
    [id, CUSTOMER_ID, `REF-${id}`, SERVICE_DATE, new Date().toISOString()]
  );
}

async function addOperatorLicence(id: string, authorityId: string, status = "active"): Promise<string> {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO operator_licences
       (id, operator_id, licence_type, licence_number, licensing_authority_id, valid_from, valid_to, status,
        created_by_user_id, created_by_user_email, updated_by_user_id, updated_by_user_email, created_at, updated_at)
     VALUES ($1,'assignment-test-operator','pho',$2,$3,'2020-01-01',NULL,$4,$5,'admin@example.com',$5,'admin@example.com',$6,$6)`,
    [id, `OP-${id}`, authorityId, status, ADMIN_ID, now]
  );
  await query(
    `INSERT INTO operator_licence_documents
       (id, licence_id, original_filename, mime_type, byte_size, checksum, content, is_latest, uploaded_at)
     VALUES ($1,$2,'operator-licence.pdf','application/pdf',8,$3,$4,TRUE,$5)`,
    [`doc-${id}`, id, "a".repeat(64), Buffer.from("%PDF-1.7"), now]
  );
  return id;
}

async function setupFixtures(): Promise<void> {
  const now = new Date().toISOString();
  await createLicensingAuthority({ id: AUTHORITY_A, name: "Authority A", preferenceOrder: 1 });
  await createLicensingAuthority({ id: AUTHORITY_B, name: "Authority B", preferenceOrder: 2 });
  await createLicensingAuthority({ id: LEGACY_ONLY_AUTHORITY, name: "Legacy-only Authority", preferenceOrder: 3 });
  await query(
    `INSERT INTO operators (id, legal_name, license_holder_name, created_at, updated_at)
     VALUES ('assignment-test-operator','Assignment Test Operator','Assignment Test Operator',$1,$1)`,
    [now]
  );
  await query(
    `INSERT INTO system_setup_state (id, operator_id, setup_key, status, completed_at)
     VALUES ('assignment-test-setup','assignment-test-operator','initial_system_setup','completed',$1)`,
    [now]
  );
  operatorLicenceA = await addOperatorLicence("operator-licence-a", AUTHORITY_A);
  await addOperatorLicence("operator-licence-b", AUTHORITY_B);
  await query(
    `INSERT INTO operator_licensing_authorities
       (id, operator_id, licensing_authority_id, valid_from, active, created_at, updated_at)
     VALUES ('legacy-operator-licence','assignment-test-operator',$1,'2020-01-01',TRUE,$2,$2)`,
    [LEGACY_ONLY_AUTHORITY, now]
  );

  await query(
    `INSERT INTO users (id, email, status) VALUES ($1,'driver-b@example.com','Active') ON CONFLICT DO NOTHING`,
    [DRIVER_B_ID]
  );
  await query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1,2),($2,2) ON CONFLICT DO NOTHING`,
    [DRIVER_A_ID, DRIVER_B_ID]
  );
  driverMainLicenceA = await addLicense("driver", DRIVER_A_ID, {
    licensingAuthorityId: AUTHORITY_A, validFrom: "2020-01-01"
  });
  await addLicense("driver", DRIVER_A_ID, { licensingAuthorityId: AUTHORITY_B, validFrom: "2020-01-01" });
  await addLicense("driver", DRIVER_B_ID, { licensingAuthorityId: AUTHORITY_B, validFrom: "2020-01-01" });
  driverLicenceA = await addLicense("driver", DRIVER_B_ID, {
    licensingAuthorityId: AUTHORITY_A, validFrom: "2030-01-01"
  });

  vehicleMain = (await createVehicle({
    registration: "ASSIGN-MAIN", make: "Test", model: "Car", classKeys: ["standard_sedan_hatchback"],
    fuelType: "ICE", passengerCapacity: 4, status: "active"
  })).id;
  vehicleA = (await createVehicle({
    registration: "ASSIGN-A", make: "Test", model: "Car", classKeys: ["standard_sedan_hatchback"],
    fuelType: "ICE", passengerCapacity: 4, status: "active"
  })).id;
  vehicleB = (await createVehicle({
    registration: "ASSIGN-B", make: "Test", model: "Car", classKeys: ["standard_sedan_hatchback"],
    fuelType: "ICE", passengerCapacity: 4, status: "active"
  })).id;
  vehicleMissingBadge = (await createVehicle({
    registration: "ASSIGN-NO-BADGE", make: "Test", model: "Car", classKeys: ["standard_sedan_hatchback"],
    fuelType: "ICE", passengerCapacity: 4, status: "active"
  })).id;

  vehicleLicenceA = (await saveVehicleLicense(vehicleMain, {
    licensingAuthorityId: AUTHORITY_A, licenseType: "hackney_carriage",
    vehicleLicenseBadge: "HC-A-1", validFrom: "2020-01-01"
  }))!;
  vehicleLicenceAPrivateHire = (await saveVehicleLicense(vehicleMain, {
    licensingAuthorityId: AUTHORITY_A, licenseType: "private_hire",
    vehicleLicenseBadge: "PH-A-1", validFrom: "2020-01-01"
  }))!;
  vehicleLicenceMainB = (await saveVehicleLicense(vehicleMain, {
    licensingAuthorityId: AUTHORITY_B, licenseType: "hackney_carriage",
    vehicleLicenseBadge: "HC-B-1", validFrom: "2020-01-01"
  }))!;
  await saveVehicleLicense(vehicleMain, {
    licensingAuthorityId: AUTHORITY_B, licenseType: "private_hire",
    vehicleLicenseBadge: "PH-B-1", validFrom: "2020-01-01"
  });
  vehicleALicence = (await saveVehicleLicense(vehicleA, {
    licensingAuthorityId: AUTHORITY_A, licenseType: "hackney_carriage",
    vehicleLicenseBadge: "HC-A-ONLY", validFrom: "2020-01-01"
  }))!;
  vehicleLicenceB = (await saveVehicleLicense(vehicleB, {
    licensingAuthorityId: AUTHORITY_B, licenseType: "hackney_carriage",
    vehicleLicenseBadge: "HC-B-ONLY", validFrom: "2020-01-01"
  }))!;
  assert.ok(vehicleALicence);
  missingBadgeVehicleLicence = (await saveVehicleLicense(vehicleMissingBadge, {
    licensingAuthorityId: AUTHORITY_A, licenseType: "private_hire", validFrom: "2020-01-01"
  }))!;

  await query(
    `INSERT INTO customers (id, given_name, surname, created_at, updated_at)
     VALUES ($1,'Ada','Lovelace',$2,$2)`,
    [CUSTOMER_ID, now]
  );
  await addBooking("assignment-main");
  await addBooking("assignment-mismatch-a-b-b");
  await addBooking("assignment-mismatch-a-b-a");
  await addBooking("assignment-mismatch-a-a-b");
  await addBooking("assignment-missing-badge");
  await query(
    `INSERT INTO import_batches (id, source_type, original_filename, uploaded_at, status)
     VALUES ('assignment-import-batch','csv','history.csv',$1,'completed')`,
    [now]
  );
  await query(
    `INSERT INTO imported_bookings
       (id, import_batch_id, source_system, customer_email, customer_name_raw, service_date_time,
        pickup_text, dropoff_text, is_future, inferred_temporal_status, customer_id, dedupe_key, created_at, updated_at)
     VALUES ('imp-book-assignment-history','assignment-import-batch','CSV','ada@example.com','Ada Lovelace',
       '2026-11-15T10:00:00Z','A','B',1,'future',$1,'assignment-import-history',$2,$2)`,
    [CUSTOMER_ID, now]
  );
}

async function cookieAndToken(response: Response): Promise<{ cookie: string; token: string; html: string }> {
  const html = await response.text();
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1] || "";
  assert.ok(cookie.startsWith("rm_csrf="));
  assert.ok(token);
  return { cookie, token, html };
}

async function assignmentPageUrl(port: number, bookingId = "assignment-main", queryString = ""): Promise<string> {
  return `http://127.0.0.1:${port}/customers/${CUSTOMER_ID}/bookings/${bookingId}/assignment${queryString}`;
}

test("admin booking assignment uses a common setup licence, snapshots badge, and excludes imported history", async () => {
  dbContext = await createTestDatabaseContext("test_booking_assignment");
  await dbContext.createAuthTables();
  await initializeDatabase();
  await setupFixtures();

  const server = createServer();
  const port = (server.address() as { port: number }).port;
  try {
    const history = await fetch(`http://127.0.0.1:${port}/customers/${CUSTOMER_ID}/bookings`);
    const historyHtml = await history.text();
    assert.equal(history.status, 200);
    assert.match(historyHtml, /Imported history — read only/);
    assert.match(historyHtml, /Assign \/ view/);

    currentSession = nonAdminSession;
    const forbidden = await fetch(await assignmentPageUrl(port));
    assert.equal(forbidden.status, 403);
    currentSession = adminSession;

    const forbiddenPost = await fetch(await assignmentPageUrl(port), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "assign" }),
      redirect: "manual"
    });
    assert.equal(forbiddenPost.status, 403);

    const selectionQuery = `?driverId=${DRIVER_A_ID}&vehicleLicenseId=${vehicleLicenceA}&vehicleLicenseType=hackney_carriage`;
    const pageResponse = await fetch(await assignmentPageUrl(port, "assignment-main", selectionQuery));
    assert.equal(pageResponse.status, 200);
    assert.equal(pageResponse.headers.get("cache-control"), "no-store, no-cache, must-revalidate, private");
    const { cookie, token, html: initialPageHtml } = await cookieAndToken(pageResponse);
    assert.match(initialPageHtml, /Authority A/);
    assert.match(initialPageHtml, /Authority B/);
    assert.equal((initialPageHtml.match(/name="licensingAuthorityId"/g) || []).length, 1);

    const missingCsrf = await fetch(await assignmentPageUrl(port), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "assign", driverId: DRIVER_A_ID, vehicleLicenseId: vehicleLicenceA,
        vehicleLicenseType: "hackney_carriage", licensingAuthorityId: AUTHORITY_A
      }),
      redirect: "manual"
    });
    assert.equal(missingCsrf.status, 403);

    const assign = async (bookingId: string, fields: Record<string, string>) => fetch(await assignmentPageUrl(port, bookingId), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token, action: "assign", ...fields }),
      redirect: "manual"
    });
    const noAuthorityChoice = await assign("assignment-main", {
      driverId: DRIVER_A_ID, vehicleLicenseId: vehicleLicenceA, vehicleLicenseType: "hackney_carriage",
      licensingAuthorityId: ""
    });
    assert.equal(noAuthorityChoice.status, 400, "the authority must be explicitly selected even when multiple choices exist");
    assert.equal((await query("SELECT id FROM booking_assignment_audit WHERE booking_id='assignment-main'")).rows.length, 0);

    const successful = await assign("assignment-main", {
      driverId: DRIVER_A_ID,
      vehicleLicenseId: vehicleLicenceA,
      vehicleLicenseType: "hackney_carriage",
      licensingAuthorityId: AUTHORITY_A,
      operatorId: "attacker-operator",
      actorId: "attacker-actor",
      serviceDate: "1900-01-01",
      vehicleLicenseBadge: "FORGED-BADGE"
    });
    assert.equal(successful.status, 302);
    const saved = await query<any>(
      `SELECT operator_id, driver_id, vehicle_id, licensing_authority_id, vehicle_license_type,
              vehicle_license_badge, service_date, assigned_by
         FROM customer_bookings WHERE id='assignment-main'`
    );
    assert.deepEqual(saved.rows[0], {
      operator_id: "assignment-test-operator",
      driver_id: DRIVER_A_ID,
      vehicle_id: vehicleMain,
      licensing_authority_id: AUTHORITY_A,
      vehicle_license_type: "hackney_carriage",
      vehicle_license_badge: "HC-A-1",
      service_date: SERVICE_DATE,
      assigned_by: ADMIN_ID
    });
    const firstAudit = await query<any>(
      "SELECT actor_id, licensing_authority_id, vehicle_license_type, vehicle_license_badge FROM booking_assignment_audit WHERE booking_id='assignment-main'"
    );
    assert.deepEqual(firstAudit.rows[0], {
      actor_id: ADMIN_ID, licensing_authority_id: AUTHORITY_A,
      vehicle_license_type: "hackney_carriage", vehicle_license_badge: "HC-A-1"
    });

    const reload = await fetch(await assignmentPageUrl(port));
    const reloadHtml = await reload.text();
    assert.match(reloadHtml, /Authority A/);
    assert.match(reloadHtml, /Hackney Carriage/);
    assert.match(reloadHtml, /HC-A-1/);
    assert.match(reloadHtml, /Assignment history/);
    assert.ok((reloadHtml.match(/HC-A-1/g) || []).length >= 2, "the booking snapshot and audit snapshot are both displayed");

    await saveVehicleLicense(vehicleMain, {
      licensingAuthorityId: AUTHORITY_A, licenseType: "hackney_carriage",
      vehicleLicenseBadge: "HC-A-UPDATED", validFrom: "2020-01-01"
    }, vehicleLicenceA);
    const privateHire = await assign("assignment-main", {
      driverId: DRIVER_A_ID, vehicleLicenseId: vehicleLicenceAPrivateHire, vehicleLicenseType: "private_hire",
      licensingAuthorityId: AUTHORITY_A
    });
    assert.equal(privateHire.status, 302);
    const phCurrentPage = await fetch(await assignmentPageUrl(port));
    const phHistoryHtml = await phCurrentPage.text();
    assert.match(phHistoryHtml, /Private Hire/);
    assert.match(phHistoryHtml, /HC-A-1/);
    assert.match(phHistoryHtml, /PH-A-1/);
    const secondAudit = await query<any>(
      "SELECT vehicle_license_type, vehicle_license_badge FROM booking_assignment_audit WHERE booking_id='assignment-main' ORDER BY assigned_at, id"
    );
    assert.deepEqual(secondAudit.rows.map((row) => row.vehicle_license_badge), ["HC-A-1", "PH-A-1"]);
    assert.deepEqual(secondAudit.rows.map((row) => row.vehicle_license_type), ["hackney_carriage", "private_hire"]);

    const authorityB = await assign("assignment-main", {
      driverId: DRIVER_A_ID, vehicleLicenseId: vehicleLicenceMainB, vehicleLicenseType: "hackney_carriage",
      licensingAuthorityId: AUTHORITY_B
    });
    assert.equal(authorityB.status, 302);
    const currentB = await query<any>(
      "SELECT licensing_authority_id, vehicle_license_badge FROM customer_bookings WHERE id='assignment-main'"
    );
    assert.deepEqual(currentB.rows[0], { licensing_authority_id: AUTHORITY_B, vehicle_license_badge: "HC-B-1" });

    for (const [id, driverId, vehicleLicenseId] of [
      ["assignment-mismatch-a-b-b", DRIVER_B_ID, vehicleLicenceB],
      ["assignment-mismatch-a-b-a", DRIVER_B_ID, vehicleALicence],
      ["assignment-mismatch-a-a-b", DRIVER_A_ID, vehicleLicenceB]
    ]) {
      const before = await query<any>(
        "SELECT vehicle_id, licensing_authority_id, vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id=$1",
        [id]
      );
      const auditBefore = await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM booking_assignment_audit WHERE booking_id=$1",
        [id]
      );
      await assert.rejects(assignBookingWithLicensing({
        bookingId: id,
        driverId,
        vehicleLicenseId,
        licensingAuthorityId: AUTHORITY_A,
        vehicleLicenseType: "hackney_carriage",
        actorId: ADMIN_ID
      }));
      const after = await query<any>(
        "SELECT vehicle_id, licensing_authority_id, vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id=$1",
        [id]
      );
      const auditAfter = await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM booking_assignment_audit WHERE booking_id=$1",
        [id]
      );
      assert.deepEqual(after.rows, before.rows);
      assert.equal(auditAfter.rows[0].count, auditBefore.rows[0].count);
    }

    const missingBadge = await assign("assignment-missing-badge", {
      driverId: DRIVER_A_ID, vehicleLicenseId: missingBadgeVehicleLicence, vehicleLicenseType: "private_hire",
      licensingAuthorityId: AUTHORITY_A
    });
    assert.equal(missingBadge.status, 302);
    const missingBadgePage = await fetch(await assignmentPageUrl(port, "assignment-missing-badge"));
    assert.match(await missingBadgePage.text(), /Missing vehicle licence badge/);
    const missingBadgeHistory = await fetch(`http://127.0.0.1:${port}/customers/${CUSTOMER_ID}/bookings`);
    assert.match(await missingBadgeHistory.text(), /Missing vehicle licence badge/);

    const unassign = await fetch(await assignmentPageUrl(port), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token, action: "unassign" }),
      redirect: "manual"
    });
    assert.equal(unassign.status, 302);
    const cleared = await query<any>(
      "SELECT vehicle_id, vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id='assignment-main'"
    );
    assert.deepEqual(cleared.rows[0], { vehicle_id: null, vehicle_license_type: null, vehicle_license_badge: null });
    const finalAudit = await query<any>(
      "SELECT action, actor_id, licensing_authority_id, vehicle_license_type, vehicle_license_badge FROM booking_assignment_audit WHERE booking_id='assignment-main' ORDER BY assigned_at, id"
    );
    assert.equal(finalAudit.rows.length, 4);
    assert.deepEqual(finalAudit.rows.slice(0, 3).map((row) => row.vehicle_license_badge), ["HC-A-1", "PH-A-1", "HC-B-1"]);
    assert.equal(finalAudit.rows[3].action, "vehicle_unassigned");
    assert.equal(finalAudit.rows[3].actor_id, ADMIN_ID);

    const importedPost = await fetch(await assignmentPageUrl(port, "imp-book-assignment-history"), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: token, action: "assign", driverId: DRIVER_A_ID, vehicleLicenseId: vehicleLicenceA,
        vehicleLicenseType: "hackney_carriage", licensingAuthorityId: AUTHORITY_A
      }),
      redirect: "manual"
    });
    assert.equal(importedPost.status, 404);
    assert.equal(await getBookingAssignmentPage("imp-book-assignment-history", CUSTOMER_ID), null);

    const beforeInvalid = await query<any>(
      "SELECT vehicle_id, licensing_authority_id, vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id='assignment-missing-badge'"
    );
    const auditBeforeInvalid = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM booking_assignment_audit WHERE booking_id='assignment-missing-badge'"
    );
    const rejectWithoutPartialWrite = async () => {
      const current = await query<any>(
        "SELECT vehicle_id, licensing_authority_id, vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id='assignment-missing-badge'"
      );
      const audit = await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM booking_assignment_audit WHERE booking_id='assignment-missing-badge'"
      );
      assert.deepEqual(current.rows, beforeInvalid.rows);
      assert.equal(audit.rows[0].count, auditBeforeInvalid.rows[0].count);
    };
    const rejectStoredDate = async (driverId = DRIVER_A_ID) => assert.rejects(assignBookingWithLicensing({
      bookingId: "assignment-missing-badge", driverId, vehicleLicenseId: missingBadgeVehicleLicence,
      licensingAuthorityId: AUTHORITY_A, vehicleLicenseType: "private_hire", actorId: ADMIN_ID
    }));
    const legacyBefore = await query<any>(
      "SELECT vehicle_id, licensing_authority_id, vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id='assignment-mismatch-a-a-b'"
    );
    await assert.rejects(assignBookingWithLicensing({
      bookingId: "assignment-mismatch-a-a-b", driverId: DRIVER_A_ID, vehicleLicenseId: vehicleLicenceA,
      licensingAuthorityId: LEGACY_ONLY_AUTHORITY, vehicleLicenseType: "hackney_carriage", actorId: ADMIN_ID
    }), /configured operator has no active/);
    assert.deepEqual((await query<any>(
      "SELECT vehicle_id, licensing_authority_id, vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id='assignment-mismatch-a-a-b'"
    )).rows, legacyBefore.rows);

    for (const status of ["draft", "suspended", "revoked", "expired"]) {
      await query("UPDATE operator_licences SET status=$2 WHERE id=$1", [operatorLicenceA, status]);
      await rejectStoredDate();
      await rejectWithoutPartialWrite();
    }
    await query("UPDATE operator_licences SET status='active', valid_from='2030-01-01' WHERE id=$1", [operatorLicenceA]);
    const tamperedDateAttempt = await assign("assignment-missing-badge", {
      driverId: DRIVER_A_ID, vehicleLicenseId: missingBadgeVehicleLicence, vehicleLicenseType: "private_hire",
      licensingAuthorityId: AUTHORITY_A, serviceDate: "2020-01-01"
    });
    assert.equal(tamperedDateAttempt.status, 400, "posted service dates do not override the stored booking date");
    await rejectWithoutPartialWrite();
    await query("UPDATE operator_licences SET valid_from='2020-01-01', valid_to='2026-11-15' WHERE id=$1", [operatorLicenceA]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE operator_licences SET status='active', valid_to=NULL WHERE id=$1", [operatorLicenceA]);

    await query("UPDATE licensing_authorities SET active=FALSE WHERE id=$1", [AUTHORITY_A]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE licensing_authorities SET active=TRUE WHERE id=$1", [AUTHORITY_A]);

    await query("UPDATE driver_licensing_authorities SET active=FALSE WHERE id=$1", [driverMainLicenceA]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE driver_licensing_authorities SET active=TRUE, revoked_at=$2 WHERE id=$1", [
      driverMainLicenceA, new Date().toISOString()
    ]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE driver_licensing_authorities SET revoked_at=NULL, valid_until='2026-11-15' WHERE id=$1", [driverMainLicenceA]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE driver_licensing_authorities SET valid_from='2030-01-01', valid_until=NULL WHERE id=$1", [driverMainLicenceA]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE driver_licensing_authorities SET valid_from='2020-01-01' WHERE id=$1", [driverMainLicenceA]);
    await query("UPDATE users SET status='Suspended' WHERE id=$1", [DRIVER_A_ID]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE users SET status='Active' WHERE id=$1", [DRIVER_A_ID]);

    await query("UPDATE vehicle_licensing_authorities SET active=FALSE WHERE id=$1", [missingBadgeVehicleLicence]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE vehicle_licensing_authorities SET active=TRUE, revoked_at=$2 WHERE id=$1", [
      missingBadgeVehicleLicence, new Date().toISOString()
    ]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE vehicle_licensing_authorities SET revoked_at=NULL, valid_until='2026-11-15' WHERE id=$1", [missingBadgeVehicleLicence]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE vehicle_licensing_authorities SET valid_from='2030-01-01', valid_until=NULL WHERE id=$1", [missingBadgeVehicleLicence]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE vehicle_licensing_authorities SET valid_from='2020-01-01' WHERE id=$1", [missingBadgeVehicleLicence]);

    await query("UPDATE vehicles SET status='inactive' WHERE id=$1", [vehicleMissingBadge]);
    await rejectStoredDate();
    await rejectWithoutPartialWrite();
    await query("UPDATE vehicles SET status='active' WHERE id=$1", [vehicleMissingBadge]);

    await unassignBookingVehicle({ bookingId: "assignment-missing-badge", actorId: ADMIN_ID });
    assert.ok((await query("SELECT id FROM booking_assignment_audit WHERE booking_id='assignment-missing-badge'")).rows.length);
  } finally {
    currentSession = adminSession;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await safeCleanupTestDatabase(dbContext);
  }
});
