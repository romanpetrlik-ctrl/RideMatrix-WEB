import assert from "node:assert/strict";
import test from "node:test";
import {
  addLicense,
  assignBookingWithLicensing,
  isLicenseActive,
  listVehicleLicenses,
  saveVehicleLicense,
  selectDeterministicAuthority,
  unassignBookingVehicle
} from "./licensing";

test("active license semantics reject future, expired, and revoked records", () => {
  const at = "2026-01-15T12:00:00.000Z";
  const base = { active: true, revokedAt: null, validFrom: "2026-01-01T00:00:00.000Z", validUntil: null };
  assert.equal(isLicenseActive(base, at), true);
  assert.equal(isLicenseActive({ ...base, validFrom: "2026-02-01T00:00:00.000Z" }, at), false);
  assert.equal(isLicenseActive({ ...base, validUntil: "2026-01-15T12:00:00.000Z" }, at), false);
  assert.equal(isLicenseActive({ ...base, revokedAt: "2026-01-10T00:00:00.000Z" }, at), false);
  assert.equal(isLicenseActive({ ...base, active: false }, at), false);
});

test("authority selection is deterministic and honors configured preference order", () => {
  const selected = selectDeterministicAuthority([
    { id: "dorset", name: "Dorset Council", preferenceOrder: 20 },
    { id: "bcp", name: "BCP Council", preferenceOrder: 10 }
  ]);
  assert.equal(selected?.id, "bcp");
  assert.equal(selectDeterministicAuthority([]), null);
});

test("vehicle licences retain distinct Hackney and Private Hire types, badges, and authority records", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: any = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT vla.*")) return { rows: [{
        id: "lic-1", vehicle_id: "vehicle-1", licensing_authority_id: "auth-1",
        authority_name: "Council", license_type: "hackney_carriage",
        vehicle_license_badge: "HC-001", license_reference: "REF-HC",
        valid_from: "2026-01-01", valid_until: null, active: true
      }] };
      return { rows: [], rowCount: 1 };
    }
  };
  await addLicense("vehicle", "vehicle-1", {
    licensingAuthorityId: "auth-1", licenseType: "hackney_carriage",
    vehicleLicenseBadge: " HC-001 ", licenseReference: "REF-HC", validFrom: "2026-01-01"
  }, client);
  await saveVehicleLicense("vehicle-1", {
    licensingAuthorityId: "auth-2", licenseType: "private_hire",
    vehicleLicenseBadge: "PH-002", licenseReference: "REF-PH", validFrom: "2026-02-01"
  }, undefined, client);
  const licenses = await listVehicleLicenses("vehicle-1", client);
  assert.equal(licenses[0].licenseType, "hackney_carriage");
  assert.equal(licenses[0].vehicleLicenseBadge, "HC-001");
  const inserts = calls.filter(({ sql }) => sql.includes("INSERT INTO vehicle_licensing_authorities"));
  assert.equal(inserts.length, 2);
  assert.ok(inserts.every(({ sql }) => sql.includes("license_type, vehicle_license_badge")));
  assert.ok(inserts.some(({ params }) => params.includes("private_hire")));
  assert.ok(inserts.some(({ params }) => params.includes("PH-002")));
  await assert.rejects(saveVehicleLicense("vehicle-1", {
    licensingAuthorityId: "auth-1", licenseType: "other" as any, validFrom: "2026-01-01"
  }, undefined, client), /Select Hackney Carriage or Private Hire/);
});

test("editing a vehicle licence is scoped to that vehicle and preserves the explicit badge value", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: any = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
  };
  const id = await saveVehicleLicense("vehicle-1", {
    licensingAuthorityId: "auth-1", licenseType: null,
    vehicleLicenseBadge: "HC-909", validFrom: "2026-01-01"
  }, "license-1", client);
  assert.equal(id, "license-1");
  assert.match(calls[0].sql, /WHERE id=\$1 AND vehicle_id=\$2/);
  assert.match(calls[0].sql, /license_type=CASE WHEN \$4::text IS NULL THEN license_type ELSE \$4::text END/);
  assert.match(calls[0].sql, /CASE WHEN \$11::boolean THEN NULL[\s\S]*WHEN \$5::text IS NULL THEN vehicle_license_badge ELSE \$5::text END/);
  assert.equal(calls[0].params[4], "HC-909");
  assert.equal(calls[0].params[3], null);
});

