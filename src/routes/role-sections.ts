import { Router, type Response } from "express";
import { query } from "../database/connection";
import { getSessionAccount } from "../services/api";

type RoleSectionsRouterOptions = {
  appTitle: string;
};

export type WorkspaceModule = {
  key: string;
  title: string;
  description: string;
  href: string;
  allowedRoles: string[];
};

export const workspaceModules: WorkspaceModule[] = [
  { key: "administration", title: "Administration", description: "Operations, customer management, and administration.", href: "/dashboard", allowedRoles: ["admin"] },
  { key: "system-settings", title: "System settings", description: "Privileged platform configuration.", href: "/settings", allowedRoles: ["superuser"] },
  { key: "staff", title: "Staff", description: "View internal user accounts and their roles.", href: "/staff", allowedRoles: ["admin"] },
  { key: "technical-support", title: "Technical Support", description: "Technical diagnostics and support tools.", href: "/tech-support", allowedRoles: ["tech_support"] },
  { key: "manage-vps", title: "Manage VPS", description: "Privileged reboot and recovery entry point.", href: "/vps", allowedRoles: ["superuser"] }
];

export function availableWorkspaceModules(roles: string[]): WorkspaceModule[] {
  return workspaceModules.filter((module) => module.allowedRoles.some((role) => roles.includes(role)));
}

export function canAccessWorkspace(roles: string[], key: string): boolean {
  return availableWorkspaceModules(roles).some((module) => module.key === key);
}

function renderUnavailable(res: Response, appTitle: string) {
  return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle });
}

export function createRoleSectionsRouter(options: RoleSectionsRouterOptions): Router {
  const router = Router();

  for (const module of workspaceModules.filter((item) => item.key !== "administration")) {
    router.get(module.href, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, module.key)) return renderUnavailable(res, options.appTitle);

        if (module.key === "staff") {
          const staff = await query<{ email: string; status: string; roles: string[] | null }>(`
            SELECT u.email, u.status, array_remove(array_agg(r.name ORDER BY r.name), NULL) AS roles
            FROM users u
            LEFT JOIN user_roles ur ON ur.user_id = u.id
            LEFT JOIN roles r ON r.id = ur.role_id
            GROUP BY u.id, u.email, u.status
            ORDER BY u.email
            LIMIT 100
          `);
          return res.render("pages/staff", { title: "Staff", appTitle: options.appTitle, email: session.user.email, staff: staff.rows });
        }

        return res.render("pages/role-section", {
          title: module.title, appTitle: options.appTitle, email: session.user.email,
          roleLabel: module.title, module
        });
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}
