import { Router } from "express";
import { getSessionAccount } from "../services/api";

type DashboardRouterOptions = {
  appTitle: string;
};

export function createDashboardRouter(options: DashboardRouterOptions): Router {
  const router = Router();

  router.get("/admin", (_req, res) => {
    res.redirect("/dashboard");
  });

  router.get("/dashboard", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);

      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
      const activeRole = session.user.active_role;

      if (!roles.includes("admin")) {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      if (!activeRole) {
        if (roles.length > 1) {
          return res.redirect("/choose-role");
        }
        return res.redirect("/auth/callback");
      }

      if (activeRole !== "admin") {
        return res.redirect("/account");
      }

      return res.render("pages/dashboard", {
        title: "Administration",
        appTitle: options.appTitle,
        email: session.user.email
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
