import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { initializeDatabase, query } from "../database/connection";
import { createTestDatabaseContext, safeCleanupTestDatabase, type TestDatabaseContext } from "../database/test-helper";
import { archiveBooking, listBookingDashboard } from "./booking-dashboard";
import { purgeCustomer } from "./customers";

let context: TestDatabaseContext | undefined;

before(async () => {
  context = await createTestDatabaseContext("test_booking_dashboard");
  await context.createAuthTables();
  await initializeDatabase();
});

after(async () => safeCleanupTestDatabase(context));

test("dashboard filters legacy timestamp dates by London service date and time", async () => {
  const now = new Date("2026-08-01T12:00:00Z");
  const customerId = "dashboard-legacy-date-customer";
  const createdAt = now.toISOString();
  await query(
    `INSERT INTO customers (id, given_name, surname, created_at, updated_at)
     VALUES ($1, 'Dashboard', 'Date', $2, $2)`,
    [customerId, createdAt]
  );
  await query(
    `INSERT INTO customer_bookings
       (id, customer_id, reference, service_date, pickup, dropoff, status, created_at)
     VALUES
       ('dashboard-legacy-today', $1, 'LEGACY-TODAY', '2026-08-01T08:15:00Z', 'A', 'B', 'Scheduled', $2),
       ('dashboard-legacy-boundary', $1, 'LEGACY-BOUNDARY', '2026-07-31T23:30:00Z', 'A', 'B', 'Scheduled', $2),
       ('dashboard-legacy-upcoming', $1, 'LEGACY-UPCOMING', '2026-08-01T23:30:00Z', 'A', 'B', 'Scheduled', $2)`,
    [customerId, createdAt]
  );

  const today = await listBookingDashboard("today", "", now);
  assert.deepEqual(
    today.filter((booking) => booking.customerId === customerId).map(({ reference, serviceDate, serviceTime }) => ({
      reference, serviceDate, serviceTime
    })),
    [
      { reference: "LEGACY-BOUNDARY", serviceDate: "2026-08-01", serviceTime: "00:30" },
      { reference: "LEGACY-TODAY", serviceDate: "2026-08-01", serviceTime: "09:15" }
    ]
  );
  const upcoming = await listBookingDashboard("upcoming", "", now);
  assert.ok(upcoming.some((booking) =>
    booking.id === "dashboard-legacy-upcoming" &&
    booking.serviceDate === "2026-08-02" &&
    booking.serviceTime === "00:30"
  ));
});

test("customer retention purge deletes archive audit rows with their bookings", async () => {
  const customerId = "dashboard-purge-customer";
  const bookingId = "dashboard-purge-booking";
  const now = new Date().toISOString();
  await query(
    `INSERT INTO customers (id, given_name, surname, created_at, updated_at, purge_after)
     VALUES ($1, 'Purge', 'Customer', $2, $2, $3)`,
    [customerId, now, new Date(Date.now() - 60_000).toISOString()]
  );
  await query(
    `INSERT INTO customer_bookings
       (id, customer_id, reference, service_date, pickup, dropoff, status, created_at)
     VALUES ($1, $2, 'PURGE-BOOKING', '2026-08-01', 'A', 'B', 'Scheduled', $3)`,
    [bookingId, customerId, now]
  );
  assert.equal(await archiveBooking({
    bookingId, reason: "Retention test", actorId: "test-admin", actorEmail: "admin@example.test"
  }), "archived");

  assert.equal(await purgeCustomer(customerId), true);
  const audit = await query("SELECT id FROM booking_archive_audit WHERE booking_id = $1", [bookingId]);
  assert.equal(audit.rows.length, 0);
});