test("server-side booking assignment snapshots the matching type and badge and updates only that booking", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: any = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT service_date FROM customer_bookings")) return { rows: [{ service_date: "2026-07-01" }] };
      if (sql.includes("SELECT status FROM vehicles")) return { rows: [{ status: "active" }] };
      if (sql.includes("FROM operator_licensing_authorities")) return { rows: [{ licensing_authority_id: "auth-1", license_reference: "OP-1" }] };
      if (sql.includes("FROM driver_licensing_authorities")) return { rows: [{ licensing_authority_id: "auth-1", license_reference: "DR-1" }] };
      if (sql.includes("FROM vehicle_licensing_authorities") && sql.includes("SELECT l.licensing_authority_id")) {
        return { rows: [{ licensing_authority_id: "auth-1", license_reference: "VH-1" }] };
      }
      if (sql.includes("SELECT id, name, authority_type")) return { rows: [{
        id: "auth-1", name: "Council", authority_type: null, active: true, preference_order: 1
      }] };
      if (sql.includes("SELECT vehicle_license_badge")) {
        return { rows: [{ vehicle_license_badge: params[2] === "hackney_carriage" ? "HC-1" : null }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };

  await assignBookingWithLicensing({
    bookingId: "booking-1", operatorId: "operator-1", driverId: "driver-1",
    vehicleId: "vehicle-1", vehicleLicenseType: "hackney_carriage", actorId: "admin-1"
  }, client);
  await assignBookingWithLicensing({
    bookingId: "booking-1", operatorId: "operator-1", driverId: "driver-1",
    vehicleId: "vehicle-2", vehicleLicenseType: "private_hire", actorId: "admin-1"
  }, client);
  const updates = calls.filter(({ sql }) => sql.includes("UPDATE customer_bookings"));
  assert.equal(updates.length, 2);
  assert.match(updates[0].sql, /vehicle_license_type = \$10, vehicle_license_badge = \$11/);
  assert.equal(updates[0].params[9], "hackney_carriage");
  assert.equal(updates[0].params[10], "HC-1");
  assert.equal(updates[1].params[3], "vehicle-2");
  assert.equal(updates[1].params[9], "private_hire");
  assert.equal(updates[1].params[10], null, "missing badge is not invented");
  assert.ok(updates.every(({ sql }) => /WHERE id = \$1/.test(sql)), "only the currently assigned booking is updated");
  assert.ok(calls.some(({ sql, params }) =>
    sql.includes("INSERT INTO booking_assignment_audit") && params.includes("HC-1")
  ));
  const filteredVehicleLookup = calls.find(({ sql }) =>
    sql.includes("FROM vehicle_licensing_authorities") && sql.includes("SELECT l.licensing_authority_id")
  );
  assert.equal(filteredVehicleLookup?.params[2], "hackney_carriage");
});

test("booking vehicle removal clears its current badge snapshot and writes an audit record", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: any = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT operator_id, driver_id")) return { rows: [{ operator_id: "operator-1", driver_id: "driver-1" }] };
      return { rows: [], rowCount: 1 };
    }
  };
  await unassignBookingVehicle({ bookingId: "booking-1", actorId: "admin-1" }, client);
  const update = calls.find(({ sql }) => sql.includes("UPDATE customer_bookings"));
  assert.ok(update);
  assert.match(update.sql, /vehicle_id=NULL, licensing_authority_id=NULL, vehicle_license_type=NULL/);
  assert.match(update.sql, /vehicle_license_badge=NULL/);
  assert.equal(update.params[0], "booking-1");
  assert.ok(calls.some(({ sql }) => sql.includes("'vehicle_unassigned'")));
});
