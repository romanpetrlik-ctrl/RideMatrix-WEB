import { query } from "../database/connection";
import { SERVICE_TIMEZONE, serviceLocalToUtc } from "./new-bookings";

export const BOOKING_CALENDAR_VIEWS = ["month", "week", "day"] as const;
export type BookingCalendarView = (typeof BOOKING_CALENDAR_VIEWS)[number];

/** `all` is for roles that may see every booking; `driver` limits results to the driver's own assignments. */
export type BookingCalendarScope = { kind: "all" } | { kind: "driver"; driverId: string };

export type BookingCalendarEvent = {
  id: string;
  reference: string;
  serviceDate: string;
  serviceTime: string | null;
  startsAt: string | null;
  pickup: string;
  dropoff: string;
  status: string;
  liveStatus: string | null;
  driverName: string | null;
};

export type BookingCalendarDay = {
  date: string;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  events: BookingCalendarEvent[];
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts only a real YYYY-MM-DD calendar date. */
export function parseCalendarDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

export function parseBookingCalendarView(value: unknown): BookingCalendarView {
  return BOOKING_CALENDAR_VIEWS.includes(value as BookingCalendarView) ? value as BookingCalendarView : "month";
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** Monday = 0 … Sunday = 6, computed from the date string so no runtime timezone is involved. */
function mondayOffset(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Returns the inclusive list of local dates shown by the given view, anchored on `anchor` (YYYY-MM-DD). */
export function calendarDates(view: BookingCalendarView, anchor: string): string[] {
  if (view === "day") return [anchor];
  if (view === "week") {
    const start = addDays(anchor, -mondayOffset(anchor));
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }
  const firstOfMonth = `${anchor.slice(0, 8)}01`;
  const start = addDays(firstOfMonth, -mondayOffset(firstOfMonth));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function shiftCalendarAnchor(view: BookingCalendarView, anchor: string, direction: -1 | 1): string {
  if (view === "day") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, 7 * direction);
  const [year, month] = anchor.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + direction, 1));
  const day = Math.min(Number(anchor.slice(8, 10)), new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate());
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type CalendarBookingRow = {
  id: string;
  reference: string;
  service_date: string;
  service_time: string | null;
  service_timezone: string | null;
  pickup: string;
  dropoff: string;
  status: string;
  live_status: string | null;
  driver_name: string | null;
};

/**
 * Lists non-archived bookings in the date range. Driver scope is enforced in SQL by `driver_id`,
 * so callers must derive the scope from the server-side session, never from request parameters.
 * Driver names are only selected for the `all` scope.
 */
export async function listBookingCalendarEvents(
  scope: BookingCalendarScope,
  fromDate: string,
  toDate: string,
  run: typeof query = query
): Promise<BookingCalendarEvent[]> {
  const driverCondition = scope.kind === "driver" ? "AND b.driver_id = $3" : "";
  const params: string[] = [fromDate, toDate];
  if (scope.kind === "driver") params.push(scope.driverId);
  const result = await run<CalendarBookingRow>(
    `SELECT b.id, b.reference, b.service_date, b.service_time, b.service_timezone, b.pickup, b.dropoff,
            b.status, b.live_status,
            ${scope.kind === "all" ? "dp.short_name" : "NULL::text"} AS driver_name
       FROM customer_bookings b
       ${scope.kind === "all" ? "LEFT JOIN driver_profiles dp ON dp.driver_id = b.driver_id" : ""}
      WHERE b.archived_at IS NULL
        AND b.service_date BETWEEN $1 AND $2
        ${driverCondition}
      ORDER BY b.service_date ASC, b.service_time ASC NULLS LAST, b.reference ASC`,
    params
  );
  return result.rows.map((row) => mapCalendarBooking(row));
}

export function mapCalendarBooking(row: CalendarBookingRow): BookingCalendarEvent {
  const startsAt = row.service_time
    ? serviceLocalToUtc(row.service_date, row.service_time, row.service_timezone || SERVICE_TIMEZONE).toISOString()
    : null;
  return {
    id: row.id,
    reference: row.reference,
    serviceDate: row.service_date,
    serviceTime: row.service_time,
    startsAt,
    pickup: row.pickup,
    dropoff: row.dropoff,
    status: row.status,
    liveStatus: row.live_status,
    driverName: row.driver_name
  };
}

/** Builds the day grid for the view, placing each event on its local service date. */
export function buildCalendarDays(
  view: BookingCalendarView,
  anchor: string,
  events: BookingCalendarEvent[],
  today: string
): BookingCalendarDay[] {
  const byDate = new Map<string, BookingCalendarEvent[]>();
  for (const event of events) {
    const bucket = byDate.get(event.serviceDate) ?? [];
    bucket.push(event);
    byDate.set(event.serviceDate, bucket);
  }
  const anchorMonth = anchor.slice(0, 7);
  return calendarDates(view, anchor).map((date) => ({
    date,
    dayNumber: Number(date.slice(8, 10)),
    isCurrentMonth: date.startsWith(anchorMonth),
    isToday: date === today,
    events: byDate.get(date) ?? []
  }));
}
