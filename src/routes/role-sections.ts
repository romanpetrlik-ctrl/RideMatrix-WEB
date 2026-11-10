import { Router, type NextFunction, type Request, type Response } from "express";
import { getSessionAccount } from "../services/api";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { requireCsrfToken } from "../middleware/csrf";
import { getInternalRoleLabel } from "../services/staff-users";
import {
  airportFeeRecordToForm,
  airportFeeStore,
  formatAirportPickupTimingRule,
  validateAirportFeeForm,
  type AirportFeeFormValues,
  type AirportFeeRecord,
  type AirportFeeStore
} from "../services/airport-fees";
import {
  londonFeeScheduleStore,
  LondonFeeScheduleVersionConflictError,
  type LondonFeeScheduleScheme,
  type LondonFeeScheduleSnapshot,
  type LondonFeeScheduleStore,
  validateLondonFeeRateAmounts
} from "../services/london-fee-schedules";
import { getLondonLezBoundary, londonLezBoundaryMetadata } from "../services/london-lez-boundary";
import { getLondonUlezBoundary, londonUlezBoundaryMetadata } from "../services/london-ulez-boundary";
import {
  getLondonCongestionChargeBoundary,
  londonCongestionChargeBoundaryMetadata
} from "../services/london-congestion-charge-boundary";
import { readMapConfiguration } from "../services/maps";

type RoleSectionsRouterOptions = {
  appTitle: string;
  feeScheduleStore?: LondonFeeScheduleStore;
  airportFeeStore?: AirportFeeStore;
};

