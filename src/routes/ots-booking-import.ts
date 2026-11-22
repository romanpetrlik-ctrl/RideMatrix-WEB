import { Router, type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, type SessionAccount } from "../services/api";
import {
  importOtsBookingFromLink,
  OtsBookingImportError,
  type OtsBookingSnapshot
} from "../services/ots-booking-import";

export type OtsBookingImportRouterOptions = {
  appTitle: string;
  loadSession?: (cookieHeader?: string) => Promise<SessionAccount>;
  importBooking?: typeof importOtsBookingFromLink;
};

class AuthorizationError extends Error {}

export function createOtsBookingImportRouter(options: OtsBookingImportRouterOptions): Router {
  const router = Router();
  router.use("/bookings/ots-import", noStoreProtectedResponse, (_req, res, next) => {
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  const loadSession = options.loadSession ?? getSessionAccount;
  const importBooking = options.importBooking ?? importOtsBookingFromLink;
  const csrfGuard = requireCsrfToken({ appTitle: options.appTitle });
  const submitRateLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 15,
    standardHeaders: true,
    legacyHeaders: false
  });

  const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) throw new AuthorizationError("unauthenticated");
      if (!Array.isArray(session.user.roles) || !session.user.roles.includes("admin")) {
        throw new AuthorizationError("forbidden");
      }
      res.locals.otsImportActor = { accountId: session.user.id, email: session.user.email };
      return next();
    } catch (error) {
      if (error instanceof AuthorizationError && error.message === "unauthenticated") {
        return req.method === "GET" ? res.redirect("/access") : res.status(401).json({ error: "Sign in again to continue." });
      }
      if (error instanceof AuthorizationError) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }
      return next(error);
    }
  };

  const renderImportPage = (
    res: Response,
    extras: {
      error?: string;
      duplicateReservationId?: string;
      snapshot?: OtsBookingSnapshot;
    } = {}
  ) => res.render("pages/bookings/ots-import", {
    title: "New OTS Booking",
    appTitle: options.appTitle,
    email: res.locals.otsImportActor.email,
    manualEntryHref: "/bookings/new",
    error: "",
    duplicateReservationId: "",
    snapshot: null,
    ...extras
  });

  router.get("/bookings/ots-import", requireAdmin, (_req, res) => renderImportPage(res));

  router.post("/bookings/ots-import", requireAdmin, submitRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const actor = res.locals.otsImportActor as { accountId: string; email: string };
      const sourceUrl = typeof req.body?.otsUrl === "string" ? req.body.otsUrl.trim() : "";
      try {
        const result = await importBooking(sourceUrl, actor);
        if (result.status === "duplicate") {
          return renderImportPage(res, { duplicateReservationId: result.reservationId });
        }
        return renderImportPage(res, { snapshot: result.snapshot });
      } catch (error) {
        if (error instanceof OtsBookingImportError) {
          return res.status(422).render("pages/bookings/ots-import", {
            title: "New OTS Booking",
            appTitle: options.appTitle,
            email: actor.email,
            manualEntryHref: "/bookings/new",
            error: error.message,
            duplicateReservationId: "",
            snapshot: null
          });
        }
        throw error;
      }
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
