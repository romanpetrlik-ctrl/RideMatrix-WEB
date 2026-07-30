import { Router } from "express";
import { getSessionAccount, submitAccessRequest } from "../services/api";

type AccessRouterOptions = {
  appTitle: string;
};

export function createAccessRouter(options: AccessRouterOptions): Router {
  const router = Router();

  router.get("/access", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);

      if (session.authenticated && session.user) {
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];

        if (roles.length === 1) {
          return res.redirect(roles[0] === "admin" ? "/dashboard" : "/account");
        }

        if (roles.length > 1) {
          return res.redirect("/choose-role");
        }
      }

      return res.render("pages/access", {
        title: "Access",
        appTitle: options.appTitle
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/access", async (req, res, next) => {
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