type TollFeesRenderOptions = {
  feeScheduleSnapshot?: LondonFeeScheduleSnapshot;
  feeScheduleErrors?: Record<string, string>;
  feeScheduleFormError?: string;
  submittedAmounts?: Record<string, string>;
  airportFeeRecords?: AirportFeeRecord[];
  airportFeeForm?: AirportFeeFormValues;
  airportFeeErrors?: Record<string, string>;
  airportFeeFormError?: string;
  airportFeeSaved?: boolean;
  airportFeeArchived?: boolean;
  statusCode?: number;
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

export type TollFeeArea = {
  slug: string;
  title: string;
  description: string;
};

export type TollFeeCategory = {
  slug: string;
  title: string;
  description: string;
  /** Scheme areas nested under the category. Each area has its own two destinations. */
  areas?: readonly TollFeeArea[];
};

export const tollFeeCategories: readonly TollFeeCategory[] = [
  { slug: "airport-fees", title: "Airport fees", description: "Configure airport pickup and drop-off locations and fees." },
  {
    slug: "clean-air-zones",
    title: "Clean Air Zones (CAZ)",
    description: "Clean Air Zone boundaries, rules, and fee schedules.",
    areas: [
      { slug: "bath", title: "Bath", description: "Clean Air Zone boundaries, rules, and fee schedules for Bath." },
      { slug: "birmingham", title: "Birmingham", description: "Clean Air Zone boundaries, rules, and fee schedules for Birmingham." },
      { slug: "bradford", title: "Bradford", description: "Clean Air Zone boundaries, rules, and fee schedules for Bradford." },
      { slug: "bristol", title: "Bristol", description: "Clean Air Zone boundaries, rules, and fee schedules for Bristol." },
      { slug: "portsmouth", title: "Portsmouth", description: "Clean Air Zone boundaries, rules, and fee schedules for Portsmouth." },
      { slug: "sheffield", title: "Sheffield", description: "Clean Air Zone boundaries, rules, and fee schedules for Sheffield." },
      {
        slug: "tyneside",
        title: "Tyneside (Newcastle and Gateshead)",
        description: "Clean Air Zone boundaries, rules, and fee schedules for Tyneside (Newcastle and Gateshead)."
      }
    ]
  },
  {
    slug: "london-lez-ulez-congestion-charge",
    title: "London: LEZ, ULEZ & Congestion Charge",
    description: "London zone boundaries, rules, and fee schedules.",
    areas: [
      { slug: "london-lez", title: "London LEZ", description: "London Low Emission Zone boundaries, rules, and fee schedules." },
      { slug: "london-ulez", title: "London ULEZ", description: "London Ultra Low Emission Zone boundaries, rules, and fee schedules." },
      { slug: "london-congestion-charge", title: "London Congestion Charge", description: "London Congestion Charge boundaries, rules, and fee schedules." }
    ]
  },
  { slug: "dartford-crossing", title: "Dartford Crossing", description: "Crossing rules and fee schedules." },
  { slug: "blackwall-silvertown-tunnels", title: "Blackwall & Silvertown tunnels", description: "Tunnel rules and fee schedules." }
];

const referenceDataDescription =
  "Reference data (managed) is for versioned geographic boundaries and source/rule metadata. It will be updated through a controlled process, separately from ordinary fee settings.";
const feeSettingsDescription =
  "Fee settings are for configurable fee schedules. They are kept separate from reference data so schedules can be managed independently.";

type TollFeeSection = "reference-data" | "fee-settings";

type TollFeesPage = {
  category?: TollFeeCategory;
  area?: TollFeeArea;
  section?: TollFeeSection;
};

type Breadcrumb = { label: string; href?: string };

const emptyAirportFeeForm: AirportFeeFormValues = {
  id: "",
  displayName: "",
  dropoffPlaceId: "",
  dropoffLocationLabel: "",
  dropoffLatitude: "",
  dropoffLongitude: "",
  dropoffFee: "",
  pickupPlaceId: "",
  pickupLocationLabel: "",
  pickupLatitude: "",
  pickupLongitude: "",
  pickupFee: "",
  pickupTimeReference: "",
  pickupDeferredPolicy: "",
  pickupDeferredMinutes: "",
  pickupFeeCoveredMinutes: ""
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function sectionLabel(section: TollFeeSection): string {
  return section === "reference-data" ? "Reference data (managed)" : "Fee settings";
}

/**
 * Builds the breadcrumb trail for a page. The final entry has no href so the
 * template renders it as the current page; its parent is the back link.
 */
function buildBreadcrumbs(page: TollFeesPage): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [
    { label: "System Settings", href: "/settings" },
    { label: "Toll & Fees", href: "/settings/toll-fees" }
  ];

  if (page.category) {
    const categoryPath = `/settings/toll-fees/${page.category.slug}`;
    crumbs.push({ label: page.category.title, href: categoryPath });
    if (page.area) crumbs.push({ label: page.area.title, href: `${categoryPath}/${page.area.slug}` });
  }
  if (page.section) crumbs.push({ label: sectionLabel(page.section) });
  // The last crumb is the current page, so it is rendered without a link.
  delete crumbs[crumbs.length - 1].href;
  return crumbs;
}

function leafPathFor(page: TollFeesPage): string | undefined {
  if (!page.category) return undefined;
  return `/settings/toll-fees/${page.category.slug}${page.area ? `/${page.area.slug}` : ""}`;
}


function pageTitle(page: TollFeesPage): string {
  if (!page.category) return "Toll & Fees";
  const name = page.area?.title ?? page.category.title;
  return page.section ? `${name}: ${sectionLabel(page.section)}` : name;
}

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
  page: TollFeesPage,
  feeScheduleStore: LondonFeeScheduleStore,
  airportFeesStore: AirportFeeStore,
  renderOptions: TollFeesRenderOptions = {}
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

    const breadcrumbs = buildBreadcrumbs(page);
    const mapConfiguration = readMapConfiguration();
    const feeScheduleScheme: LondonFeeScheduleScheme | undefined = page.section !== "fee-settings"
      ? undefined
      : page.area?.slug === "london-lez" || page.category?.slug === "london-lez"
        ? "london-lez"
        : page.area?.slug === "london-ulez" || page.category?.slug === "london-ulez"
          ? "london-ulez"
          : page.category?.slug === "dartford-crossing" || page.area?.slug === "dartford-crossing"
            ? "dartford-crossing"
            : page.category?.slug === "blackwall-silvertown-tunnels" || page.area?.slug === "blackwall-silvertown-tunnels"
              ? "blackwall-silvertown-tunnels"
              : undefined;
    const feeScheduleSnapshot = renderOptions.feeScheduleSnapshot ??
      (feeScheduleScheme ? await feeScheduleStore.load(feeScheduleScheme) : undefined);
    const airportEditingId = page.category?.slug === "airport-fees" && typeof req.query.edit === "string"
      ? req.query.edit
      : "";
    const airportEditingRecord = airportEditingId ? await airportFeesStore.get(airportEditingId) : null;
    if (airportEditingId && !airportEditingRecord) {
      res.status(404).render("pages/unavailable", { title: "Not found", appTitle });
      return;
    }
    const airportFeeRecords = page.category?.slug === "airport-fees"
      ? (renderOptions.airportFeeRecords ?? await airportFeesStore.list()).map((record) => ({
        ...record,
        id: escapeHtml(record.id),
        displayName: escapeHtml(record.displayName),
        dropoffLocationLabel: escapeHtml(record.dropoffLocationLabel),
        dropoffFee: escapeHtml(record.dropoffFee),
        pickupLocationLabel: escapeHtml(record.pickupLocationLabel),
        pickupFee: escapeHtml(record.pickupFee),
        pickupTimingSummary: escapeHtml(formatAirportPickupTimingRule(record))
      }))
      : [];
    const airportFeeForm = Object.fromEntries(
      Object.entries(renderOptions.airportFeeForm ?? (airportEditingRecord ? airportFeeRecordToForm(airportEditingRecord) : emptyAirportFeeForm))
        .map(([key, value]) => [key, escapeHtml(value)])
    ) as AirportFeeFormValues;
    const londonUlezBoundary = page.area?.slug === "london-ulez" && page.section === "reference-data"
      ? getLondonUlezBoundary()
      : undefined;
    res.status(renderOptions.statusCode ?? 200).render("pages/toll-fees", {
      title: pageTitle(page),
      appTitle,
      email: session.user.email,
      grantedByLabel: grantingRoles(roles, systemSettingsModule).map(formatRoleLabel).join(", "),
      categories: tollFeeCategories,
      category: page.category,
      area: page.area,
      section: page.section,
      breadcrumbs,
      parentCrumb: breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2] : undefined,
      leafPath: leafPathFor(page),
      leafTitle: page.area?.title ?? page.category?.title,
      referenceDataDescription,
      feeSettingsDescription,
      feeScheduleSnapshot,
      airportFeeRecords,
      airportFeeForm,
      airportFeeTimingSetupIncomplete: Boolean(
        airportEditingRecord && formatAirportPickupTimingRule(airportEditingRecord).startsWith("Setup incomplete:")
      ),
      airportFeeErrors: renderOptions.airportFeeErrors ?? {},
      airportFeeFormError: renderOptions.airportFeeFormError,
      airportFeeSaved: renderOptions.airportFeeSaved ?? req.query.saved === "1",
      airportFeeArchived: renderOptions.airportFeeArchived ?? req.query.archived === "1",
      airportFeeMapConfigured: Boolean(mapConfiguration.enabled && mapConfiguration.browserApiKey),
      airportFeeMapBrowserApiKey: mapConfiguration.enabled
        ? escapeHtml(mapConfiguration.browserApiKey ?? "")
        : "",
      feeScheduleErrors: renderOptions.feeScheduleErrors ?? {},
      feeScheduleFormError: renderOptions.feeScheduleFormError,
      feeScheduleSaved: req.query.saved === "1",
      submittedAmounts: renderOptions.submittedAmounts ?? {},
      escapedFeeScheduleHistory: feeScheduleSnapshot?.history.map((record) => ({
        ...record,
        actorEmail: record.actorEmail?.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") ?? "Initial supplied draft"
      })),
      londonLezBoundaryMetadata,
      londonCongestionChargeBoundaryMetadata: page.area?.slug === "london-congestion-charge" && page.section === "reference-data"
        ? londonCongestionChargeBoundaryMetadata
        : undefined,
      londonLezMapConfigured: Boolean(mapConfiguration.enabled && mapConfiguration.browserApiKey),
      londonLezMapBrowserApiKey: mapConfiguration.enabled
        ? mapConfiguration.browserApiKey?.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        : undefined,
      londonLezMapId: mapConfiguration.mapId
        ?.replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;"),
      londonUlezBoundaryMetadata: londonUlezBoundary
        ? {
          ...londonUlezBoundaryMetadata,
          sourceDatasetLabels: [...new Set(londonUlezBoundary.features.map((feature) => String(feature.properties.DATASET)))],
          dateCreatedValues: [...new Set(londonUlezBoundary.features.map((feature) => String(feature.properties.DATE_CREAT)))]
        }
        : undefined,
      londonUlezMapConfigured: Boolean(mapConfiguration.enabled && mapConfiguration.browserApiKey),
      londonUlezMapBrowserApiKey: mapConfiguration.enabled
        ? mapConfiguration.browserApiKey?.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        : undefined,
      londonUlezMapId: mapConfiguration.mapId
        ?.replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;"),
      londonCongestionChargeMapConfigured: Boolean(mapConfiguration.enabled && mapConfiguration.browserApiKey),
      londonCongestionChargeMapBrowserApiKey: mapConfiguration.enabled
        ? mapConfiguration.browserApiKey?.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        : undefined,
      londonCongestionChargeMapId: mapConfiguration.mapId
        ?.replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
    });
  } catch (error) {
    next(error);
  }
}

