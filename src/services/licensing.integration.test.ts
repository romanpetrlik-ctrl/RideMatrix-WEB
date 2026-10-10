import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext, safeCleanupTestDatabase } from "../database/test-helper";
import { createLicensingAuthority, assignBookingWithLicensing, addLicense, saveVehicleLicense, unassignBookingVehicle } from "./licensing";
import { createVehicle } from "./vehicles";

const DRIVER_ID = "a0000000-0000-0000-0000-000000000002";

describe("vehicle licence booking assignment", () => {
  let dbContext: TestDatabaseContext | undefined;
  before(async () => {
    dbContext = await createTestDatabaseContext("test_vehicle_license_assignment");
    await dbContext.createAuthTables();
    await initializeDatabase();
    await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 2) ON CONFLICT DO NOTHING", [DRIVER_ID]);
  });
  after(async () => {
    await safeCleanupTestDatabase(dbContext);
  });

  test("snapshots the type-specific badge, preserves history, and clears on vehicle removal", async () => {
    const now = new Date().toISOString();
    const authority = await createLicensingAuthority({
    id: "test-assignment-authority", name: "Assignment Test Authority", preferenceOrder: 1
    });
    const vehicle = await createVehicle({
    registration: "TEST LICENCE 1", make: "Test", model: "Car", classKeys: ["standard_sedan_hatchback"],
    fuelType: "ICE", passengerCapacity: 4, status: "active"
    });
    const customerId = "test-license-booking-customer";
    await query(
    `INSERT INTO customers (id, given_name, surname, created_at, updated_at)
     VALUES ($1, 'Test', 'Customer', $2, $2)`,
    [customerId, now]
    );
    const bookingId = "test-license-booking";
    await query(
    `INSERT INTO customer_bookings
       (id, customer_id, reference, service_date, pickup, dropoff, status, total_fare_amount, created_at)
     VALUES ($1,$2,'TEST-LICENCE','2026-11-15','A','B','Scheduled',1.00,$3)`,
    [bookingId, customerId, now]
    );
    await addLicense("operator", "test-assignment-operator", {
    licensingAuthorityId: authority.id, validFrom: "2020-01-01"
    });
    await addLicense("driver", DRIVER_ID, {
    licensingAuthorityId: authority.id, validFrom: "2020-01-01"
    });
    const vehicleLicenseId = await saveVehicleLicense(vehicle.id, {
    licensingAuthorityId: authority.id, licenseType: "hackney_carriage",
    vehicleLicenseBadge: "HC-SNAPSHOT-1", validFrom: "2020-01-01"
    });
    assert.ok(vehicleLicenseId);
    const privateHireLicenseId = await saveVehicleLicense(vehicle.id, {
    licensingAuthorityId: authority.id, licenseType: "private_hire",
    vehicleLicenseBadge: "PH-SNAPSHOT-1", validFrom: "2020-01-01"
    });
    assert.ok(privateHireLicenseId);

  await assignBookingWithLicensing({
    bookingId, operatorId: "test-assignment-operator", driverId: DRIVER_ID,
    vehicleId: vehicle.id, vehicleLicenseType: "hackney_carriage", actorId: "test-admin"
  });
  let snapshot = await query<{ vehicle_license_type: string; vehicle_license_badge: string }>(
    "SELECT vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id=$1", [bookingId]
  );
  assert.deepEqual(snapshot.rows[0], {
    vehicle_license_type: "hackney_carriage", vehicle_license_badge: "HC-SNAPSHOT-1"
  });

    await saveVehicleLicense(vehicle.id, {
    licensingAuthorityId: authority.id, licenseType: "hackney_carriage",
    vehicleLicenseBadge: "HC-SNAPSHOT-2", validFrom: "2020-01-01"
    }, vehicleLicenseId);
    snapshot = await query(
    "SELECT vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id=$1", [bookingId]
    );
    assert.equal(snapshot.rows[0].vehicle_license_badge, "HC-SNAPSHOT-1", "vehicle edits do not rewrite the booking snapshot");

  await assignBookingWithLicensing({
    bookingId, operatorId: "test-assignment-operator", driverId: DRIVER_ID,
    vehicleId: vehicle.id, vehicleLicenseType: "hackney_carriage", actorId: "test-admin"
  });
  await assignBookingWithLicensing({
    bookingId, operatorId: "test-assignment-operator", driverId: DRIVER_ID,
    vehicleId: vehicle.id, vehicleLicenseType: "private_hire", actorId: "test-admin"
  });
  snapshot = await query(
    "SELECT vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id=$1", [bookingId]
  );
  assert.deepEqual(snapshot.rows[0], {
    vehicle_license_type: "private_hire", vehicle_license_badge: "PH-SNAPSHOT-1"
  });

    await saveVehicleLicense(vehicle.id, {
    licensingAuthorityId: authority.id, licenseType: "private_hire",
    vehicleLicenseBadge: null, validFrom: "2020-01-01"
    }, privateHireLicenseId, undefined);
    await assignBookingWithLicensing({
      bookingId, operatorId: "test-assignment-operator", driverId: DRIVER_ID,
      vehicleId: vehicle.id, vehicleLicenseType: "private_hire", actorId: "test-admin"
    });
    snapshot = await query(
      "SELECT vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id=$1", [bookingId]
    );
    assert.deepEqual(snapshot.rows[0], { vehicle_license_type: "private_hire", vehicle_license_badge: "PH-SNAPSHOT-1" });
    await saveVehicleLicense(vehicle.id, {
      licensingAuthorityId: authority.id, licenseType: "private_hire",
      vehicleLicenseBadge: null, clearVehicleLicenseBadge: true, validFrom: "2020-01-01"
    }, privateHireLicenseId);
    await assignBookingWithLicensing({
      bookingId, operatorId: "test-assignment-operator", driverId: DRIVER_ID,
      vehicleId: vehicle.id, vehicleLicenseType: "private_hire", actorId: "test-admin"
    });
    snapshot = await query(
      "SELECT vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id=$1", [bookingId]
    );
    assert.deepEqual(snapshot.rows[0], { vehicle_license_type: "private_hire", vehicle_license_badge: null });
    await unassignBookingVehicle({ bookingId, actorId: "test-admin" });
    const cleared = await query<{ vehicle_id: string | null; vehicle_license_badge: string | null; vehicle_license_type: string | null }>(
    "SELECT vehicle_id, vehicle_license_type, vehicle_license_badge FROM customer_bookings WHERE id=$1", [bookingId]
    );
    assert.deepEqual(cleared.rows[0], { vehicle_id: null, vehicle_license_type: null, vehicle_license_badge: null });
    const audit = await query<{ action: string; vehicle_license_type: string | null; vehicle_license_badge: string | null }>(
    "SELECT action, vehicle_license_type, vehicle_license_badge FROM booking_assignment_audit WHERE booking_id=$1 ORDER BY assigned_at, id",
    [bookingId]
    );
    assert.equal(audit.rows.length, 6);
    assert.ok(audit.rows.some((row) => row.vehicle_license_badge === "HC-SNAPSHOT-1"));
    assert.ok(audit.rows.some((row) => row.vehicle_license_badge === "HC-SNAPSHOT-2"));
    assert.ok(audit.rows.some((row) => row.vehicle_license_badge === "PH-SNAPSHOT-1"));
    assert.ok(audit.rows.some((row) => row.action === "vehicle_unassigned"));
  });
});
