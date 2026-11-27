import { Router, type NextFunction, type Request, type Response } from "express";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, type SessionAccount } from "../services/api";
import {
  EMAIL_TEMPLATE_EVENTS,
  EMAIL_TEMPLATE_VARIABLES,
  getEmailMessagingSettings,
  getEmailTemplate,
  isEmailDeliveryConfigured,
  listEmailTemplates,
  renderEmailTemplate,
  saveEmailMessagingSettings,
  saveEmailTemplate,
  type EmailTemplate
} from "../services/email-templates";
import type { EmailDeliveryMode } from "../services/email-templates";

type Options = {
  appTitle: string;
  loadSession?: (cookieHeader: string | undefined) => Promise<SessionAccount>;
  getSettings?: typeof getEmailMessagingSettings;
  saveSettings?: typeof saveEmailMessagingSettings;
  listTemplates?: typeof listEmailTemplates;
  getTemplate?: typeof getEmailTemplate;
  saveTemplate?: typeof saveEmailTemplate;
  isDeliveryConfigured?: (mode: EmailDeliveryMode) => boolean;
};

const BASE_PATH = "/settings/messaging/email";
const TEMPLATE_PATH = `${BASE_PATH}/templates`;

export function createEmailSettingsRouter(options: Options): Router {
  const router = Router();
  const loadSession = options.loadSession ?? getSessionAccount;
  const getSettings = options.getSettings ?? getEmailMessagingSettings;
  const saveSettings = options.saveSettings ?? saveEmailMessagingSettings;
  const listTemplates = options.listTemplates ?? listEmailTemplates;
  const getTemplate = options.getTemplate ?? getEmailTemplate;
  const saveTemplate = options.saveTemplate ?? saveEmailTemplate;
  const isDeliveryConfigured = options.isDeliveryConfigured ?? ((mode) => isEmailDeliveryConfigured(mode));
  router.use(BASE_PATH, noStoreProtectedResponse);
  const csrf = requireCsrfToken({ appTitle: options.appTitle });

  const requireSuperuser = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect("/access");
      if (!session.user.roles.includes("superuser")) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }
      res.locals.emailSettingsActor = { id: session.user.id, email: session.user.email };
      return next();
    } catch (error) {
      return next(error);
    }
  };

  router.get(BASE_PATH, requireSuperuser, async (req, res, next) => {
    try {
      return res.render("pages/email-messaging-settings", {
        title: "Email",
        appTitle: options.appTitle,
        email: (res.locals.emailSettingsActor as { email: string }).email,
        setting: await getSettings(),
        sesConfigured: isDeliveryConfigured("ses"),
        mailpitConfigured: isDeliveryConfigured("mailpit"),
        notice: ["saved", "configuration-required", "mode-change-requires-off", "invalid-mode"]
          .includes(String(req.query.notice)) ? String(req.query.notice) : ""
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post(BASE_PATH, requireSuperuser, csrf, async (req, res, next) => {
    const actor = res.locals.emailSettingsActor as { id: string; email: string };
    const enabled = req.body?.enabled === "on";
    try {
      const deliveryMode = String(req.body?.deliveryMode ?? "");
      if (deliveryMode !== "ses" && deliveryMode !== "mailpit") {
        return res.redirect(303, `${BASE_PATH}?notice=invalid-mode`);
      }
      const current = await getSettings();
      if (current.enabled && current.deliveryMode !== deliveryMode) {
        return res.redirect(303, `${BASE_PATH}?notice=mode-change-requires-off`);
      }
      if (enabled && !isDeliveryConfigured(deliveryMode)) {
        return res.redirect(303, `${BASE_PATH}?notice=configuration-required`);
      }
      await saveSettings({ enabled, deliveryMode, actorId: actor.id, actorEmail: actor.email });
      return res.redirect(303, `${BASE_PATH}?notice=saved`);
    } catch (error) {
      return next(error);
    }
  });

  router.get(TEMPLATE_PATH, requireSuperuser, async (req, res, next) => {
    try {
      return res.render("pages/email-templates", {
        title: "Email templates",
        appTitle: options.appTitle,
        email: (res.locals.emailSettingsActor as { email: string }).email,
        templates: await listTemplates(),
        notice: req.query.notice === "saved" ? "saved" : ""
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get(`${TEMPLATE_PATH}/:eventType`, requireSuperuser, async (req, res, next) => {
    try {
      const template = await getTemplate(String(req.params.eventType));
      if (!template) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      const sampleValues = {
        payerName: "Alex Passenger",
        reference: "RM-2030",
        paymentUrl: "https://checkout.stripe.com/example",
        amount: "125.00",
        currency: "GBP"
      };
      return res.render("pages/email-template-edit", {
        title: "Edit email template",
        appTitle: options.appTitle,
        email: (res.locals.emailSettingsActor as { email: string }).email,
        template,
        variables: EMAIL_TEMPLATE_VARIABLES,
        preview: {
          subject: renderEmailTemplate(template.subjectTemplate, sampleValues),
          body: renderEmailTemplate(template.bodyTemplate, sampleValues)
        },
        notice: req.query.notice === "saved" ? "saved" : "",
        error: ""
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post(`${TEMPLATE_PATH}/:eventType`, requireSuperuser, csrf, async (req, res, next) => {
    const actor = res.locals.emailSettingsActor as { id: string; email: string };
    const eventType = String(req.params.eventType);
    const input = {
      eventType,
      subjectTemplate: String(req.body?.subjectTemplate ?? ""),
      bodyTemplate: String(req.body?.bodyTemplate ?? ""),
      actorId: actor.id,
      actorEmail: actor.email
    };
    if (!EMAIL_TEMPLATE_EVENTS.includes(eventType as (typeof EMAIL_TEMPLATE_EVENTS)[number])) {
      return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
    }
    try {
      await saveTemplate(input);
      return res.redirect(303, `${TEMPLATE_PATH}/${encodeURIComponent(eventType)}?notice=saved`);
    } catch (error) {
      if (error instanceof TypeError) {
        const template: EmailTemplate = {
          eventType: eventType as EmailTemplate["eventType"],
          subjectTemplate: input.subjectTemplate,
          bodyTemplate: input.bodyTemplate,
          updatedAt: null,
          updatedByEmail: null
        };
        const sampleValues = {
          payerName: "Alex Passenger",
          reference: "RM-2030",
          paymentUrl: "https://checkout.stripe.com/example",
          amount: "125.00",
          currency: "GBP"
        };
        return res.status(400).render("pages/email-template-edit", {
          title: "Edit email template",
          appTitle: options.appTitle,
          email: actor.email,
          template,
          variables: EMAIL_TEMPLATE_VARIABLES,
          preview: {
            subject: renderEmailTemplate(template.subjectTemplate, sampleValues),
            body: renderEmailTemplate(template.bodyTemplate, sampleValues)
          },
          notice: "",
          error: error.message
        });
      }
      return next(error);
    }
  });

  return router;
}
