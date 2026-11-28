import { Router } from "express";
import { getSessionAccount } from "../services/api";
import { noStoreProtectedResponse } from "../middleware/no-store";

type DashboardRouterOptions = {
  appTitle: string;
};

type OperationalMenuAction = {
  label: string;
  href: string;
};

type OperationalMenuRow = {
  category: string;
  actions: OperationalMenuAction[];
};

export const operationalMenuRows: OperationalMenuRow[] = [
  {
    category: "Bookings",
    actions: [
      { label: "New", href: "/bookings/new" },
      { label: "Today", href: "/bookings?view=today" },
      { label: "Upcoming", href: "/bookings?view=upcoming" },
      { label: "Past", href: "/bookings?view=past" },
      { label: "Calendar", href: "/calendar" }
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
    category: "Drivers",
    actions: [{ label: "All drivers", href: "/drivers" }]
  },
  {
    category: "Vehicles",
    actions: [
      { label: "Active vehicles", href: "/vehicles?status=active" },
      { label: "All vehicles", href: "/vehicles" }
    ]
  },
  {
    category: "Staff",
    actions: [{ label: "All staff", href: "/staff" }]
  }
];

export function createDashboardRouter(options: DashboardRouterOptions): Router {
  const router = Router();
  router.use(noStoreProtectedResponse);

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

      if (!roles.includes("admin")) return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });

      return res.render("pages/dashboard", {
        title: "Admin Dashboard",
        appTitle: options.appTitle,
        email: session.user.email,
        operationalMenuRows
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
