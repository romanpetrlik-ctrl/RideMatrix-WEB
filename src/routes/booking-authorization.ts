import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import {
  BookingAuthorizationDecision,
  BookingAuthorizationStatus,
  consumeBookingAuthorizationToken,
  getBookingAuthorizationTokenStatus
} from "../services/booking-authorization";

export type BookingAuthorizationRouterOptions = {
  appTitle: string;
  inspectToken?: typeof getBookingAuthorizationTokenStatus;
  consumeToken?: typeof consumeBookingAuthorizationToken;
};

/** Also mount before global CSRF so rejected submissions retain these protections. */
export const bookingAuthorizationResponseHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  next();
};

export function createBookingAuthorizationRouter(options: BookingAuthorizationRouterOptions): Router {
  const router = Router();
  const inspectToken = options.inspectToken ?? getBookingAuthorizationTokenStatus;
  const consumeToken = options.consumeToken ?? consumeBookingAuthorizationToken;
  router.use("/booking-authorization", bookingAuthorizationResponseHeaders, rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: "Too many authorization attempts. Please try again later."
  }));

  for (const action of ["approve", "decline"] as const) {
    const decision: BookingAuthorizationDecision = action === "approve" ? "approved" : "declined";
    const route = `/booking-authorization/:token/${action}`;
    router.get(route, async (req, res, next) => {
      try {
        const token = typeof req.params.token === "string" ? req.params.token : "";
        const status = await inspectToken(token);
        const statusCode = status === "invalid" ? 404 : status === "expired" ? 410 : 200;
        return res.status(statusCode).render("pages/booking-authorization", {
          appTitle: options.appTitle, status, action, outcome: "confirmation",
          csrfToken: req.csrf?.token ?? ""
        });
      } catch (error) {
        next(error);
      }
    });
    router.post(route, async (req, res, next) => {
      try {
        // Fail closed even if mounted without global CSRF or after deferred multipart validation.
        const submitted = req.body?._csrf ?? req.headers["x-csrf-token"];
        if (!req.csrf?.verify(submitted).valid) {
          return res.status(403).render("pages/booking-authorization", {
            appTitle: options.appTitle, status: "invalid", action, outcome: "csrf", csrfToken: ""
          });
        }
        const token = typeof req.params.token === "string" ? req.params.token : "";
        const result = await consumeToken(token, decision);
        const status: BookingAuthorizationStatus = result.status;
        return res.status(status === "invalid" ? 404 : status === "expired" ? 410 : 200)
          .render("pages/booking-authorization", {
            appTitle: options.appTitle, status, action, outcome: result.outcome, csrfToken: ""
          });
      } catch (error) {
        next(error);
      }
    });
  }
  return router;
}
