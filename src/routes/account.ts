import { Router } from "express";
import { getSessionAccount } from "../services/api";
import { availableWorkspaceModules } from "./role-sections";

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

/**
 * Resolves where a newly-selected workspace role should land. Administrative
 * modules must have an explicit destination instead of falling back to the
 * personal `/account` page: `admin` opens the operations dashboard and
 * `staff` opens the staff management list (subject to its own authorization
 * check). Every other role continues to land on the personal account page.
 */
function getWorkspaceRedirectHref(role: string): string {
  switch (role) {
    case "admin":
      return "/dashboard";
    case "staff":
      return "/staff";
    default:
      return "/account";
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

      return res.render("pages/choose-role", {
        title: "Choose workspace",
        appTitle: options.appTitle,
        email: session.user.email,
        modules: availableWorkspaceModules(roles)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/choose-role", async (req, res, next) => {
    try {
      const requestedModule = String(req.body.module || "").trim();
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect("/access");
      const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
      const module = availableWorkspaceModules(roles).find((item) => item.key === requestedModule);
      if (!module) return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      return res.redirect(module.href);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
