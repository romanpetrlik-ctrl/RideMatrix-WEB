import { Router } from "express";
import { getSessionAccount } from "../services/api";

type EntryRouterOptions = {
  appTitle: string;
};

function getLandingRoute(roles: string[]): string {
  if (roles.includes("admin")) {
    return "/dashboard";
  }

  return "/account";
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
      if (roles.length === 0) {
        return res.redirect("/access");
      }

      if (session.user.active_role) {
        return res.redirect(getLandingRoute(roles));
      }

      if (roles.length === 1) {
        return res.redirect("/auth/callback");
      }

      if (roles.includes("admin")) {
        return res.redirect("/dashboard");
      }

      return res.redirect("/choose-role");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
