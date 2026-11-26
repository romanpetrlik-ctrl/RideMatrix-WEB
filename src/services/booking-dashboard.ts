import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../database/connection";
import { unassignBookingVehicle } from "./licensing";
import { enqueueWhatsAppBookingLifecycleNotification } from "./whatsapp-booking-notifications";

export const BOOKING_DASHBOARD_VIEWS = ["today", "upcoming", "all", "finished", "cancelled", "archived", "no-show"] as const;
export type BookingDashboardView = (typeof BOOKING_DASHBOARD_VIEWS)[number];
export const BOOKING_WORKFLOW_STATUSES = [
  "New", "Under availability review", "Accepted", "Driver assigned", "Completed", "Cancelled", "No Show"
] as const;
export type BookingWorkflowStatus = (typeof BOOKING_WORKFLOW_STATUSES)[number];
export const BOOKING_LIVE_STATUSES = [
  "En route", "Waiting near pickup", "Arrived at pickup", "Passenger on board", "Journey started",
  "On break", "Resume journey", "Arrived at destination", "Extras payable", "Extras paid", "Ride finished"
] as const;
export type BookingLiveStatus = (typeof BOOKING_LIVE_STATUSES)[number];

export const BOOKING_OPERATIONAL_STATUS_COLORS = [
  ["New", "New"],
  ["Under availability review", "Under availability review"],
  ["Accepted", "Accepted"],
  ["Driver assigned", "Driver assigned"],
  ["Completed", "Completed"],
  ["Cancelled", "Cancelled"],
  ["No Show", "No Show"],
  ["Archived", "Archived"]
] as const;
export const BOOKING_LIVE_STATUS_COLORS = [
  ["Driver online", "Driver online"],
  ...BOOKING_LIVE_STATUSES.map((status) => [status, status] as const)
] as const;

export type BookingDashboardRecord = {
  id: string;
  customerId: string;
  reference: string;
  serviceDate: string;
  serviceTime: string | null;
  customerName: string;
  accountType: "Private" | "Corporate";
  passengerName: string;
  pickup: string;
  dropoff: string;
  status: string;
  assignmentStatus: string;
  driverId: string | null;
  driverName: string | null;
  vehicleRegistration: string | null;
  isTestBooking: boolean;
  totalFareAmount?: string | null;
  paymentMethod?: string | null;
  paymentLabel: string | null;
  pickupAddress: string;
  dropoffAddress: string;
  archivedAt?: string | null;
  archiveReason?: string | null;
  canMarkNoShow?: boolean;
  liveStatus?: string | null;
  driverOnline?: boolean;
  paymentStatus?: string;
  paymentDueAt?: string | null;
  extrasDescription?: string | null;
  extrasAmount?: string | null;
  extrasPaidAt?: string | null;
  driverNotes?: string | null;
  operationalColor?: string;
  liveColor?: string;
};

export type BookingIntegrationAlert = {
  id: string;
  bookingId: string;
  bookingReference: string;
  alertType: string;
  message: string;
  createdAt: string;
};

export async function listOpenBookingIntegrationAlerts(limit = 20): Promise<BookingIntegrationAlert[]> {
  const result = await query<{
    id: string;
    booking_id: string;
    reference: string;
    alert_type: string;
    message: string | null;
    created_at: string;
  }>(
    `SELECT a.id, a.booking_id, b.reference, a.alert_type, a.details->>'message' AS message, a.created_at
       FROM booking_integration_alerts a
       JOIN customer_bookings b ON b.id = a.booking_id
      WHERE a.resolved_at IS NULL
      ORDER BY a.created_at DESC, a.id
      LIMIT $1`,
    [Math.max(1, Math.min(100, Math.trunc(limit)))]
  );
  return result.rows.map((row) => ({
    id: row.id,
    bookingId: row.booking_id,
    bookingReference: row.reference,
    alertType: row.alert_type,
    message: row.message || row.alert_type,
    createdAt: row.created_at
  }));
}

export async function resolveBookingIntegrationAlert(input: {
  alertId: string;
  actorId: string;
  actorEmail: string;
}): Promise<boolean> {
  const result = await query(
    `UPDATE booking_integration_alerts
        SET resolved_at = CURRENT_TIMESTAMP, resolved_by_account_id = $2, resolved_by_email = $3
      WHERE id = $1 AND resolved_at IS NULL`,
    [input.alertId, input.actorId, input.actorEmail]
  );
  return Boolean(result.rowCount);
}

function europeanDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

// Managed POI/airport labels are stored as "<name> — <address>"; show only the address.
function stopAddress(label: string): string {
  const separatorIndex = label.indexOf(" — ");
  return separatorIndex === -1 ? label : label.slice(separatorIndex + 3);
}

const PAYMENT_LABELS: Record<string, string> = {
  "card-online": "Online",
  card: "Card",
  "bank-transfer": "Bank transfer",
  "payment-link": "Payment link",
  invoice: "Invoice"
};

function paymentLabel(method: string | null): string | null {
  return method ? (PAYMENT_LABELS[method] ?? method.replace(/-/g, " ")) : null;
}

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
  const viewCondition = view === "today"
    ? "b.archived_at IS NULL AND b.service_date = $2 AND b.status IN ('New', 'Under availability review', 'Accepted', 'Driver assigned')"
    : view === "upcoming"
      ? "b.archived_at IS NULL AND b.service_date > $2 AND b.status IN ('New', 'Under availability review', 'Accepted', 'Driver assigned')"
      : view === "all"
        ? "b.archived_at IS NULL"
        : view === "finished"
          ? "b.archived_at IS NULL AND b.status = 'Completed'"
          : view === "cancelled"
            ? "b.archived_at IS NULL AND b.status = 'Cancelled'"
            : view === "no-show"
              ? "b.archived_at IS NULL AND b.status = 'No Show'"
              : "b.archived_at IS NOT NULL";
  const order = view === "today" || view === "upcoming"
    ? "b.service_date ASC, b.service_time ASC NULLS LAST"
    : "b.service_date DESC, b.service_time DESC NULLS LAST";
  const result = await query<{
    id: string;
    customer_id: string;
    reference: string;
    service_date: string;
    service_time: string | null;
    customer_name: string;
    account_type: "Private" | "Corporate";
    passenger_name: string;
    pickup: string;
    dropoff: string;
    status: string;
    assignment_status: string;
    driver_id: string | null;
    driver_name: string | null;
    vehicle_registration: string | null;
    is_test_booking: boolean;
    total_fare_amount: string | number | null;
    payment_method: string | null;
    archived_at: string | null;
    archive_reason: string | null;
    can_mark_no_show: boolean;
    live_status: string | null;
    driver_online: boolean;
    payment_status: string;
    payment_due_at: string | null;
    extras_description: string | null;
    extras_amount: string | number | null;
    extras_paid_at: string | null;
    driver_notes: string | null;
    operational_color: string | null;
    live_color: string | null;
  }>(
    `SELECT b.id, b.customer_id, b.reference, b.service_date, b.service_time,
            COALESCE(NULLIF(btrim(b.booking_manager_name), ''),
                     NULLIF(btrim(concat_ws(' ', c.given_name, c.surname)), ''), 'Unknown customer') AS customer_name,
            CASE WHEN bc.customer_id IS NULL THEN 'Private' ELSE 'Corporate' END AS account_type,
            COALESCE(NULLIF(btrim(b.passenger_name), ''), NULLIF(btrim(b.booking_manager_name), ''),
                     NULLIF(btrim(concat_ws(' ', c.given_name, c.surname)), ''), 'Unknown passenger') AS passenger_name,
            b.pickup, b.dropoff, b.status, COALESCE(b.assignment_status, 'unassigned') AS assignment_status,
            b.driver_id, dp.short_name AS driver_name, v.registration AS vehicle_registration,
            COALESCE(b.is_test_booking, FALSE) AS is_test_booking,
            b.total_fare_amount, b.payment_method,
            b.archived_at, b.archive_reason, b.service_date <= $2 AS can_mark_no_show,
            b.live_status, COALESCE(dpres.online_until > CURRENT_TIMESTAMP, FALSE) AS driver_online,
            b.payment_status, b.payment_due_at, b.extras_description, b.extras_amount,
            b.extras_paid_at, b.driver_notes,
            (SELECT color_hex FROM booking_status_color_settings
              WHERE status_type = 'operational'
                AND status_key = CASE WHEN b.archived_at IS NOT NULL THEN 'Archived' ELSE b.status END) AS operational_color,
            (SELECT color_hex FROM booking_status_color_settings
              WHERE status_type = 'live'
                AND status_key = COALESCE(b.live_status, CASE WHEN dpres.online_until > CURRENT_TIMESTAMP THEN 'Driver online' END)) AS live_color
       FROM customer_bookings b
       JOIN customers c ON c.id = b.customer_id
       LEFT JOIN business_customers bc ON bc.customer_id = c.id
       LEFT JOIN driver_profiles dp ON dp.driver_id = b.driver_id
       LEFT JOIN vehicles v ON v.id = b.vehicle_id
       LEFT JOIN driver_presence dpres ON dpres.driver_id::text = b.driver_id
      WHERE ${viewCondition}
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
    serviceDate: europeanDate(row.service_date),
    serviceTime: row.service_time,
    customerName: row.customer_name,
    accountType: row.account_type,
    passengerName: row.passenger_name,
    pickup: row.pickup,
    pickupAddress: stopAddress(row.pickup),
    dropoff: row.dropoff,
    dropoffAddress: stopAddress(row.dropoff),
    paymentLabel: paymentLabel(row.payment_method),
    status: row.status,
    assignmentStatus: row.assignment_status,
    driverId: row.driver_id,
    driverName: row.driver_name,
    vehicleRegistration: row.vehicle_registration,
    isTestBooking: Boolean(row.is_test_booking),
    totalFareAmount: row.total_fare_amount === null ? null : Number(row.total_fare_amount).toFixed(2),
    paymentMethod: row.payment_method,
    archivedAt: row.archived_at,
    archiveReason: row.archive_reason,
    canMarkNoShow: row.can_mark_no_show,
    liveStatus: row.live_status,
    driverOnline: row.driver_online,
    paymentStatus: row.payment_status,
    paymentDueAt: row.payment_due_at,
    extrasDescription: row.extras_description,
    extrasAmount: row.extras_amount === null ? null : Number(row.extras_amount).toFixed(2),
    extrasPaidAt: row.extras_paid_at,
    driverNotes: row.driver_notes,
    operationalColor: row.operational_color ?? "#FFFFFF",
    liveColor: row.live_color ?? "transparent"
  }));
}

export async function listBookingStatusColors(): Promise<Array<{
  statusType: "operational" | "live";
  statusKey: string;
  displayLabel: string;
  colorHex: string;
}>> {
  const result = await query<{
    status_type: "operational" | "live";
    status_key: string;
    display_label: string;
    color_hex: string;
  }>(
    `SELECT status_type, status_key, display_label, color_hex
       FROM booking_status_color_settings
      ORDER BY CASE status_type WHEN 'operational' THEN 0 ELSE 1 END, display_label`
  );
  return result.rows.map((row) => ({
    statusType: row.status_type,
    statusKey: row.status_key,
    displayLabel: row.display_label,
    colorHex: row.color_hex
  }));
}

export async function saveBookingStatusColor(input: {
  statusType: "operational" | "live";
  statusKey: string;
  colorHex: string;
  actorId: string;
  actorEmail: string;
}): Promise<"updated" | "unchanged" | "not-found"> {
  const allowedStatuses = input.statusType === "operational"
    ? BOOKING_OPERATIONAL_STATUS_COLORS
    : BOOKING_LIVE_STATUS_COLORS;
  if (!allowedStatuses.some(([key]) => key === input.statusKey)) return "not-found";
  const colorHex = input.colorHex.trim();
  if (!/^#[0-9A-Fa-f]{6}$/.test(colorHex)) throw new TypeError("Enter a six-digit hexadecimal colour such as #AABBCC.");
  return withTransaction(async (client) => {
    const current = await client.query<{ color_hex: string }>(
      `SELECT color_hex FROM booking_status_color_settings
        WHERE status_type = $1 AND status_key = $2 FOR UPDATE`,
      [input.statusType, input.statusKey]
    );
    if (!current.rows[0]) return "not-found";
    if (current.rows[0].color_hex.toLowerCase() === colorHex.toLowerCase()) return "unchanged";
    await client.query(
      `UPDATE booking_status_color_settings
          SET color_hex = $3, updated_by_account_id = $4, updated_by_email = $5, updated_at = CURRENT_TIMESTAMP
        WHERE status_type = $1 AND status_key = $2`,
      [input.statusType, input.statusKey, colorHex.toUpperCase(), input.actorId, input.actorEmail]
    );
    await client.query(
      `INSERT INTO booking_status_color_audit
        (id, status_type, status_key, previous_color_hex, new_color_hex, actor_account_id, actor_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), input.statusType, input.statusKey, current.rows[0].color_hex,
        colorHex.toUpperCase(), input.actorId, input.actorEmail]
    );
    return "updated";
  });
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

