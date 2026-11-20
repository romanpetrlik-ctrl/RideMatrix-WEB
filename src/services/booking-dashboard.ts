import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../database/connection";

export const BOOKING_DASHBOARD_VIEWS = ["today", "upcoming", "past"] as const;
export type BookingDashboardView = (typeof BOOKING_DASHBOARD_VIEWS)[number];

export type BookingDashboardRecord = {
  id: string;
  customerId: string;
  reference: string;
  serviceDate: string;
  serviceTime: string | null;
  customerName: string;
  pickup: string;
  dropoff: string;
  status: string;
  assignmentStatus: string;
  driverId: string | null;
  driverName: string | null;
  vehicleRegistration: string | null;
  isTestBooking: boolean;
};

function serviceDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export async function listBookingDashboard(
  view: BookingDashboardView,
  search: string,
  now = new Date()
): Promise<BookingDashboardRecord[]> {
  const selectedDate = serviceDate(now);
  const normalizedSearch = search.trim().slice(0, 100).toLocaleLowerCase("en-GB");
  const dateCondition = view === "today"
    ? "b.service_date = $2"
    : view === "upcoming"
      ? "b.service_date > $2"
      : "b.service_date < $2";
  const order = view === "past" ? "b.service_date DESC, b.service_time DESC NULLS LAST" : "b.service_date ASC, b.service_time ASC NULLS LAST";
  const result = await query<{
    id: string;
    customer_id: string;
    reference: string;
    service_date: string;
    service_time: string | null;
    customer_name: string;
    pickup: string;
    dropoff: string;
    status: string;
    assignment_status: string;
    driver_id: string | null;
    driver_name: string | null;
    vehicle_registration: string | null;
    is_test_booking: boolean;
  }>(
    `SELECT b.id, b.customer_id, b.reference, b.service_date, b.service_time,
            COALESCE(NULLIF(btrim(b.booking_manager_name), ''),
                     NULLIF(btrim(concat_ws(' ', c.given_name, c.surname)), ''), 'Unknown customer') AS customer_name,
            b.pickup, b.dropoff, b.status, COALESCE(b.assignment_status, 'unassigned') AS assignment_status,
            b.driver_id, dp.short_name AS driver_name, v.registration AS vehicle_registration,
            COALESCE(b.is_test_booking, FALSE) AS is_test_booking
       FROM customer_bookings b
       JOIN customers c ON c.id = b.customer_id
       LEFT JOIN driver_profiles dp ON dp.driver_id = b.driver_id
       LEFT JOIN vehicles v ON v.id = b.vehicle_id
      WHERE b.archived_at IS NULL
        AND ${dateCondition}
        AND (
          $1 = ''
          OR position($1 in lower(concat_ws(' ', b.reference, c.given_name, c.surname, b.booking_manager_name,
                 b.pickup, b.dropoff, b.status, dp.short_name, v.registration))) > 0
        )
      ORDER BY ${order}
      LIMIT 250`,
    [normalizedSearch, selectedDate]
  );
  return result.rows.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    reference: row.reference,
    serviceDate: row.service_date,
    serviceTime: row.service_time,
    customerName: row.customer_name,
    pickup: row.pickup,
    dropoff: row.dropoff,
    status: row.status,
    assignmentStatus: row.assignment_status,
    driverId: row.driver_id,
    driverName: row.driver_name,
    vehicleRegistration: row.vehicle_registration,
    isTestBooking: Boolean(row.is_test_booking)
  }));
}

export async function archiveBooking(input: {
  bookingId: string;
  reason: string;
  actorId: string;
  actorEmail: string;
  now?: Date;
}): Promise<"archived" | "not-found" | "already-archived"> {
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new TypeError("Enter an archive reason of no more than 500 characters.");
  return withTransaction(async (client) => {
    const archivedAt = (input.now ?? new Date()).toISOString();
    const updated = await client.query<{ id: string }>(
      `UPDATE customer_bookings
          SET archived_at = $2, archived_by_user_id = $3, archive_reason = $4
        WHERE id = $1 AND archived_at IS NULL
        RETURNING id`,
      [input.bookingId, archivedAt, input.actorId, reason]
    );
    if (!updated.rowCount) {
      const existing = await client.query<{ archived_at: string | null }>(
        "SELECT archived_at FROM customer_bookings WHERE id = $1",
        [input.bookingId]
      );
      return existing.rowCount ? "already-archived" : "not-found";
    }
    await client.query(
      `INSERT INTO booking_archive_audit (id, booking_id, actor_user_id, actor_user_email, reason, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), input.bookingId, input.actorId, input.actorEmail, reason, archivedAt]
    );
    return "archived";
  });
}
