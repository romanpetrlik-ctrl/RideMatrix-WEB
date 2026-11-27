import { Router, type NextFunction, type Request, type Response } from "express";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, type SessionAccount } from "../services/api";
import { getEmailMessagingSettings, isEmailDeliveryConfigured } from "../services/email-templates";
import {
  getWhatsAppMessagingSwitch,
  getWhatsAppBookingEvent,
  getWhatsAppBookingNotificationSetting,
  listWhatsAppBookingNotificationSettings,
  saveWhatsAppMessagingSwitch,
  saveWhatsAppBookingNotificationSetting,
  WHATSAPP_BOOKING_EVENTS,
  WHATSAPP_PARAMETER_LABELS
} from "../services/whatsapp-booking-notifications";

type Options = {
  appTitle: string;
  loadSession?: (cookieHeader: string | undefined) => Promise<SessionAccount>;
};

const MESSAGING_PATH = "/settings/messaging";
const WHATSAPP_PATH = `${MESSAGING_PATH}/whatsapp`;
const TEMPLATES_PATH = `${WHATSAPP_PATH}/templates`;

function isWhatsAppApiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_API_VERSION"]
    .every((name) => Boolean(String(env[name] ?? "").trim()));
}

export type WhatsAppSettingsRouterOptions = Options & {
  getSwitch?: typeof getWhatsAppMessagingSwitch;
  saveSwitch?: typeof saveWhatsAppMessagingSwitch;
  listSettings?: typeof listWhatsAppBookingNotificationSettings;
  getEmailSettings?: typeof getEmailMessagingSettings;
  isApiConfigured?: () => boolean;
};

export function createWhatsAppBookingNotificationsRouter(options: WhatsAppSettingsRouterOptions): Router {
  const router = Router();
  const loadSession = options.loadSession ?? getSessionAccount;
  router.use(MESSAGING_PATH, noStoreProtectedResponse);
  const csrf = requireCsrfToken({ appTitle: options.appTitle });
  const getSwitch = options.getSwitch ?? getWhatsAppMessagingSwitch;
  const saveSwitch = options.saveSwitch ?? saveWhatsAppMessagingSwitch;
  const listSettings = options.listSettings ?? listWhatsAppBookingNotificationSettings;
  const getEmailSettings = options.getEmailSettings ?? getEmailMessagingSettings;
  const apiConfigured = options.isApiConfigured ?? (() => isWhatsAppApiConfigured());

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

  router.get(MESSAGING_PATH, requireSuperuser, async (req, res, next) => {
    try {
      const actor = res.locals.whatsAppSettingsActor as { id: string; email: string };
      const emailSettings = await getEmailSettings();
      return res.render("pages/messaging-settings", {
        title: "Messaging",
        appTitle: options.appTitle,
        email: actor.email,
        whatsapp: await getSwitch(),
        apiConfigured: apiConfigured(),
        emailEnabled: emailSettings.enabled,
        emailDeliveryMode: emailSettings.deliveryMode,
        emailDeliveryConfigured: isEmailDeliveryConfigured(emailSettings.deliveryMode)
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get(WHATSAPP_PATH, requireSuperuser, async (req, res, next) => {
    try {
      const actor = res.locals.whatsAppSettingsActor as { id: string; email: string };
      return res.render("pages/whatsapp-messaging-settings", {
        title: "WhatsApp",
        appTitle: options.appTitle,
        email: actor.email,
        setting: await getSwitch(),
        apiConfigured: apiConfigured(),
        notice: req.query.notice === "saved" ? "saved" : req.query.notice === "configuration-required" ? "configuration-required" : ""
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post(WHATSAPP_PATH, requireSuperuser, csrf, async (req, res, next) => {
    try {
      const actor = res.locals.whatsAppSettingsActor as { id: string; email: string };
      const enabled = req.body?.enabled === "on";
      if (enabled && !apiConfigured()) {
        return res.redirect(303, `${WHATSAPP_PATH}?notice=configuration-required`);
      }
      await saveSwitch({ enabled, actorId: actor.id, actorEmail: actor.email });
      return res.redirect(303, `${WHATSAPP_PATH}?notice=saved`);
    } catch (error) {
      return next(error);
    }
  });

  router.get(TEMPLATES_PATH, requireSuperuser, async (req, res, next) => {
    try {
      const actor = res.locals.whatsAppSettingsActor as { id: string; email: string };
      return res.render("pages/whatsapp-booking-notifications", {
        title: "WhatsApp templates",
        appTitle: options.appTitle,
        email: actor.email,
        basePath: TEMPLATES_PATH,
        events: WHATSAPP_BOOKING_EVENTS,
        settings: await listSettings(),
        whatsapp: await getSwitch(),
        apiConfigured: apiConfigured(),
        parameterLabels: WHATSAPP_PARAMETER_LABELS,
        notice: req.query.notice === "saved" ? "saved" : ""
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get(`${TEMPLATES_PATH}/:eventType`, requireSuperuser, async (req, res, next) => {
    try {
      const actor = res.locals.whatsAppSettingsActor as { id: string; email: string };
      const eventType = String(req.params.eventType);
      const setting = await getWhatsAppBookingNotificationSetting(eventType);
      if (!setting) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      return res.render("pages/whatsapp-booking-notification-event", {
        title: getWhatsAppBookingEvent(eventType)?.label ?? "WhatsApp booking notification",
        appTitle: options.appTitle,
        email: actor.email,
        basePath: TEMPLATES_PATH,
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

  router.post(`${TEMPLATES_PATH}/:eventType`, requireSuperuser, csrf, async (req, res, next) => {
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
      return res.redirect(303, `${TEMPLATES_PATH}/${encodeURIComponent(eventType)}?notice=saved`);
    } catch (error) {
      if (error instanceof TypeError) {
        return res.status(400).render("pages/whatsapp-booking-notification-event", {
          title: event.label,
          appTitle: options.appTitle,
          email: actor.email,
          basePath: TEMPLATES_PATH,
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

  router.get("/settings/messaging/whatsapp/booking-notifications", (_req, res) => {
    res.redirect(308, TEMPLATES_PATH);
  });

  return router;
}
