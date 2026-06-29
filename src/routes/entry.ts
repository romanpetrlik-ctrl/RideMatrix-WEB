import { Router } from "express";
import { getSessionAccount } from "../services/api";

type EntryRouterOptions = {
  appTitle: string;
};

const roleRedirectMap: Record<string, string> = {
  admin: "/admin",
  superuser: "/superuser",
  staff: "/staff",
  tech_support: "/tech-support",
  dispatcher: "/dispatch",
  driver: "/driver"
};

function getRoleRedirect(role: string): string {
  return roleRedirectMap[role] ?? "/account";
}

export function createEntryRouter(options: EntryRouterOptions): Router {
  const router = Router();

  router.get("/entry", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);

      if (!session.authenticated || !session.user) {
        return res.render("pages/entry", {
          title: "Access",
          appTitle: options.appTitle
        });
      }

      const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
      const activeRole = session.user.active_role;

      if (roles.length === 0) {
        return res.redirect("/access");
      }

      if (activeRole) {
        return res.redirect(getRoleRedirect(activeRole));
      }

      if (roles.length === 1) {
        return res.redirect("/auth/callback");
      }

      return res.redirect("/choose-role");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