export function createRoleSectionsRouter(options: RoleSectionsRouterOptions): Router {
  const router = Router();
  const feeScheduleStore = options.feeScheduleStore ?? londonFeeScheduleStore;
  const airportFeesStore = options.airportFeeStore ?? airportFeeStore;
  const csrfGuard = requireCsrfToken({ appTitle: options.appTitle });
  router.use(noStoreProtectedResponse);

  router.get(
    "/settings/toll-fees/london-lez-ulez-congestion-charge/london-lez/reference-data/boundary.json",
    async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) {
          res.status(401).json({ error: "Authentication required." });
          return;
        }

        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          res.status(403).json({ error: "System settings access is required." });
          return;
        }

        res.json(getLondonLezBoundary());
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/settings/toll-fees/london-lez-ulez-congestion-charge/london-ulez/reference-data/boundary.json",
    async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) {
          res.status(401).json({ error: "Authentication required." });
          return;
        }

        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          res.status(403).json({ error: "System settings access is required." });
          return;
        }

        res.json(getLondonUlezBoundary());
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/settings/toll-fees/london-lez-ulez-congestion-charge/london-congestion-charge/reference-data/boundary.json",
    async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) {
          res.status(401).json({ error: "Authentication required." });
          return;
        }

        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          res.status(403).json({ error: "System settings access is required." });
          return;
        }

        res.json(getLondonCongestionChargeBoundary());
      } catch (error) {
        next(error);
      }
    }
  );

  const registerFeeSchedulePost = (
    path: string,
    scheme: LondonFeeScheduleScheme,
    page: TollFeesPage
  ) => {
    router.post(path, requireCsrfToken({ appTitle: options.appTitle }), async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");

        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          return renderUnavailable(res, options.appTitle, systemSettingsModule);
        }

        const snapshot = await feeScheduleStore.load(scheme);
        const { amounts, errors } = validateLondonFeeRateAmounts(snapshot.schedule, req.body);
        const rawVersion = req.body?.baseVersion;
        const expectedVersion = typeof rawVersion === "string" && /^\d+$/.test(rawVersion)
          ? Number(rawVersion)
          : NaN;
        const submittedAmounts = Object.fromEntries(snapshot.schedule.rates.map((rate) => {
          const raw = req.body?.[`amount_${rate.key}`];
          return [rate.key, typeof raw === "string" ? raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") : ""];
        }));
        const feeSettingsPage: TollFeesPage = { ...page, section: "fee-settings" };

        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
          return renderTollFeesPage(req, res, next, options.appTitle, feeSettingsPage, feeScheduleStore, airportFeesStore, {
            feeScheduleSnapshot: snapshot,
            feeScheduleErrors: errors,
            feeScheduleFormError: "The draft version is missing or invalid. Reload this page before saving.",
            submittedAmounts,
            statusCode: 400
          });
        }
        if (Object.keys(errors).length > 0) {
          return renderTollFeesPage(req, res, next, options.appTitle, feeSettingsPage, feeScheduleStore, airportFeesStore, {
            feeScheduleSnapshot: snapshot,
            feeScheduleErrors: errors,
            submittedAmounts,
            statusCode: 400
          });
        }

        try {
          await feeScheduleStore.save(scheme, expectedVersion, amounts, {
            accountId: session.user.id,
            email: session.user.email
          });
        } catch (error) {
          if (!(error instanceof LondonFeeScheduleVersionConflictError)) throw error;
          const latest = await feeScheduleStore.load(scheme);
          return renderTollFeesPage(req, res, next, options.appTitle, feeSettingsPage, feeScheduleStore, airportFeesStore, {
            feeScheduleSnapshot: latest,
            feeScheduleFormError: error.message,
            statusCode: 409
          });
        }

        return res.redirect(303, `${path}?saved=1`);
      } catch (error) {
        return next(error);
      }
    });
  };

  const registerAirportFeesRoutes = (path: string, category: TollFeeCategory) => {
    router.get(path, (req, res, next) => {
      void renderTollFeesPage(req, res, next, options.appTitle, { category }, feeScheduleStore, airportFeesStore);
    });

    router.post(path, csrfGuard, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          return renderUnavailable(res, options.appTitle, systemSettingsModule);
        }

        const { values, errors } = validateAirportFeeForm(req.body);
        const recordId = values.id || null;
        if (!recordId && req.body?.id) errors.form = "The selected airport record is invalid. Reload the page and try again.";
        if (Object.keys(errors).length > 0) {
          return renderTollFeesPage(req, res, next, options.appTitle, { category }, feeScheduleStore, airportFeesStore, {
            airportFeeRecords: await airportFeesStore.list(),
            airportFeeForm: values,
            airportFeeErrors: errors,
            statusCode: 400
          });
        }

        const record = await airportFeesStore.save(recordId, values, {
          accountId: session.user.id,
          email: session.user.email
        });
        if (!record) {
          return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
        }
        return res.redirect(303, `${path}?saved=1`);
      } catch (error) {
        next(error);
      }
    });

    router.post(`${path}/:airportId/delete`, csrfGuard, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          return renderUnavailable(res, options.appTitle, systemSettingsModule);
        }

        const archived = await airportFeesStore.archive(String(req.params.airportId), {
          accountId: session.user.id,
          email: session.user.email
        });
        if (!archived) {
          return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
        }
        return res.redirect(303, `${path}?archived=1`);
      } catch (error) {
        next(error);
      }
    });
  };

  router.get("/settings/toll-fees", (req, res, next) => {
    void renderTollFeesPage(req, res, next, options.appTitle, {}, feeScheduleStore, airportFeesStore);
  });

  for (const category of tollFeeCategories) {
    const categoryPath = `/settings/toll-fees/${category.slug}`;
    if (category.slug === "airport-fees") {
      registerAirportFeesRoutes(categoryPath, category);
      continue;
    }

    router.get(categoryPath, (req, res, next) => {
      void renderTollFeesPage(req, res, next, options.appTitle, { category }, feeScheduleStore, airportFeesStore);
    });

    if (category.areas) {
      for (const area of category.areas) {
        const areaPath = `${categoryPath}/${area.slug}`;
        router.get(areaPath, (req, res, next) => {
          void renderTollFeesPage(req, res, next, options.appTitle, { category, area }, feeScheduleStore, airportFeesStore);
        });

        for (const section of ["reference-data", "fee-settings"] as const) {
          router.get(`${areaPath}/${section}`, (req, res, next) => {
            void renderTollFeesPage(req, res, next, options.appTitle, { category, area, section }, feeScheduleStore, airportFeesStore);
          });
        }

        if (area.slug === "london-lez" || area.slug === "london-ulez") {
          const scheme: LondonFeeScheduleScheme = area.slug;
          registerFeeSchedulePost(`${areaPath}/fee-settings`, scheme, { category, area });
        }
      }
      continue;
    }

    for (const section of ["reference-data", "fee-settings"] as const) {
      router.get(`${categoryPath}/${section}`, (req, res, next) => {
        void renderTollFeesPage(req, res, next, options.appTitle, { category, section }, feeScheduleStore, airportFeesStore);
      });
    }

    if (category.slug === "dartford-crossing" || category.slug === "blackwall-silvertown-tunnels") {
      registerFeeSchedulePost(`${categoryPath}/fee-settings`, category.slug, { category });
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
