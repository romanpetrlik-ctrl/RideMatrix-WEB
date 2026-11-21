import assert from "node:assert/strict";
import test from "node:test";
import { changeBookingStatus } from "./booking-dashboard";

test("cancelling an assigned booking releases its driver and vehicle in the same transaction", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: any = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT status, archived_at, service_date, driver_id, vehicle_id")) {
        return { rows: [{ status: "Accepted", archived_at: null, service_date: "2026-07-01", driver_id: "driver-1", vehicle_id: "vehicle-1" }] };
      }
      if (sql.includes("SELECT operator_id, driver_id FROM customer_bookings")) {
        return { rows: [{ operator_id: "operator-1", driver_id: "driver-1" }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };

  const result = await changeBookingStatus({
    bookingId: "booking-1",
    status: "Cancelled",
    reason: "Customer requested cancellation",
    actorId: "admin-1",
    actorEmail: "admin@example.test",
    now: new Date("2026-07-01T10:00:00.000Z")
  }, client);

  assert.equal(result, "updated");
  assert.ok(calls.some(({ sql, params }) =>
    sql.includes("UPDATE customer_bookings") && sql.includes("assignment_review_required=$6") && params[5] === false
  ));
  assert.ok(calls.some(({ sql }) => sql.includes("'vehicle_unassigned'")));
  assert.ok(calls.some(({ sql }) => sql.includes("UPDATE customer_bookings SET status = $2")));
  assert.ok(calls.some(({ sql, params }) =>
    sql.includes("INSERT INTO booking_status_audit") && params.includes("Customer requested cancellation")
  ));
});

test("completed and cancelled bookings cannot be moved to another workflow status", async () => {
  for (const status of ["Cancelled", "Completed", "No Show"]) {
    const client: any = {
      async query(sql: string) {
        if (sql.includes("SELECT status, archived_at, service_date, driver_id, vehicle_id")) {
          return { rows: [{ status, archived_at: null, service_date: "2026-07-01", driver_id: null, vehicle_id: null }] };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    assert.equal(await changeBookingStatus({
      bookingId: "booking-terminal",
      status: "Accepted",
      actorId: "admin-1",
      actorEmail: "admin@example.test"
    }, client), "not-changeable");
  }
});

test("marking an assigned booking as no show releases its driver and vehicle", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: any = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT status, archived_at, service_date, driver_id, vehicle_id")) {
        return { rows: [{ status: "Accepted", archived_at: null, service_date: "2026-07-01", driver_id: "driver-1", vehicle_id: "vehicle-1" }] };
      }
      if (sql.includes("SELECT operator_id, driver_id FROM customer_bookings")) {
        return { rows: [{ operator_id: "operator-1", driver_id: "driver-1" }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  assert.equal(await changeBookingStatus({
    bookingId: "booking-no-show",
    status: "No Show",
    actorId: "admin-1",
    actorEmail: "admin@example.test"
  }, client), "updated");
  assert.ok(calls.some(({ sql, params }) =>
    sql.includes("UPDATE customer_bookings")
      && sql.includes("assignment_review_required=$6")
      && params[5] === false
      && params.includes("Booking marked as no show.")
  ));
  assert.ok(calls.some(({ sql, params }) =>
    sql.includes("INSERT INTO booking_status_audit") && params.includes("No Show")
  ));
});

test("future bookings cannot be marked no show", async () => {
  const client: any = {
    async query(sql: string) {
      if (sql.includes("SELECT status, archived_at, service_date, driver_id, vehicle_id")) {
        return { rows: [{
          status: "Accepted",
          archived_at: null,
          service_date: "2026-07-02",
          driver_id: null,
          vehicle_id: null
        }] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  assert.equal(await changeBookingStatus({
    bookingId: "future-booking",
    status: "No Show",
    actorId: "admin-1",
    actorEmail: "admin@example.test",
    now: new Date("2026-07-01T10:00:00.000Z")
  }, client), "not-changeable");
});
