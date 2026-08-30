import { Router } from "express";
import { getSessionAccount } from "../services/api";

type DashboardRouterOptions = {
  appTitle: string;
};

type DashboardTile = {
  key: string;
  title: string;
  description: string;
};

type OperationalMenuAction = {
  label: string;
  href: string;
  externalMode?: "tab" | "window";
  status?: {
    tone: "amber" | "red";
    message: string;
  };
};

type OperationalMenuRow = {
  category: string;
  actions: OperationalMenuAction[];
};

type SelectedOperationalAction = {
  category: string;
  label: string;
  externalMode?: "tab" | "window";
};

const operationalMenuRows: OperationalMenuRow[] = [
  {
    category: "Bookings",
    actions: [
      { label: "New", href: "/dashboard?tile=bookings-new" },
      { label: "Today", href: "/dashboard?tile=bookings-today" },
      {
        label: "Upcoming",
        href: "/dashboard?tile=bookings-upcoming",
        status: {
          tone: "red",
          message: "Demo status: booking conflicts need immediate review."
        }
      },
      { label: "Past", href: "/dashboard?tile=bookings-past" },
      { label: "Recurring", href: "/dashboard?tile=bookings-recurring" }
    ]
  },
  {
    category: "Dispatch",
    actions: [
      { label: "Live board", href: "/dashboard?tile=dispatch-live-board", externalMode: "tab" },
      { label: "Live Map", href: "/dashboard?tile=dispatch-live-map", externalMode: "window" }
    ]
  },
  {
    category: "Customers",
    actions: [
      { label: "All customers", href: "/customers" },
      { label: "New customer", href: "/customers/register" }
    ]
  },
  {
    category: "Staff",
    actions: [{ label: "All staff", href: "/staff" }]
  },
  {
    category: "Pricing",
    actions: [
      { label: "Distance slabs", href: "/dashboard?tile=pricing-distance-slabs" },
      {
        label: "Fixed fares",
        href: "/dashboard?tile=pricing-fixed-fares",
        status: {
          tone: "amber",
          message: "Demo status: fixed fare review recommended before publishing."
        }
      },
      { label: "Extras", href: "/dashboard?tile=pricing-extras" },
      { label: "All pricing settings", href: "/dashboard?tile=pricing-settings" }
    ]
  },
  {
    category: "Settings",
    actions: [
      { label: "Email", href: "/dashboard?tile=settings-email" },
      {
        label: "WhatsApp",
        href: "/dashboard?tile=settings-whatsapp",
        status: {
          tone: "amber",
          message: "Demo status: WhatsApp integration is ready for connection testing."
        }
      },
      { label: "Notifications", href: "/dashboard?tile=settings-notifications" }
    ]
  }
];

const dashboardSections: Array<{ title: string; tiles: DashboardTile[] }> = [
  {
    title: "Operations",
    tiles: [
      {
        key: "bookings",
        title: "Bookings",
        description: "View and manage active and scheduled bookings."
      },
      {
        key: "active-drivers",
        title: "Active Drivers",
        description: "Entry point for active drivers and map monitoring."
      },
      {
        key: "financial-reports",
        title: "Financial Reports",
        description: "Revenue and finance reporting access."
      }
    ]
  },
  {
    title: "Management",
    tiles: [
      {
        key: "customers",
        title: "Customers",
        description: "Add, edit, suspend, or remove customer records."
      },
      {
        key: "staff",
        title: "Staff",
        description: "Add, edit, suspend, or remove staff records."
      },
      {
        key: "drivers",
        title: "Drivers",
        description: "Add, edit, suspend, or remove driver records."
      },
      {
        key: "vehicles",
        title: "Vehicles",
        description: "Manage fleet vehicles and availability."
      }
    ]
  },
  {
    title: "Platform",
    tiles: [
      {
        key: "core-settings",
        title: "Core Settings",
        description: "Umbrella entry point for deeper platform configuration."
      },
      {
        key: "quick-system-check",
        title: "Quick System Check",
        description: "Lightweight system health and status checks."
      },
      {
        key: "backup-recovery",
        title: "Backup & Recovery",
        description: "Manual backup and controlled recovery workflow entry point."
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

      if (!roles.includes("admin")) {
        return res.redirect("/account");
      }

      const requestedTileKey = String(req.query.tile || "");
      const selectedTile = allTiles.find((tile) => tile.key === requestedTileKey);
      const selectedOperationalAction = operationalMenuRows
        .flatMap((row) =>
          row.actions.map((action) => ({
            category: row.category,
            label: action.label,
            externalMode: action.externalMode,
            href: action.href
          }))
        )
        .find((action) => action.href === `/dashboard?tile=${requestedTileKey}`) satisfies
        SelectedOperationalAction | undefined;

      return res.render("pages/dashboard", {
        title: "Admin Dashboard",
        appTitle: options.appTitle,
        email: session.user.email,
        operationalMenuRows,
        sections: dashboardSections,
        selectedOperationalAction,
        selectedTile
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
