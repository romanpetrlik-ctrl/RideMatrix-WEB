import { Router, type NextFunction, type Request, type Response } from "express";
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

const systemSettingsModule: WorkspaceModule = {
  key: "system-settings",
  title: "System settings",
  description: "Privileged platform configuration.",
  href: "/settings",
  allowedRoles: ["superuser"]
};

export const workspaceModules: WorkspaceModule[] = [
  { key: "administration", title: "Administration", description: "Operations, customer management, and administration.", href: "/dashboard", allowedRoles: ["admin"] },
  systemSettingsModule,
  { key: "staff", title: "Staff", description: "View internal user accounts and their roles.", href: "/staff", allowedRoles: ["admin"] },
  { key: "technical-support", title: "Technical Support", description: "Technical diagnostics and support tools.", href: "/tech-support", allowedRoles: ["tech_support"] },
  { key: "manage-vps", title: "Manage VPS", description: "Privileged reboot and recovery entry point.", href: "/vps", allowedRoles: ["superuser"] }
];

export const tollFeeCategories = [
  { slug: "airport-fees", title: "Airport fees", description: "Airport-specific fees and associated reference information." },
  { slug: "clean-air-zones", title: "Clean Air Zones (CAZ)", description: "Clean Air Zone boundaries, rules, and fee schedules." },
  { slug: "london-lez-ulez-congestion-charge", title: "London: LEZ, ULEZ & Congestion Charge", description: "London zone boundaries, rules, and fee schedules." },
  { slug: "dartford-crossing", title: "Dartford Crossing", description: "Crossing rules and fee schedules." },
  { slug: "blackwall-silvertown-tunnels", title: "Blackwall & Silvertown tunnels", description: "Tunnel rules and fee schedules." }
] as const;

const referenceDataDescription =
  "Reference data (managed) is for versioned geographic boundaries and source/rule metadata. It will be updated through a controlled process, separately from ordinary fee settings.";
const feeSettingsDescription =
  "Fee settings are for configurable fee schedules. They are kept separate from reference data so schedules can be managed independently.";

type TollFeeSection = "reference-data" | "fee-settings";

type TollFeesPage = {
  category?: (typeof tollFeeCategories)[number];
  section?: TollFeeSection;
};

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

async function renderTollFeesPage(
  req: Request,
  res: Response,
  next: NextFunction,
  appTitle: string,
  page: TollFeesPage
): Promise<void> {
  try {
    const session = await getSessionAccount(req.headers.cookie);
    if (!session.authenticated || !session.user) {
      res.redirect("/access");
      return;
    }

    const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
    if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
      renderUnavailable(res, appTitle, systemSettingsModule);
      return;
    }

    const title = page.section && page.category
      ? `${page.category.title}: ${page.section === "reference-data" ? "Reference data (managed)" : "Fee settings"}`
      : page.category?.title ?? "Toll & Fees";
    res.render("pages/toll-fees", {
      title,
      appTitle,
      email: session.user.email,
      grantedByLabel: grantingRoles(roles, systemSettingsModule).map(formatRoleLabel).join(", "),
      categories: tollFeeCategories,
      category: page.category,
      section: page.section,
      referenceDataDescription,
      feeSettingsDescription
    });
  } catch (error) {
    next(error);
  }
}

export function createRoleSectionsRouter(options: RoleSectionsRouterOptions): Router {
  const router = Router();
  router.use(noStoreProtectedResponse);

  router.get("/settings/toll-fees", (req, res, next) => {
    void renderTollFeesPage(req, res, next, options.appTitle, {});
  });

  for (const category of tollFeeCategories) {
    const categoryPath = `/settings/toll-fees/${category.slug}`;
    router.get(categoryPath, (req, res, next) => {
      void renderTollFeesPage(req, res, next, options.appTitle, { category });
    });

    for (const section of ["reference-data", "fee-settings"] as const) {
      router.get(`${categoryPath}/${section}`, (req, res, next) => {
        void renderTollFeesPage(req, res, next, options.appTitle, { category, section });
      });
    }
  }

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
