import { Router, type Response } from "express";
import { getSessionAccount } from "../services/api";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getInternalRoleLabel } from "../services/staff-users";

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

/**
 * Session role keys that grant the workspace. Matching is exact against the
 * `roles.key` values returned by the auth service's `/auth/session`; display
 * labels (e.g. "System Control") or case variants never grant access.
 */
export function grantingRoles(roles: string[], module: WorkspaceModule): string[] {
  return module.allowedRoles.filter((role) => roles.includes(role));
}

function formatRoleLabel(role: string): string {
  return `${getInternalRoleLabel(role)} (${role})`;
}

export function describeRequiredRoles(module: WorkspaceModule): string {
  return module.allowedRoles.map(getInternalRoleLabel).join(" or ");
}

function renderUnavailable(res: Response, appTitle: string, module: WorkspaceModule) {
  return res.status(403).render("pages/unavailable", {
    title: "Unavailable",
    appTitle,
    message: `Your current session does not include the ${describeRequiredRoles(module)} role required for ${module.title}.`
  });
}

export function createRoleSectionsRouter(options: RoleSectionsRouterOptions): Router {
  const router = Router();
  router.use(noStoreProtectedResponse);

  for (const module of workspaceModules.filter((item) => item.key !== "administration" && item.key !== "staff")) {
    router.get(module.href, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, module.key)) return renderUnavailable(res, options.appTitle, module);

        return res.render("pages/role-section", {
          title: module.title, appTitle: options.appTitle, email: session.user.email,
          roleLabel: module.title, module,
          grantedByLabel: grantingRoles(roles, module)
            .map(formatRoleLabel)
            .join(", ")
        });
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}
