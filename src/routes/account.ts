import { Router } from "express";
import { getSessionAccount, selectActiveRole } from "../services/api";

type AccountRouterOptions = {
  appTitle: string;
};

function getRoleLabel(role: string): string {
  switch (role) {
    case "admin":
      return "Administration";
    case "superuser":
      return "System Control";
    case "staff":
      return "Staff";
    case "tech_support":
      return "Technical Support";
    case "dispatcher":
      return "Dispatch";
    case "driver":
      return "Driver";
    case "customer":
      return "Customer";
    case "partner":
      return "Partner";
    default:
      return role;
  }
}

function getRoleDescription(role: string): string {
  switch (role) {
    case "admin":
      return "Manage operations, staff, drivers, and platform settings.";
    case "superuser":
      return "Full system access and platform administration controls.";
    case "staff":
      return "Access your staff workspace and daily operational tasks.";
    case "tech_support":
      return "Technical support tools and system monitoring.";
    case "dispatcher":
      return "Manage and coordinate active dispatching.";
    case "driver":
      return "Access your driver workspace and current assignments.";
    case "customer":
      return "Access your customer account and booking history.";
    case "partner":
      return "Access your partner portal and agreements.";
    default:
      return "Access this workspace.";
  }
}

export function createAccountRouter(options: AccountRouterOptions): Router {
  const router = Router();

  router.get("/account", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);

      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
      const activeRole = session.user.active_role;

      if (roles.length === 0) {
        return res.redirect("/access");
      }

      if (roles.length === 1 && activeRole !== roles[0]) {
        const selected = await selectActiveRole(roles[0], req.headers.cookie);

        for (const cookieValue of selected.setCookie) {
          res.append("Set-Cookie", cookieValue);
        }

        if (roles[0] === "admin") {
          return res.redirect("/dashboard");
        }

        return res.render("pages/account", {
          title: "Account",
          appTitle: options.appTitle,
          email: session.user.email,
          roles,
          activeRole: roles[0],
          getRoleLabel
        });
      }

      const resolvedActiveRole = activeRole && roles.includes(activeRole) ? activeRole : undefined;

      return res.render("pages/account", {
        title: "Account",
        appTitle: options.appTitle,
        email: session.user.email,
        roles,
        activeRole: resolvedActiveRole,
        getRoleLabel
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/choose-role", async (req, res, next) => {
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

        if (roles[0] === "admin") {
          return res.redirect("/dashboard");
        }

        return res.redirect("/account");
      }

      return res.render("pages/choose-role", {
        title: "Choose workspace",
        appTitle: options.appTitle,
        email: session.user.email,
        roles,
        activeRole: session.user.active_role,
        getRoleLabel,
        getRoleDescription
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/choose-role", async (req, res, next) => {
    try {
      const requestedRole = String(req.body.role || "").trim();

      if (!requestedRole) {
        return res.redirect("/choose-role");
      }

      const selected = await selectActiveRole(requestedRole, req.headers.cookie);

      for (const cookieValue of selected.setCookie) {
        res.append("Set-Cookie", cookieValue);
      }

      if (selected.activeRole === "admin") {
        return res.redirect("/dashboard");
      }

      return res.redirect("/account");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
