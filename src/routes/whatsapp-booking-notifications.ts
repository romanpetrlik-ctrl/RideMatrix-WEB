import { Router, type NextFunction, type Request, type Response } from "express";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, type SessionAccount } from "../services/api";
import {
  getWhatsAppBookingEvent,
  getWhatsAppBookingNotificationSetting,
  listWhatsAppBookingNotificationSettings,
  saveWhatsAppBookingNotificationSetting,
  WHATSAPP_BOOKING_EVENTS,
  WHATSAPP_PARAMETER_LABELS
} from "../services/whatsapp-booking-notifications";

type Options = {
  appTitle: string;
  loadSession?: (cookieHeader: string | undefined) => Promise<SessionAccount>;
};

const BASE_PATH = "/settings/messaging/whatsapp/booking-notifications";

export function createWhatsAppBookingNotificationsRouter(options: Options): Router {
  const router = Router();
  const loadSession = options.loadSession ?? getSessionAccount;
  router.use("/settings/messaging/whatsapp", noStoreProtectedResponse);
  const csrf = requireCsrfToken({ appTitle: options.appTitle });

  const requireSuperuser = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect("/access");
      if (!session.user.roles.includes("superuser")) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }
      res.locals.whatsAppSettingsActor = { id: session.user.id, email: session.user.email };
      return next();
    } catch (error) {
      return next(error);
    }
  };

  router.get(BASE_PATH, requireSuperuser, async (req, res, next) => {
    try {
      const actor = res.locals.whatsAppSettingsActor as { id: string; email: string };
      return res.render("pages/whatsapp-booking-notifications", {
        title: "WhatsApp booking notifications",
        appTitle: options.appTitle,
        email: actor.email,
        basePath: BASE_PATH,
        events: WHATSAPP_BOOKING_EVENTS,
        settings: await listWhatsAppBookingNotificationSettings(),
        parameterLabels: WHATSAPP_PARAMETER_LABELS,
        notice: req.query.notice === "saved" ? "saved" : ""
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get(`${BASE_PATH}/:eventType`, requireSuperuser, async (req, res, next) => {
    try {
      const actor = res.locals.whatsAppSettingsActor as { id: string; email: string };
      const eventType = String(req.params.eventType);
      const setting = await getWhatsAppBookingNotificationSetting(eventType);
      if (!setting) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      return res.render("pages/whatsapp-booking-notification-event", {
        title: getWhatsAppBookingEvent(eventType)?.label ?? "WhatsApp booking notification",
        appTitle: options.appTitle,
        email: actor.email,
        basePath: BASE_PATH,
        event: getWhatsAppBookingEvent(eventType),
        setting,
        parameterLabels: WHATSAPP_PARAMETER_LABELS,
        notice: req.query.notice === "saved" ? "saved" : "",
        error: ""
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post(`${BASE_PATH}/:eventType`, requireSuperuser, csrf, async (req, res, next) => {
    const actor = res.locals.whatsAppSettingsActor as { id: string; email: string };
    const eventType = String(req.params.eventType);
    const event = getWhatsAppBookingEvent(eventType);
    if (!event) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
    try {
      await saveWhatsAppBookingNotificationSetting({
        eventType,
        enabled: req.body?.enabled === "on",
        templateName: String(req.body?.templateName ?? ""),
        templateLanguage: String(req.body?.templateLanguage ?? ""),
        actorId: actor.id,
        actorEmail: actor.email
      });
      return res.redirect(303, `${BASE_PATH}/${encodeURIComponent(eventType)}?notice=saved`);
    } catch (error) {
      if (error instanceof TypeError) {
        return res.status(400).render("pages/whatsapp-booking-notification-event", {
          title: event.label,
          appTitle: options.appTitle,
          email: actor.email,
          basePath: BASE_PATH,
          event,
          setting: {
            eventType,
            enabled: req.body?.enabled === "on",
            templateName: String(req.body?.templateName ?? "").trim() || null,
            templateLanguage: String(req.body?.templateLanguage ?? "").trim() || "en_GB",
            updatedAt: null,
            updatedByEmail: null
          },
          parameterLabels: WHATSAPP_PARAMETER_LABELS,
          notice: "",
          error: error.message
        });
      }
      return next(error);
    }
  });

  return router;
}
