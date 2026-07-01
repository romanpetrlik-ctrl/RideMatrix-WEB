import { Router } from "express";
import { getSessionAccount } from "../services/api";

type DashboardRouterOptions = {
  appTitle: string;
};

export function createDashboardRouter(options: DashboardRouterOptions): Router {
  const router = Router();

  router.get("/dashboard", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);

      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      return res.render("pages/dashboard", {
        title: "Dashboard",
        appTitle: options.appTitle,
        email: session.user.email
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
