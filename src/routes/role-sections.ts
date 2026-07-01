import { Router } from "express";
import { getSessionAccount } from "../services/api";

type RoleSectionsRouterOptions = {
  appTitle: string;
};

const routeRoleMap: Record<string, string> = {
  "/superuser": "superuser",
  "/staff": "staff",
  "/tech-support": "tech_support",
  "/dispatch": "dispatcher",
  "/driver": "driver"
};

function getRoleLabel(role: string): string {
  switch (role) {
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

export function createRoleSectionsRouter(options: RoleSectionsRouterOptions): Router {
  const router = Router();

  for (const [routePath, requiredRole] of Object.entries(routeRoleMap)) {
    router.get(routePath, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);

        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }

        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        const activeRole = session.user.active_role;

        if (!roles.includes(requiredRole)) {
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

        if (activeRole !== requiredRole) {
          return res.redirect("/account");
        }

        return res.render("pages/role-section", {
          title: getRoleLabel(requiredRole),
          appTitle: options.appTitle,
          email: session.user.email,
          role: requiredRole,
          roleLabel: getRoleLabel(requiredRole)
        });
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}