import { Router } from "express";
import { getSessionAccount } from "../services/api";
import { availableWorkspaceModules } from "./role-sections";

export function getLandingRoute(roles: string[]): string {
  const modules = availableWorkspaceModules(roles);
  if (modules.length === 0) return "/account";
  return modules.length === 1 ? modules[0].href : "/choose-role";
}

export function createAuthCallbackRouter(): Router {
  const router = Router();

  router.get("/auth/callback", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);

      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      const roles = Array.isArray(session.user.roles) ? session.user.roles : [];

      if (roles.length === 0) {
        return res.redirect("/access");
      }

      return res.redirect(getLandingRoute(roles));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
