import { Router } from "express";
import { getSessionAccount, selectActiveRole } from "../services/api";

const roleRedirectMap: Record<string, string> = {
  admin: "/dashboard",
  superuser: "/superuser",
  staff: "/staff",
  tech_support: "/tech-support",
  dispatcher: "/dispatch",
  driver: "/driver"
};

function getRoleRedirect(role: string): string {
  return roleRedirectMap[role] ?? "/account";
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

        return res.redirect(getRoleRedirect(roles[0]));
      }

      return res.redirect("/choose-role");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
