import { Router } from "express";
import { getSessionAccount } from "../services/api";
import { getLandingRoute } from "./auth-callback";

type EntryRouterOptions = {
  appTitle: string;
};

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

      return res.redirect(getLandingRoute(roles));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
