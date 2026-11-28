import { Router, type NextFunction, type Request, type Response } from "express";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount } from "../services/api";
import {
  getBookingIntegrationSettings,
  ONLINE_BOOKING_NOTICE_HOURS,
  saveMinimumOnlineNotice
} from "../services/booking-integration-settings";
import { getStripeSettingsSummary } from "../services/stripe-settings";
import { getEmailMessagingSettings } from "../services/email-templates";
import {
  getMicrosoftDispatchCalendarSettings,
  saveMicrosoftDispatchCalendarCredentials,
  setMicrosoftDispatchCalendarEnabled,
  testMicrosoftDispatchCalendarConnection,
  type MicrosoftDispatchCalendarSettings
} from "../services/microsoft-dispatch-calendar-settings";
import type { SessionAccount } from "../services/api";

type Options = {
  appTitle: string;
  loadSession?: (cookieHeader?: string) => Promise<SessionAccount>;
  getBookingSettings?: typeof getBookingIntegrationSettings;
  saveMinimumNotice?: typeof saveMinimumOnlineNotice;
  getStripeSummary?: typeof getStripeSettingsSummary;
  getEmailSettings?: typeof getEmailMessagingSettings;
  getDispatchCalendarSettings?: typeof getMicrosoftDispatchCalendarSettings;
  saveDispatchCalendarCredentials?: typeof saveMicrosoftDispatchCalendarCredentials;
  testDispatchCalendarConnection?: typeof testMicrosoftDispatchCalendarConnection;
  setDispatchCalendarEnabled?: typeof setMicrosoftDispatchCalendarEnabled;
};

function integrationReadiness(
  dispatchCalendar: MicrosoftDispatchCalendarSettings,
  env: NodeJS.ProcessEnv = process.env
) {
  const configured = (names: string[]) => names.every((name) => Boolean(String(env[name] ?? "").trim()));
  const driverCalendarReady = Boolean(String(env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? "").trim()) &&
    Boolean(String(env.APP_BASE_URL ?? "").trim()) && (
    configured(["M365_TENANT_ID", "M365_DRIVER_CLIENT_ID", "M365_DRIVER_CLIENT_SECRET"]) ||
    configured(["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET"])
  );
  return [
    { name: "Stripe payment links", ready: false },
    { name: "Email delivery", ready: false },
    { name: "WhatsApp Business", ready: configured(["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_API_VERSION"]) },
    {
      name: "Microsoft 365 dispatch calendar",
      ready: dispatchCalendar.configured && dispatchCalendar.enabled && dispatchCalendar.tested,
      status: dispatchCalendar.clientSecretSaved && !dispatchCalendar.encryptionAvailable
        ? "Encryption key unavailable"
        : !dispatchCalendar.configured
        ? "Not configured"
        : dispatchCalendar.source === "environment"
          ? dispatchCalendar.enabled ? "Configured from server environment" : "Configured (Off)"
          : !dispatchCalendar.tested
              ? "Connection not tested"
              : dispatchCalendar.enabled
                ? "Enabled"
                : "Configured (Off)"
    },
    { name: "Driver calendar OAuth (Microsoft or Google)", ready: driverCalendarReady }
  ] as Array<{ name: string; ready: boolean; status?: string }>;
}

