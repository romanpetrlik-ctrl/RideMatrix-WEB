import { Router } from "express";
import { getSessionAccount } from "../services/api";

type RecoveryRouterOptions = {
  appTitle: string;
};

export function createRecoveryRouter(options: RecoveryRouterOptions): Router {
  const router = Router();

  router.get("/recovery", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      return res.render("pages/recovery/index", {
        title: "Help / Recovery",
        appTitle: options.appTitle,
        email: session.user.email
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/recovery/backup", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      return res.render("pages/recovery/backup", {
        title: "Perform full external backup",
        appTitle: options.appTitle,
        email: session.user.email
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/recovery/backup", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      const confirmed = String(req.body.confirmed || "").trim();
      if (confirmed !== "yes") {
        return res.redirect("/recovery/backup");
      }

      return res.redirect("/recovery/warning");
    } catch (error) {
      next(error);
    }
  });

  router.get("/recovery/warning", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      return res.render("pages/recovery/warning", {
        title: "Be careful with this action",
        appTitle: options.appTitle,
        email: session.user.email
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/recovery/warning", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      const confirmed = String(req.body.confirmed || "").trim();
      if (confirmed !== "yes") {
        return res.redirect("/recovery/warning");
      }

      return res.redirect("/recovery/restart");
    } catch (error) {
      next(error);
    }
  });

  router.get("/recovery/restart", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      return res.render("pages/recovery/restart", {
        title: "Restart VPS",
        appTitle: options.appTitle,
        email: session.user.email
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/recovery/restart", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      // Placeholder — no actual restart is performed from this interface.
      return res.render("pages/recovery/restart", {
        title: "Restart VPS",
        appTitle: options.appTitle,
        email: session.user.email,
        stubMessage:
          "Restart action is not available via this interface. Use your hosting control panel or SSH."
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