export async function changeBookingStatus(input: {
  bookingId: string;
  status: BookingWorkflowStatus;
  reason?: string;
  actorId: string;
  actorEmail: string;
  now?: Date;
}, transactionClient?: PoolClient): Promise<"updated" | "unchanged" | "not-found" | "not-changeable"> {
  const reason = input.reason?.trim() ?? "";
  if (!BOOKING_WORKFLOW_STATUSES.includes(input.status)) {
    throw new TypeError("Choose a valid booking status.");
  }
  if (input.status === "Cancelled" && !reason) {
    throw new TypeError("Enter a reason to cancel this booking.");
  }
  if (reason.length > 500) throw new TypeError("A status reason must be no more than 500 characters.");

  const work = async (client: PoolClient) => {
    const existing = await client.query<{
      status: string;
      archived_at: string | null;
      service_date: string;
      driver_id: string | null;
      vehicle_id: string | null;
      live_status: string | null;
      extras_amount: string | null;
      extras_paid_at: string | null;
    }>(
      "SELECT status, archived_at, service_date, driver_id, vehicle_id, live_status, extras_amount, extras_paid_at FROM customer_bookings WHERE id = $1 FOR UPDATE",
      [input.bookingId]
    );
    const current = existing.rows[0];
    if (!current) return "not-found";
    if (current.archived_at) return "not-changeable";
    if (current.status === input.status) return "unchanged";
    if (current.status === "Cancelled" || current.status === "Completed" || current.status === "No Show") return "not-changeable";
    const allowedTransitions: Record<string, BookingWorkflowStatus[]> = {
      "New": ["Under availability review", "Accepted", "Cancelled", "No Show"],
      "Under availability review": ["New", "Accepted", "Cancelled", "No Show"],
      "Accepted": ["New", "Under availability review", "Cancelled", "No Show", "Driver assigned"],
      "Driver assigned": ["Accepted", "Cancelled", "No Show", "Completed"],
    };
    if (!allowedTransitions[current.status]?.includes(input.status)) return "not-changeable";
    if (input.status === "No Show" && current.service_date > serviceDate(input.now ?? new Date())) return "not-changeable";
    if (input.status === "Completed" && (current.live_status !== "Ride finished" ||
        (current.extras_amount !== null && !current.extras_paid_at))) return "not-changeable";
    if (input.status === "Driver assigned" && !current.driver_id) return "not-changeable";
    if (input.status === "Accepted" && current.driver_id) return "not-changeable";

    const changedAt = (input.now ?? new Date()).toISOString();
    if ((input.status === "Cancelled" || input.status === "No Show" || input.status === "Accepted") &&
        (current.driver_id || current.vehicle_id)) {
      await unassignBookingVehicle({
        bookingId: input.bookingId,
        actorId: input.actorId,
        source: input.status === "Cancelled" ? "booking-status-cancellation"
          : input.status === "No Show" ? "booking-status-no-show" : "booking-status-reopened",
        reason: input.status === "Cancelled" ? "Booking cancelled."
          : input.status === "No Show" ? "Booking marked as no show." : "Booking returned to accepted.",
        requireReview: false
      }, client);
      await client.query(
        "UPDATE customer_bookings SET driver_id = NULL WHERE id = $1",
        [input.bookingId]
      );
    }
    await client.query(
      "UPDATE customer_bookings SET status = $2 WHERE id = $1 AND archived_at IS NULL",
      [input.bookingId, input.status]
    );
    await client.query(
      `INSERT INTO booking_status_audit (
        id, booking_id, previous_status, new_status, reason, actor_user_id, actor_user_email, changed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(), input.bookingId, current.status, input.status,
        reason || null, input.actorId, input.actorEmail, changedAt
      ]
    );
    const lifecycleEvent = input.status === "Under availability review" ? "availability_review"
      : input.status === "Accepted" ? "booking_accepted" : null;
    if (lifecycleEvent) {
      await enqueueWhatsAppBookingLifecycleNotification(client, {
        bookingId: input.bookingId,
        eventType: lifecycleEvent,
        eventKey: input.status
      });
    }
    return "updated";
  };
  if (transactionClient) return work(transactionClient);
  return withTransaction(work);
}
