import { Router } from "express";
import { getSessionAccount } from "../services/api";
import { canManageStaff, listStaffUsers } from "../services/staff";

type StaffRouterOptions = {
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

function formatDate(value: string | null): string {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

async function requireStaffManagementSession(
  cookieHeader: string | undefined
): Promise<{ email: string; activeRoleLabel: string }> {
  const session = await getSessionAccount(cookieHeader);

  if (!session.authenticated || !session.user) {
    throw new Error("unauthenticated");
  }

  const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
  const authorized = await canManageStaff(roles);

  if (!authorized) {
    throw new Error("forbidden");
  }

  return {
    email: session.user.email,
    activeRoleLabel: getRoleLabel(session.user.active_role || "admin")
  };
}

export function createStaffRouter(options: StaffRouterOptions): Router {
  const router = Router();

  router.get("/staff", async (req, res, next) => {
    try {
      const session = await requireStaffManagementSession(req.headers.cookie);
      const staff = await listStaffUsers();

      return res.render("pages/staff/index", {
        title: "Staff",
        appTitle: options.appTitle,
        email: session.email,
        activeRoleLabel: session.activeRoleLabel,
        staffCount: staff.length,
        staff: staff.map((member) => ({
          ...member,
          roleLabels: member.roles.map(getRoleLabel),
          formattedCreatedAt: formatDate(member.createdAt),
          formattedLastLoginAt: formatDateTime(member.lastLoginAt)
        }))
      });
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }
  });

  return router;
}
