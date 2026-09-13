import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { getSessionAccount } from "../services/api";
import { logStaffLogin, STAFF_LOGIN_FAILED, STAFF_LOGIN_SUCCEEDED } from "../services/staff-audit";
import { availableWorkspaceModules } from "./role-sections";

export function getLandingRoute(roles: string[]): string {
  const modules = availableWorkspaceModules(roles);
  if (modules.length === 0) return "/account";
  return modules.length === 1 ? modules[0].href : "/choose-role";
}

export function createAuthCallbackRouter(options: { logLogin?: typeof logStaffLogin } = {}): Router {
  const router = Router();
  const auditLogin = options.logLogin ?? logStaffLogin;
  const callbackRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false
  });

  router.get("/auth/callback", callbackRateLimit, async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);

      if (!session.authenticated || !session.user) {
        await auditLogin({
          eventName: STAFF_LOGIN_FAILED,
          success: false,
          failureCategory: "unauthorized",
          ipAddress: req.ip,
          userAgent: req.get("user-agent") || undefined
        });
        return res.redirect("/access");
      }

      const roles = Array.isArray(session.user.roles) ? session.user.roles : [];

      if (roles.length === 0) {
        await auditLogin({
          eventName: STAFF_LOGIN_FAILED,
          accountId: session.user.id,
          loginIdentifier: session.user.email,
          success: false,
          failureCategory: "unauthorized",
          ipAddress: req.ip,
          userAgent: req.get("user-agent") || undefined
        });
        return res.redirect("/access");
      }

      await auditLogin({
        eventName: STAFF_LOGIN_SUCCEEDED,
        accountId: session.user.id,
        loginIdentifier: session.user.email,
        success: true,
        ipAddress: req.ip,
        userAgent: req.get("user-agent") || undefined
      });
      return res.redirect(getLandingRoute(roles));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
