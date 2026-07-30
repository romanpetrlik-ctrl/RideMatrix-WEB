import { Router } from "express";
import { getSessionAccount, selectActiveRole } from "../services/api";

function getLandingRoute(roles: string[]): string {
  if (roles.includes("admin")) {
    return "/dashboard";
  }

  return "/account";
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

      if (roles.length === 1) {
        const selected = await selectActiveRole(roles[0], req.headers.cookie);

        for (const cookieValue of selected.setCookie) {
          res.append("Set-Cookie", cookieValue);
        }

        return res.redirect(getLandingRoute(roles));
      }

      return res.redirect("/choose-role");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
