import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { ApiRequestError, getSessionAccount, submitAccessRequest } from "../services/api";
import { logStaffLogin, STAFF_LOGIN_FAILED } from "../services/staff-audit";
import { getLandingRoute } from "./auth-callback";

type AccessRouterOptions = {
  appTitle: string;
  logLogin?: typeof logStaffLogin;
};

export function createAccessRouter(options: AccessRouterOptions): Router {
  const router = Router();
  const auditLogin = options.logLogin ?? logStaffLogin;
  const loginRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false
  });

  router.get("/access", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);

      if (session.authenticated && session.user) {
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];

        if (roles.length > 0) return res.redirect(getLandingRoute(roles));
      }

      return res.render("pages/access", {
        title: "Access",
        appTitle: options.appTitle
      });
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0;
      await auditLogin({
        eventName: STAFF_LOGIN_FAILED,
        loginIdentifier: String(req.body.email || "").trim().toLowerCase() || undefined,
        success: false,
        failureCategory:
          status === 401
            ? "invalid_credentials"
            : status === 403
              ? "disabled_account"
              : status === 429
                ? "blocked"
                : "system_failure",
        ipAddress: req.ip,
        userAgent: req.get("user-agent") || undefined
      });
      next(error);
    }
  });

  router.post("/access", loginRateLimit, async (req, res, next) => {
    try {
      const email = String(req.body.email || "").trim();
      await submitAccessRequest(email);

      res.render("pages/request-received", {
        title: "Access",
        appTitle: options.appTitle,
        email
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
