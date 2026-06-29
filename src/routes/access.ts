import { Router } from "express";
import { submitAccessRequest } from "../services/api";

type AccessRouterOptions = {
  appTitle: string;
};

export function createAccessRouter(options: AccessRouterOptions): Router {
  const router = Router();

  router.get("/access", (_req, res) => {
    res.render("pages/access", {
      title: "Access",
      appTitle: options.appTitle
    });
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
