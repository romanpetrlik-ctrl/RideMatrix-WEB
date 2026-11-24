import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCalendarDays,
  calendarDates,
  listBookingCalendarEvents,
  mapCalendarBooking,
  parseCalendarDate,
  shiftCalendarAnchor,
  type BookingCalendarEvent
} from "./booking-calendar";

function event(overrides: Partial<BookingCalendarEvent>): BookingCalendarEvent {
  return {
    id: "b-1", reference: "RMB-000001", serviceDate: "2026-03-10", serviceTime: "09:00", startsAt: null,
    pickup: "Heathrow", dropoff: "Canary Wharf", status: "Accepted", liveStatus: null, driverName: null,
    ...overrides
  };
}

test("calendar dates reject impossible calendar values", () => {
  assert.equal(parseCalendarDate("2026-02-28"), "2026-02-28");
  assert.equal(parseCalendarDate("2026-02-30"), null);
  assert.equal(parseCalendarDate("2026-1-05"), null);
  assert.equal(parseCalendarDate(["2026-01-05"]), null);
});

test("month grid is six Monday-first weeks covering the anchor month", () => {
  const dates = calendarDates("month", "2026-03-15");
  assert.equal(dates.length, 42);
  assert.equal(dates[0], "2026-02-23");
  assert.equal(dates[41], "2026-04-05");
  assert.ok(dates.includes("2026-03-31"));
});

test("week view runs Monday to Sunday and day view is a single date", () => {
  assert.deepEqual(calendarDates("week", "2026-03-11"), [
    "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15"
  ]);
  assert.deepEqual(calendarDates("day", "2026-03-11"), ["2026-03-11"]);
});

test("month navigation clamps the day into the shorter target month", () => {
  assert.equal(shiftCalendarAnchor("month", "2026-01-31", 1), "2026-02-28");
  assert.equal(shiftCalendarAnchor("week", "2026-03-01", -1), "2026-02-22");
  assert.equal(shiftCalendarAnchor("day", "2026-12-31", 1), "2027-01-01");
});

test("bookings are placed on their local service date and marked today", () => {
  const events = [event({ id: "a", serviceDate: "2026-03-10" }), event({ id: "b", serviceDate: "2026-03-10", serviceTime: "07:30" })];
  const days = buildCalendarDays("week", "2026-03-11", events, "2026-03-11");
  const march10 = days.find((day) => day.date === "2026-03-10");
  assert.deepEqual(march10?.events.map((item) => item.id), ["a", "b"]);
  assert.equal(days.find((day) => day.date === "2026-03-11")?.isToday, true);
  assert.equal(days.find((day) => day.date === "2026-03-12")?.events.length, 0);
});

test("service times convert from Europe/London, switching offset at the BST boundary", () => {
  const winter = mapCalendarBooking({
    id: "w", reference: "R1", service_date: "2026-03-28", service_time: "09:00", service_timezone: null,
    pickup: "A", dropoff: "B", status: "Accepted", live_status: null, driver_name: null
  });
  const summer = mapCalendarBooking({
    id: "s", reference: "R2", service_date: "2026-03-29", service_time: "09:00", service_timezone: "Europe/London",
    pickup: "A", dropoff: "B", status: "Accepted", live_status: null, driver_name: null
  });
  assert.equal(winter.startsAt, "2026-03-28T09:00:00.000Z");
  assert.equal(summer.startsAt, "2026-03-29T08:00:00.000Z");
  assert.equal(summer.serviceDate, "2026-03-29");
});

test("bookings without a service time have no start instant", () => {
  const row = mapCalendarBooking({
    id: "n", reference: "R3", service_date: "2026-03-29", service_time: null, service_timezone: null,
    pickup: "A", dropoff: "B", status: "New", live_status: null, driver_name: null
  });
  assert.equal(row.startsAt, null);
});

test("driver scope filters by the session driver id and never selects driver names", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const run = (async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rows: [] };
  }) as unknown as Parameters<typeof listBookingCalendarEvents>[3];
  await listBookingCalendarEvents({ kind: "driver", driverId: "driver-acct" }, "2026-03-01", "2026-03-31", run);
  assert.match(calls[0].sql, /b\.driver_id = \$3/);
  assert.match(calls[0].sql, /b\.archived_at IS NULL/);
  assert.doesNotMatch(calls[0].sql, /driver_profiles/);
  assert.deepEqual(calls[0].params, ["2026-03-01", "2026-03-31", "driver-acct"]);
});

test("dispatch scope includes all non-archived bookings with driver names", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const run = (async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rows: [] };
  }) as unknown as Parameters<typeof listBookingCalendarEvents>[3];
  await listBookingCalendarEvents({ kind: "all" }, "2026-03-01", "2026-03-31", run);
  assert.doesNotMatch(calls[0].sql, /driver_id = \$3/);
  assert.match(calls[0].sql, /dp\.short_name/);
  assert.deepEqual(calls[0].params, ["2026-03-01", "2026-03-31"]);
});
