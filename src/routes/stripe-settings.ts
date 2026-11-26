import { Router, type NextFunction, type Request, type Response } from "express";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, type SessionAccount } from "../services/api";
import {
  getStripeSettingsSummary,
  saveStripeCredentials,
  setStripePaymentsEnabled,
  testStripeConnection,
  type StripeMode,
  type StripeSettingsSummary
} from "../services/stripe-settings";

type Options = {
  appTitle: string;
  loadSession?: (cookieHeader: string | undefined) => Promise<SessionAccount>;
  getSummary?: typeof getStripeSettingsSummary;
  saveCredentials?: typeof saveStripeCredentials;
  testConnection?: typeof testStripeConnection;
  setEnabled?: typeof setStripePaymentsEnabled;
};

const BASE_PATH = "/settings/payments/stripe";

export function createStripeSettingsRouter(options: Options): Router {
  const router = Router();
  const loadSession = options.loadSession ?? getSessionAccount;
  const getSummary = options.getSummary ?? getStripeSettingsSummary;
  const saveCredentials = options.saveCredentials ?? saveStripeCredentials;
  const testConnection = options.testConnection ?? testStripeConnection;
  const setEnabled = options.setEnabled ?? setStripePaymentsEnabled;
  router.use(BASE_PATH, noStoreProtectedResponse);
  const csrf = requireCsrfToken({ appTitle: options.appTitle });

  const requireSuperuser = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect("/access");
      if (!session.user.roles.includes("superuser")) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }
      res.locals.stripeSettingsActor = { id: session.user.id, email: session.user.email };
      return next();
    } catch (error) {
      return next(error);
    }
  };

  const renderPage = async (res: Response, summary: StripeSettingsSummary, notice: string) => {
    return res.render("pages/stripe-settings", {
      title: "Stripe settings",
      appTitle: options.appTitle,
      email: (res.locals.stripeSettingsActor as { email: string }).email,
      setting: summary,
      notice
    });
  };

  router.get(BASE_PATH, requireSuperuser, async (req, res, next) => {
    try {
      const notice = ["saved", "tested", "enabled", "disabled", "invalid", "not-ready", "test-failed", "stripe-active", "pending-payments"]
        .includes(String(req.query.notice)) ? String(req.query.notice) : "";
      return renderPage(res, await getSummary(), notice);
    } catch (error) {
      return next(error);
    }
  });

  router.post(`${BASE_PATH}/credentials`, requireSuperuser, csrf, async (req, res, next) => {
    const actor = res.locals.stripeSettingsActor as { id: string; email: string };
    try {
      const mode = String(req.body?.mode ?? "");
      if (mode !== "test" && mode !== "live") {
        return res.redirect(303, `${BASE_PATH}?notice=invalid`);
      }
      await saveCredentials({
        mode: mode as StripeMode,
        publishableKey: String(req.body?.publishableKey ?? ""),
        secretKey: String(req.body?.secretKey ?? ""),
        webhookSecret: String(req.body?.webhookSecret ?? ""),
        actorId: actor.id,
        actorEmail: actor.email
      });
      return res.redirect(303, `${BASE_PATH}?notice=saved`);
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith("Resolve outstanding Stripe payments")) {
        return res.redirect(303, `${BASE_PATH}?notice=pending-payments`);
      }
      if (error instanceof TypeError && error.message.startsWith("Switch Stripe payments off")) {
        return res.redirect(303, `${BASE_PATH}?notice=stripe-active`);
      }
      if (error instanceof TypeError || (error instanceof Error && error.message.startsWith("Set STRIPE_CONFIG_ENCRYPTION_KEY"))) {
        return res.redirect(303, `${BASE_PATH}?notice=invalid`);
      }
      return next(error);
    }
  });

  router.post(`${BASE_PATH}/test`, requireSuperuser, csrf, async (_req, res, next) => {
    try {
      const actor = res.locals.stripeSettingsActor as { id: string; email: string };
      await testConnection({ actorId: actor.id, actorEmail: actor.email });
      return res.redirect(303, `${BASE_PATH}?notice=tested`);
    } catch (error) {
      if (error instanceof TypeError) return res.redirect(303, `${BASE_PATH}?notice=not-ready`);
      if (error instanceof Error && (
        error.message.startsWith("Stripe ") ||
        error.message.startsWith("Set STRIPE_CONFIG_ENCRYPTION_KEY")
      )) {
        return res.redirect(303, `${BASE_PATH}?notice=test-failed`);
      }
      return next(error);
    }
  });

  router.post(`${BASE_PATH}/switch`, requireSuperuser, csrf, async (req, res, next) => {
    const actor = res.locals.stripeSettingsActor as { id: string; email: string };
    const enabled = req.body?.enabled === "on";
    try {
      await setEnabled({ enabled, actorId: actor.id, actorEmail: actor.email });
      return res.redirect(303, `${BASE_PATH}?notice=${enabled ? "enabled" : "disabled"}`);
    } catch (error) {
      if (error instanceof TypeError) return res.redirect(303, `${BASE_PATH}?notice=not-ready`);
      return next(error);
    }
  });

  return router;
}
