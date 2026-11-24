import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import express from "express";
import type { SessionAccount } from "../services/api";
import type { BookingCalendarEvent, BookingCalendarScope } from "../services/booking-calendar";
import { createBookingCalendarRouter } from "./booking-calendar";

type Captured = { scope: BookingCalendarScope | null; from: string; to: string };

function sessionWith(roles: string[] | null, id = "acct-driver"): SessionAccount {
  return roles ? { authenticated: true, user: { id, email: `${id}@example.test`, roles } } : { authenticated: false };
}

const events: BookingCalendarEvent[] = [
  {
    id: "booking-1", reference: "RMB-000101", serviceDate: "2026-03-11", serviceTime: "09:30",
    startsAt: "2026-03-11T09:30:00.000Z", pickup: "Heathrow T5", dropoff: "Canary Wharf", status: "Driver assigned",
    liveStatus: "En route", driverName: "Sam Driver"
  },
  {
    id: "booking-2", reference: "RMB-000102", serviceDate: "2026-03-11", serviceTime: null,
    startsAt: null, pickup: "Gatwick", dropoff: "Croydon", status: "Cancelled", liveStatus: null, driverName: null
  }
];

async function withCalendar(
  options: { roles: string[] | null; query?: string; listEvents?: (scope: BookingCalendarScope, from: string, to: string) => Promise<BookingCalendarEvent[]>; captured?: Captured[] },
  run: (baseUrl: string) => Promise<void>
) {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/views"));
  app.use(createBookingCalendarRouter({
    appTitle: "Test",
    loadSession: async () => sessionWith(options.roles),
    now: () => new Date("2026-03-11T10:00:00Z"),
    listEvents: async (scope, from, to) => {
      options.captured?.push({ scope, from, to });
      return options.listEvents ? options.listEvents(scope, from, to) : events;
    }
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("calendar redirects anonymous users and rejects roles without booking visibility", async () => {
  await withCalendar({ roles: null }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/calendar`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
  });
  await withCalendar({ roles: ["customer"] }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/calendar`);
    assert.equal(response.status, 403);
  });
});

test("dispatchers see every booking with driver names and open the booking detail", async () => {
  const captured: Captured[] = [];
  await withCalendar({ roles: ["dispatcher"], captured }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/calendar?view=day&date=2026-03-11`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control")?.includes("no-store"), true);
    assert.deepEqual(captured[0].scope, { kind: "all" });
    assert.match(html, /href="\/bookings\/booking-1"/);
    assert.match(html, /Driver: Sam Driver/);
    assert.match(html, /RMB-000101/);
  });
});

test("drivers are scoped by their session account and cannot widen scope with query parameters", async () => {
  const captured: Captured[] = [];
  await withCalendar({ roles: ["driver"], captured }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/calendar?view=week&date=2026-03-11&driverId=someone-else&scope=all`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(captured[0].scope, { kind: "driver", driverId: "acct-driver" });
    assert.match(html, /href="\/driver"/);
    assert.doesNotMatch(html, /href="\/bookings\//);
    assert.doesNotMatch(html, /Driver: Sam Driver/);
  });
});

test("the displayed range uses the requested view and falls back to London today for invalid dates", async () => {
  const captured: Captured[] = [];
  await withCalendar({ roles: ["admin"], captured }, async (baseUrl) => {
    await fetch(`${baseUrl}/calendar?view=week&date=2026-03-11`).then((response) => response.text());
    assert.deepEqual([captured[0].from, captured[0].to], ["2026-03-09", "2026-03-15"]);
    const html = await fetch(`${baseUrl}/calendar?view=month&date=2026-13-45`).then((response) => response.text());
    assert.match(html, /data-date="2026-03-11"/);
    assert.match(html, /data-calendar-view="month"/);
  });
});

test("status changes are reflected in the rendered event on the next load", async () => {
  let status: BookingCalendarEvent["status"] = "Accepted";
  await withCalendar({
    roles: ["dispatcher"],
    listEvents: async () => [{ ...events[0], status, liveStatus: null, driverName: null }]
  }, async (baseUrl) => {
    const before = await fetch(`${baseUrl}/calendar?view=day&date=2026-03-11`).then((response) => response.text());
    assert.match(before, /booking-calendar__event--accepted/);
    status = "Cancelled";
    const after = await fetch(`${baseUrl}/calendar?view=day&date=2026-03-11`).then((response) => response.text());
    assert.match(after, /booking-calendar__event--cancelled/);
    assert.match(after, /data-status="Cancelled"/);
    assert.doesNotMatch(after, /booking-calendar__event--accepted/);
  });
});

test("mobile markup exposes an agenda layout that hides empty days below 700px", () => {
  const css = readFileSync(path.join(process.cwd(), "public/css/app.css"), "utf8");
  assert.match(css, /@media \(max-width: 699px\)[\s\S]*booking-calendar__day:not\(\.has-events\)/);
  assert.match(css, /@media \(max-width: 699px\)[\s\S]*booking-calendar__weekdays \{\s*display: none/);
});
