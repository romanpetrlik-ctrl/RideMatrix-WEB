import { Router } from "express";
import { getSessionAccount, selectActiveRole } from "../services/api";

type AccountRouterOptions = {
  appTitle: string;
};

const roleRedirectMap: Record<string, string> = {
  admin: "/dashboard",
  superuser: "/superuser",
  staff: "/staff",
  tech_support: "/tech-support",
  dispatcher: "/dispatch",
  driver: "/driver"
};

function getRoleRedirect(role: string): string | null {
  return roleRedirectMap[role] ?? null;
}

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
    default:
      return role;
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

        const redirectTarget = getRoleRedirect(roles[0]);
        if (redirectTarget) {
          return res.redirect(redirectTarget);
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

      if (activeRole) {
        const redirectTarget = getRoleRedirect(activeRole);
        if (redirectTarget) {
          return res.redirect(redirectTarget);
        }

        return res.render("pages/account", {
          title: "Account",
          appTitle: options.appTitle,
          email: session.user.email,
          roles,
          activeRole,
          getRoleLabel
        });
      }

      return res.render("pages/account", {
        title: "Account",
        appTitle: options.appTitle,
        email: session.user.email,
        roles,
        activeRole,
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

        const redirectTarget = getRoleRedirect(roles[0]);
        if (redirectTarget) {
          return res.redirect(redirectTarget);
        }

        return res.redirect("/account");
      }

      return res.render("pages/choose-role", {
        title: "Select a module",
        appTitle: options.appTitle,
        email: session.user.email,
        roles,
        activeRole: session.user.active_role,
        getRoleLabel
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

      const redirectTarget = getRoleRedirect(selected.activeRole);
      return res.redirect(redirectTarget ?? "/account");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
