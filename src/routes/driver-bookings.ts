import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, type SessionAccount } from "../services/api";
import {
  getDriverWhatsAppSettings,
  listDriverBookings,
  isDriverOnline,
  saveDriverWhatsAppSettings,
  setDriverOffline,
  setDriverOnline,
  updateDriverBookingStatus
} from "../services/driver-bookings";
import { BOOKING_LIVE_STATUSES, type BookingLiveStatus } from "../services/booking-dashboard";
import {
  beginDriverCalendarOAuth,
  calendarOAuthProvider,
  completeDriverCalendarOAuth,
  disconnectDriverCalendar,
  getDriverCalendarConnection
} from "../services/booking-calendars";

export type DriverBookingsRouterOptions = {
  appTitle: string;
  loadSession?: (cookieHeader?: string) => Promise<SessionAccount>;
};

function isDriver(session: SessionAccount): boolean {
  return session.authenticated && Boolean(session.user) &&
    Array.isArray(session.user?.roles) && session.user.roles.includes("driver");
}

export function createDriverBookingsRouter(options: DriverBookingsRouterOptions): Router {
  const router = Router();
  const loadSession = options.loadSession ?? getSessionAccount;
  const csrfGuard = requireCsrfToken({ appTitle: options.appTitle });
  const updateLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false
  });
  router.use("/driver", noStoreProtectedResponse);

  router.get("/driver", async (req, res, next) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect(303, "/access");
      if (!isDriver(session)) return res.status(403).render("pages/unavailable", { title: "Access", appTitle: options.appTitle });
      return res.render("pages/driver-bookings", {
        title: "Driver journey board",
        appTitle: options.appTitle,
        bookings: await listDriverBookings(session.user.id),
        driverOnline: await isDriverOnline(session.user.id),
        whatsappSettings: await getDriverWhatsAppSettings(session.user.id),
        calendarConnection: await getDriverCalendarConnection(session.user.id),
        notice: req.query.notice === "updated" || req.query.notice === "online" || req.query.notice === "offline" ||
          req.query.notice === "calendar-connected" || req.query.notice === "calendar-disconnected" ||
          req.query.notice === "whatsapp-saved" ||
          req.query.notice === "calendar-error" || req.query.notice === "invalid" || req.query.notice === "not-changeable"
          ? req.query.notice : "",
        email: session.user.email,
        liveStatuses: BOOKING_LIVE_STATUSES
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/driver/calendar/connect/:provider", async (req, res, next) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect(303, "/access");
      if (!isDriver(session)) return res.status(403).render("pages/unavailable", { title: "Access", appTitle: options.appTitle });
      const authorizationUrl = await beginDriverCalendarOAuth(session.user.id, String(req.params.provider));
      return res.redirect(302, authorizationUrl);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/driver/calendar/callback/:provider", async (req, res, next) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect(303, "/access");
      if (!isDriver(session)) return res.status(403).render("pages/unavailable", { title: "Access", appTitle: options.appTitle });
      const provider = calendarOAuthProvider(String(req.params.provider));
      if (req.query.error || typeof req.query.state !== "string" || typeof req.query.code !== "string") {
        return res.redirect(303, "/driver?notice=calendar-error");
      }
      await completeDriverCalendarOAuth({
        driverId: session.user.id,
        providerInput: provider,
        state: req.query.state,
        code: req.query.code
      });
      return res.redirect(303, "/driver?notice=calendar-connected");
    } catch (error) {
      return next(error);
    }
  });

  router.post("/driver/calendar/disconnect", updateLimiter, csrfGuard, async (req, res, next) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect(303, "/access");
      if (!isDriver(session)) return res.status(403).render("pages/unavailable", { title: "Access", appTitle: options.appTitle });
      await disconnectDriverCalendar(session.user.id);
      return res.redirect(303, "/driver?notice=calendar-disconnected");
    } catch (error) {
      return next(error);
    }
  });

  router.post("/driver/whatsapp", updateLimiter, csrfGuard, async (req, res, next) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect(303, "/access");
      if (!isDriver(session)) return res.status(403).render("pages/unavailable", { title: "Access", appTitle: options.appTitle });
      await saveDriverWhatsAppSettings({
        driverId: session.user.id,
        phone: typeof req.body?.whatsappPhone === "string" ? req.body.whatsappPhone : "",
        optedIn: req.body?.whatsappOptIn === "yes"
      });
      return res.redirect(303, "/driver?notice=whatsapp-saved");
    } catch (error) {
      return next(error);
    }
  });

  router.post("/driver/presence", updateLimiter, csrfGuard, async (req, res, next) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect(303, "/access");
      if (!isDriver(session)) return res.status(403).render("pages/unavailable", { title: "Access", appTitle: options.appTitle });
      if (req.body?.action === "online") {
        await setDriverOnline(session.user.id);
        return res.redirect(303, "/driver?notice=online");
      }
      if (req.body?.action === "offline") {
        await setDriverOffline(session.user.id);
        return res.redirect(303, "/driver?notice=offline");
      }
      return res.status(400).render("pages/unavailable", { title: "Invalid request", appTitle: options.appTitle });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/driver/bookings/:bookingId/status", updateLimiter, csrfGuard, async (req, res, next) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect(303, "/access");
      if (!isDriver(session)) return res.status(403).render("pages/unavailable", { title: "Access", appTitle: options.appTitle });
      const statusText = typeof req.body?.status === "string" ? req.body.status : "";
      if (!BOOKING_LIVE_STATUSES.includes(statusText as BookingLiveStatus)) {
        return res.redirect(303, "/driver?notice=invalid");
      }
      const result = await updateDriverBookingStatus({
        bookingId: String(req.params.bookingId),
        driverId: session.user.id,
        actorEmail: session.user.email,
        status: statusText as BookingLiveStatus,
        extrasDescription: typeof req.body?.extrasDescription === "string" ? req.body.extrasDescription : "",
        extrasAmount: typeof req.body?.extrasAmount === "string" ? req.body.extrasAmount : "",
        driverNotes: typeof req.body?.driverNotes === "string" ? req.body.driverNotes : ""
      });
      if (result === "not-found") return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      return res.redirect(303, `/driver?notice=${result === "updated" ? "updated" : "not-changeable"}`);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
