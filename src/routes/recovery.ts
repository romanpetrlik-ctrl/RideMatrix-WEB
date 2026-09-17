import { Router } from "express";
import { SessionAccount, getSessionAccount } from "../services/api";
import { noStoreProtectedResponse } from "../middleware/no-store";

type RecoveryRouterOptions = {
  appTitle: string;
  loadSession?: (cookieHeader?: string) => Promise<SessionAccount>;
};

function readRecoverySession(res: { locals: { recoverySession?: SessionAccount } }): SessionAccount {
  const session = res.locals.recoverySession;
  if (!session) {
    throw new Error("Recovery session is not available.");
  }

  return session;
}

export function createRecoveryRouter(options: RecoveryRouterOptions): Router {
  const router = Router();
  router.use(noStoreProtectedResponse);
  const loadSession = options.loadSession ?? getSessionAccount;
  router.use(async (req, res, next) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }
      res.locals.recoverySession = session;
      const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
      if (!roles.includes("superuser")) {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get("/recovery", async (req, res, next) => {
    try {
      const session = readRecoverySession(res);
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
      const session = readRecoverySession(res);
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
      const session = readRecoverySession(res);
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
      const session = readRecoverySession(res);
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
      const session = readRecoverySession(res);
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
      const session = readRecoverySession(res);
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
      const session = readRecoverySession(res);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }
      if (String(req.body.confirmed || "").trim() !== "yes") {
        return res.redirect("/recovery/restart");
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
