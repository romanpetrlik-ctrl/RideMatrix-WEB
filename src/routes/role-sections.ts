import { Router } from "express";
import { getSessionAccount } from "../services/api";

type RoleSectionsRouterOptions = {
  appTitle: string;
};

type AdminDashboardTile = {
  label: string;
  placeholderTitle: string;
  placeholderBody: string;
};

type AdminDashboardSection = {
  title: string;
  tiles: AdminDashboardTile[];
};

const routeRoleMap: Record<string, string> = {
  "/dashboard": "admin",
  "/superuser": "superuser",
  "/staff": "staff",
  "/tech-support": "tech_support",
  "/dispatch": "dispatcher",
  "/driver": "driver"
};

const adminDashboardSections: AdminDashboardSection[] = [
  {
    title: "Operations",
    tiles: [
      {
        label: "Bookings",
        placeholderTitle: "Bookings placeholder",
        placeholderBody:
          "Bookings is part of Operations. This tile currently opens a placeholder panel only, and no live admin workflow is connected yet."
      },
      {
        label: "Active Drivers",
        placeholderTitle: "Active Drivers placeholder",
        placeholderBody:
          "Active Drivers is part of Operations. This tile currently opens a placeholder panel only, and no live admin workflow is connected yet."
      },
      {
        label: "Financial Reports",
        placeholderTitle: "Financial Reports placeholder",
        placeholderBody:
          "Financial Reports is part of Operations. This tile currently opens a placeholder panel only, and no live admin workflow is connected yet."
      }
    ]
  },
  {
    title: "Management",
    tiles: [
      {
        label: "Customers",
        placeholderTitle: "Customers placeholder",
        placeholderBody:
          "Customers is part of Management. This tile currently opens a placeholder panel only, and no live admin workflow is connected yet."
      },
      {
        label: "Staff",
        placeholderTitle: "Staff placeholder",
        placeholderBody:
          "Staff is part of Management. This tile currently opens a placeholder panel only, and no live admin workflow is connected yet."
      },
      {
        label: "Drivers",
        placeholderTitle: "Drivers placeholder",
        placeholderBody:
          "Drivers is part of Management. This tile currently opens a placeholder panel only, and no live admin workflow is connected yet."
      },
      {
        label: "Vehicles",
        placeholderTitle: "Vehicles placeholder",
        placeholderBody:
          "Vehicles is part of Management. This tile currently opens a placeholder panel only, and no live admin workflow is connected yet."
      }
    ]
  },
  {
    title: "Platform",
    tiles: [
      {
        label: "Core Settings",
        placeholderTitle: "Core Settings placeholder",
        placeholderBody:
          "Core Settings is part of Platform. This tile currently opens a placeholder panel only, and no live admin workflow is connected yet."
      },
      {
        label: "Quick System Check",
        placeholderTitle: "Quick System Check placeholder",
        placeholderBody:
          "Quick System Check is part of Platform. This tile currently opens a placeholder panel only, and no live admin workflow is connected yet."
      },
      {
        label: "Backup & Recovery",
        placeholderTitle: "Backup & Recovery placeholder",
        placeholderBody:
          "Backup & Recovery is part of Platform. This tile currently opens a placeholder panel only, and no live admin workflow is connected yet."
      }
    ]
  }
];

function getRoleLabel(role: string): string {
  switch (role) {
    case "admin":
      return "Admin Dashboard";
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

  router.get("/admin", (_req, res) => {
    return res.redirect("/dashboard");
  });

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
          roleLabel: getRoleLabel(requiredRole),
          adminDashboardSections: requiredRole === "admin" ? adminDashboardSections : undefined
        });
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}