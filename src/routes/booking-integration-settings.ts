import { Router, type NextFunction, type Request, type Response } from "express";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount } from "../services/api";
import {
  getBookingIntegrationSettings,
  ONLINE_BOOKING_NOTICE_HOURS,
  saveMinimumOnlineNotice
} from "../services/booking-integration-settings";

type Options = { appTitle: string };

function integrationReadiness(env: NodeJS.ProcessEnv = process.env) {
  const configured = (names: string[]) => names.every((name) => Boolean(String(env[name] ?? "").trim()));
  const driverCalendarReady = Boolean(String(env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? "").trim()) &&
    Boolean(String(env.APP_BASE_URL ?? "").trim()) && (
    configured(["M365_TENANT_ID", "M365_DRIVER_CLIENT_ID", "M365_DRIVER_CLIENT_SECRET"]) ||
    configured(["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET"])
  );
  return [
    { name: "Stripe payment links", ready: configured(["APP_BASE_URL", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) },
    { name: "Amazon SES email", ready: configured(["SES_SMTP_HOST", "SES_SMTP_USERNAME", "SES_SMTP_PASSWORD", "SES_FROM_EMAIL"]) },
    { name: "WhatsApp Business", ready: configured([
      "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_API_VERSION",
      "WHATSAPP_BOOKING_REMINDER_TEMPLATE", "WHATSAPP_DRIVER_REMINDER_TEMPLATE", "WHATSAPP_LIVE_STATUS_TEMPLATE"
    ]) },
    { name: "Microsoft 365 dispatch calendar", ready: configured(["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET", "M365_CALENDAR_USER", "M365_CALENDAR_ID"]) },
    { name: "Driver calendar OAuth (Microsoft or Google)", ready: driverCalendarReady }
  ];
}

export function createBookingIntegrationSettingsRouter(options: Options): Router {
  const router = Router();
  router.use("/settings/booking-integrations", noStoreProtectedResponse);
  const csrf = requireCsrfToken({ appTitle: options.appTitle });

  const requireSuperuser = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect("/access");
      if (!session.user.roles.includes("superuser")) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }
      res.locals.integrationSettingsActor = { id: session.user.id, email: session.user.email };
      return next();
    } catch (error) {
      return next(error);
    }
  };

  router.get("/settings/booking-integrations", requireSuperuser, async (req, res, next) => {
    try {
      const actor = res.locals.integrationSettingsActor as { id: string; email: string };
      return res.render("pages/booking-integrations-settings", {
        title: "Booking integrations",
        appTitle: options.appTitle,
        email: actor.email,
        settings: await getBookingIntegrationSettings(),
        noticeHours: ONLINE_BOOKING_NOTICE_HOURS,
        integrations: integrationReadiness(),
        notice: req.query.notice === "saved" ? "saved" : req.query.notice === "invalid" ? "invalid" : ""
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/settings/booking-integrations", requireSuperuser, csrf, async (req, res, next) => {
    try {
      const actor = res.locals.integrationSettingsActor as { id: string; email: string };
      const hours = Number(req.body?.minimumOnlineNoticeHours);
      if (!ONLINE_BOOKING_NOTICE_HOURS.includes(hours as (typeof ONLINE_BOOKING_NOTICE_HOURS)[number])) {
        return res.redirect(303, "/settings/booking-integrations?notice=invalid");
      }
      await saveMinimumOnlineNotice({ hours, actorId: actor.id, actorEmail: actor.email });
      return res.redirect(303, "/settings/booking-integrations?notice=saved");
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