export function createBookingIntegrationSettingsRouter(options: Options): Router {
  const router = Router();
  const loadSession = options.loadSession ?? getSessionAccount;
  const getBookingSettings = options.getBookingSettings ?? getBookingIntegrationSettings;
  const saveMinimumNotice = options.saveMinimumNotice ?? saveMinimumOnlineNotice;
  const getStripeSummary = options.getStripeSummary ?? getStripeSettingsSummary;
  const getEmailSettings = options.getEmailSettings ?? getEmailMessagingSettings;
  const getDispatchCalendarSettings = options.getDispatchCalendarSettings ?? getMicrosoftDispatchCalendarSettings;
  const saveDispatchCalendarCredentials = options.saveDispatchCalendarCredentials ?? saveMicrosoftDispatchCalendarCredentials;
  const testDispatchCalendarConnection = options.testDispatchCalendarConnection ?? testMicrosoftDispatchCalendarConnection;
  const setDispatchCalendarEnabled = options.setDispatchCalendarEnabled ?? setMicrosoftDispatchCalendarEnabled;
  router.use("/settings/booking-integrations", noStoreProtectedResponse);
  const csrf = requireCsrfToken({ appTitle: options.appTitle });

  const requireSuperuser = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await loadSession(req.headers.cookie);
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
      const [dispatchCalendar, stripe, email] = await Promise.all([
        getDispatchCalendarSettings(),
        getStripeSummary(),
        getEmailSettings()
      ]);
      const integrations = integrationReadiness(dispatchCalendar);
      const emailReady = email.deliveryConfigured;
      integrations[1].ready = email.enabled && emailReady;
      integrations[1].status = !emailReady ? "Not configured" : email.enabled ? "Configured" : "Configured (Off)";
      const stripeReady = (stripe.mode === "test" ? stripe.testConfigured : stripe.liveConfigured) &&
        stripe.publicUrlConfigured;
      integrations[0].ready = stripe.enabled && stripeReady;
      integrations[0].status = !stripeReady ? "Not configured" : stripe.enabled ? "Configured" : "Configured (Off)";
      return res.render("pages/booking-integrations-settings", {
        title: "Booking integrations",
        appTitle: options.appTitle,
        email: actor.email,
        settings: await getBookingSettings(),
        noticeHours: ONLINE_BOOKING_NOTICE_HOURS,
        dispatchCalendar,
        integrations,
        notice: [
          "saved", "invalid", "calendar-saved", "calendar-invalid", "calendar-tested",
          "calendar-test-failed", "calendar-not-ready", "calendar-enabled",
          "calendar-disabled", "calendar-test-required", "calendar-encryption-key-required"
        ].includes(String(req.query.notice)) ? String(req.query.notice) : ""
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
      await saveMinimumNotice({ hours, actorId: actor.id, actorEmail: actor.email });
      return res.redirect(303, "/settings/booking-integrations?notice=saved");
    } catch (error) {
      return next(error);
    }
  });

  router.post("/settings/booking-integrations/calendar/credentials", requireSuperuser, csrf, async (req, res, next) => {
    const actor = res.locals.integrationSettingsActor as { id: string; email: string };
    try {
      await saveDispatchCalendarCredentials({
        tenantId: String(req.body?.tenantId ?? ""),
        clientId: String(req.body?.clientId ?? ""),
        clientSecret: String(req.body?.clientSecret ?? ""),
        calendarUser: String(req.body?.calendarUser ?? ""),
        calendarId: String(req.body?.calendarId ?? ""),
        actorId: actor.id,
        actorEmail: actor.email
      });
      return res.redirect(303, "/settings/booking-integrations?notice=calendar-saved");
    } catch (error) {
      if (error instanceof TypeError) {
        return res.redirect(303, "/settings/booking-integrations?notice=calendar-invalid");
      }
      if (error instanceof Error && error.message.startsWith("Set STRIPE_CONFIG_ENCRYPTION_KEY")) {
        return res.redirect(303, "/settings/booking-integrations?notice=calendar-encryption-key-required");
      }
      return next(error);
    }
  });

  router.post("/settings/booking-integrations/calendar/test", requireSuperuser, csrf, async (_req, res, next) => {
    try {
      const actor = res.locals.integrationSettingsActor as { id: string; email: string };
      await testDispatchCalendarConnection({ actorId: actor.id, actorEmail: actor.email });
      return res.redirect(303, "/settings/booking-integrations?notice=calendar-tested");
    } catch (error) {
      if (error instanceof TypeError) {
        return res.redirect(303, "/settings/booking-integrations?notice=calendar-not-ready");
      }
      if (error instanceof Error && error.message.startsWith("Set STRIPE_CONFIG_ENCRYPTION_KEY")) {
        return res.redirect(303, "/settings/booking-integrations?notice=calendar-encryption-key-required");
      }
      if (error instanceof Error && error.message.startsWith("Microsoft")) {
        return res.redirect(303, "/settings/booking-integrations?notice=calendar-test-failed");
      }
      return next(error);
    }
  });

  router.post("/settings/booking-integrations/calendar/switch", requireSuperuser, csrf, async (req, res, next) => {
    try {
      const actor = res.locals.integrationSettingsActor as { id: string; email: string };
      const enabled = req.body?.enabled === "on";
      await setDispatchCalendarEnabled({ enabled, actorId: actor.id, actorEmail: actor.email });
      return res.redirect(303, `/settings/booking-integrations?notice=${enabled ? "calendar-enabled" : "calendar-disabled"}`);
    } catch (error) {
      if (error instanceof TypeError) {
        return res.redirect(303, "/settings/booking-integrations?notice=calendar-test-required");
      }
      return next(error);
    }
  });

  return router;
}
