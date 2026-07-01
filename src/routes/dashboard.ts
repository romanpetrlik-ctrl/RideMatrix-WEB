import { Router } from "express";
import { getSessionAccount } from "../services/api";

type DashboardRouterOptions = {
  appTitle: string;
};

type DashboardTile = {
  key: string;
  title: string;
  description: string;
  href?: string;
  target?: string;
};

const dashboardSections: Array<{ title: string; tiles: DashboardTile[] }> = [
  {
    title: "Operations",
    tiles: [
      {
        key: "bookings",
        title: "Bookings",
        description: "Booking management and trip oversight."
      },
      {
        key: "active-vehicles-map",
        title: "Active Vehicles Map",
        description: "Live map of active vehicles and trips.",
        href: "/map",
        target: "_blank"
      },
      {
        key: "financial-reports",
        title: "Financial Reports",
        description: "Revenue and finance reporting."
      }
    ]
  },
  {
    title: "Management",
    tiles: [
      {
        key: "customers",
        title: "Customers",
        description: "Customer accounts and profile records."
      },
      {
        key: "staff",
        title: "Staff",
        description: "Staff accounts and access control."
      },
      {
        key: "drivers",
        title: "Drivers",
        description: "Driver records and compliance status."
      },
      {
        key: "vehicles",
        title: "Vehicles",
        description: "Fleet vehicles and availability."
      }
    ]
  },
  {
    title: "Platform",
    tiles: [
      {
        key: "general-settings",
        title: "General Settings",
        description: "Platform-wide configuration."
      },
      {
        key: "quick-system-check",
        title: "Quick System Check",
        description: "Service health and system diagnostics."
      }
    ]
  }
];

const allTiles = dashboardSections.flatMap((section) => section.tiles);

export function createDashboardRouter(options: DashboardRouterOptions): Router {
  const router = Router();

  router.get("/admin", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      return res.redirect("/dashboard");
    } catch (error) {
      next(error);
    }
  });

  router.get("/dashboard", async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
      const activeRole = session.user.active_role;

      if (!roles.includes("admin")) {
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

      // TODO: Expand to a shared role-to-dashboard resolver when other dashboards are implemented.
      if (activeRole !== "admin") {
        return res.redirect("/account");
      }

      const requestedTileKey = String(req.query.tile || "");
      const selectedTile = allTiles.find((tile) => tile.key === requestedTileKey);

      return res.render("pages/dashboard", {
        title: "Admin Dashboard",
        appTitle: options.appTitle,
        email: session.user.email,
        sections: dashboardSections,
        selectedTile
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
