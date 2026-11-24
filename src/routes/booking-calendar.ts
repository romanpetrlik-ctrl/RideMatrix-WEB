import { Router, type NextFunction, type Request, type Response } from "express";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, type SessionAccount } from "../services/api";
import {
  buildCalendarDays,
  calendarDates,
  listBookingCalendarEvents,
  parseBookingCalendarView,
  parseCalendarDate,
  shiftCalendarAnchor,
  type BookingCalendarEvent,
  type BookingCalendarScope
} from "../services/booking-calendar";
import { formatInServiceTimezone } from "../services/new-bookings";

export const CALENDAR_ALL_SCOPE_ROLES = ["admin", "dispatcher"] as const;

type BookingCalendarRouterOptions = {
  appTitle: string;
  loadSession?: (cookieHeader?: string) => Promise<SessionAccount>;
  listEvents?: (scope: BookingCalendarScope, fromDate: string, toDate: string) => Promise<BookingCalendarEvent[]>;
  now?: () => Date;
};

/** Resolves the calendar scope from the server-side session. Returns null when the user may not view the calendar. */
export function calendarScopeForSession(session: SessionAccount): BookingCalendarScope | null {
  if (!session.authenticated || !session.user) return null;
  const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
  if (roles.some((role) => (CALENDAR_ALL_SCOPE_ROLES as readonly string[]).includes(role))) return { kind: "all" };
  if (roles.includes("driver")) return { kind: "driver", driverId: session.user.id };
  return null;
}

export function createBookingCalendarRouter(options: BookingCalendarRouterOptions): Router {
  const router = Router();
  const loadSession = options.loadSession ?? getSessionAccount;
  const listEvents = options.listEvents ?? listBookingCalendarEvents;
  const now = options.now ?? (() => new Date());
  router.use("/calendar", noStoreProtectedResponse);

  router.get("/calendar", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect("/access");
      const scope = calendarScopeForSession(session);
      if (!scope) return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });

      const today = formatInServiceTimezone(now()).slice(0, 10);
      const view = parseBookingCalendarView(req.query.view);
      const anchor = parseCalendarDate(req.query.date) ?? today;
      const dates = calendarDates(view, anchor);
      const events = await listEvents(scope, dates[0], dates[dates.length - 1]);
      const days = buildCalendarDays(view, anchor, events, today);
      const isDriverView = scope.kind === "driver";

      return res.render("pages/bookings/calendar", {
        title: "Booking calendar",
        appTitle: options.appTitle,
        email: session.user.email,
        view,
        anchor,
        today,
        days,
        isDriverView,
        eventCount: events.length,
        previousHref: calendarHref(view, shiftCalendarAnchor(view, anchor, -1)),
        nextHref: calendarHref(view, shiftCalendarAnchor(view, anchor, 1)),
        todayHref: calendarHref(view, today),
        viewLinks: ["month", "week", "day"].map((item) => ({
          key: item,
          label: item.charAt(0).toUpperCase() + item.slice(1),
          href: calendarHref(item as typeof view, anchor),
          active: item === view
        })),
        periodLabel: periodLabel(view, anchor),
        eventHref: (event: BookingCalendarEvent) => (isDriverView ? "/driver" : `/bookings/${encodeURIComponent(event.id)}`),
        eventTime: (event: BookingCalendarEvent) => (event.startsAt ? formatInServiceTimezone(event.startsAt).slice(11) : ""),
        statusSlug: (status: string) => status.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function calendarHref(view: string, date: string): string {
  return `/calendar?view=${view}&date=${date}`;
}

function periodLabel(view: string, anchor: string): string {
  const [year, month, day] = anchor.split("-").map(Number);
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });
  if (view === "month") return formatter.format(new Date(Date.UTC(year, month - 1, 1)));
  if (view === "day") {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" })
      .format(new Date(Date.UTC(year, month - 1, day)));
  }
  const start = new Date(Date.UTC(year, month - 1, day));
  const offset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - offset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const short = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
  return `${short.format(start)} – ${short.format(end)}, ${end.getUTCFullYear()}`;
}
