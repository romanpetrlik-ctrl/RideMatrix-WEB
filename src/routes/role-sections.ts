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
import {
  activationBlockers,
  isRoadChargeSchedule,
  RoadChargeActivationError,
  validateRoadChargeScheduleEdit,
  type RoadChargeSchedule
} from "../services/road-charge-schedules";
import { getLondonLezBoundary, londonLezBoundaryMetadata } from "../services/london-lez-boundary";
import { getLondonUlezBoundary, londonUlezBoundaryMetadata } from "../services/london-ulez-boundary";
import {
  getLondonCongestionChargeBoundary,
  londonCongestionChargeBoundaryMetadata
} from "../services/london-congestion-charge-boundary";
import { readMapConfiguration } from "../services/maps";
import {
  getOperationalBase,
  isOperationalBaseVerified,
  type OperationalBase
} from "../services/dead-mileage";
import {
  additionalSlabTargetKey,
  type AdditionalDistanceSlabSet,
  type AdditionalDistanceSlabSetFormValues,
  fareSettingsStore,
  FareSettingsVersionConflictError,
  fixedFareRuleToForm,
  locationDiscountRuleToForm,
  radiusLocationDiscountRuleToForm,
  validateFixedFareRuleForm,
  validateLocationDiscountForm,
  validateRadiusLocationDiscountForm,
  validateMinimumFareRuleForm,
  resolveAdditionalDistanceSlabSets,
  validateAdditionalDistanceSlabSetForm,
  validateDistanceSlabsForm,
  withAdditionalDistanceSlabSets,
  validateDeadMileageRadius,
  validateFareSettingsForm,
  type FareSettingsConfiguration,
  type FixedFareRule,
  type FixedFareRuleFormValues,
  type LocationDiscountFormValues,
  type LocationDiscountRule,
  type RadiusLocationDiscountFormValues,
  type RadiusLocationDiscountRule,
  type MinimumFareRule,
  type MinimumFareRuleFormValues,
  type FareSettingsSnapshot,
  type FareSettingsStore,
  type ManagedSlabTarget
} from "../services/fare-settings";
import { poiManagementStore, type PoiManagementStore } from "../services/poi-management";
import {
  parseHistoryPageParam,
  RECENT_CONFIGURATION_HISTORY_LIMIT,
  type ConfigurationHistoryEntry,
  type ConfigurationHistoryPage
} from "../services/configuration-history";
import { randomUUID } from "node:crypto";

type RoleSectionsRouterOptions = {
  appTitle: string;
  feeScheduleStore?: LondonFeeScheduleStore;
  airportFeeStore?: AirportFeeStore;
  fareSettingsStore?: FareSettingsStore;
  poiManagementStore?: PoiManagementStore;
  loadOperationalBase?: () => Promise<OperationalBase | null>;
};

type TollFeesRenderOptions = {
  feeScheduleSnapshot?: LondonFeeScheduleSnapshot;
  feeScheduleErrors?: Record<string, string>;
  feeScheduleFormError?: string;
  submittedAmounts?: Record<string, string>;
  submittedEffectiveDates?: { effectiveFrom: string; effectiveUntil: string };
  activationErrors?: string[];
  submittedVerifiedOn?: string;
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
  { key: "driver-journeys", title: "Driver journeys", description: "View assigned journeys and update live ride progress.", href: "/driver", allowedRoles: ["driver"] },
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

export type FareSettingsCategory = {
  slug: string;
  title: string;
  description: string;
  configurable: boolean;
};

export const fareSettingsCategories: readonly FareSettingsCategory[] = [
  { slug: "minimum-fare-rules", title: "Minimum fare rules", description: "Configure minimum base fares for journeys with a selected managed location as origin or destination.", configurable: true },
  { slug: "fixed-fares", title: "Fixed fares", description: "Configure directional fixed base fares between identified locations.", configurable: true },
  { slug: "location-based-discounts", title: "Location-based discounts", description: "Configure percentage discounts for journeys between a managed airport or POI and explicit UK postcodes. Not yet applied to booking prices.", configurable: true },
  { slug: "operational-base-radius-discounts", title: "Operational-base radius discounts", description: "Configure percentage discounts for journeys between a managed airport or POI and anywhere within a radius of the verified operational base. Not yet applied to booking prices.", configurable: true },
  { slug: "distance-slabs", title: "Distance slabs", description: "Configure progressive base rates by journey distance.", configurable: true },
  { slug: "additional-distance-slabs", title: "Additional distance slabs", description: "Configure independent progressive slab sets, each linked to one managed airport or POI. Configuration only; not yet used to price bookings.", configurable: true },
  { slug: "dead-mileage-settings", title: "Dead mileage settings", description: "Configure the free-radius circle around the verified operational base.", configurable: true },
  { slug: "extras", title: "Extras", description: "Future configuration for fare extras.", configurable: false },
  { slug: "fare-surcharge-settings", title: "Fare surcharge settings", description: "Configure a recurring daily fare surcharge.", configurable: true },
  { slug: "bank-holiday-fare-settings", title: "Bank holiday fare settings", description: "Configure explicit date and time surcharge periods.", configurable: true }
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

function safeHistoryEntries(entries: ConfigurationHistoryEntry[], fallbackActor: string) {
  return entries.map((entry) => ({
    version: entry.version,
    actorEmail: entry.actorEmail ? escapeHtml(entry.actorEmail) : fallbackActor,
    createdAt: escapeHtml(entry.createdAt)
  }));
}

/** Inline history on a settings page: only the most recent entries plus an optional full-history link. */
function recentHistoryView(entries: ConfigurationHistoryEntry[], total: number, historyHref: string, fallbackActor: string) {
  return {
    entries: safeHistoryEntries(entries.slice(0, RECENT_CONFIGURATION_HISTORY_LIMIT), fallbackActor),
    total,
    href: total > RECENT_CONFIGURATION_HISTORY_LIMIT ? historyHref : ""
  };
}

type ConfigurationHistoryPageOptions = {
  title: string;
  heading: string;
  pageMeta: string;
  breadcrumbs: Breadcrumb[];
  basePath: string;
  backHref: string;
  backLabel: string;
  fallbackActor: string;
  emptyMessage: string;
  loadPage: (page: number) => Promise<ConfigurationHistoryPage>;
};

/** Dedicated, paginated configuration history page; authorized exactly like System Settings pages. */
async function renderConfigurationHistoryPage(
  req: Request,
  res: Response,
  next: NextFunction,
  appTitle: string,
  view: ConfigurationHistoryPageOptions
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

    const result = await view.loadPage(parseHistoryPageParam(req.query.page));
    const hrefFor = (page: number) => page > 1 ? `${view.basePath}?page=${page}` : view.basePath;
    res.render("pages/configuration-history", {
      title: view.title,
      appTitle,
      email: escapeHtml(session.user.email),
      pageMeta: view.pageMeta,
      heading: escapeHtml(view.heading),
      breadcrumbs: view.breadcrumbs.map((crumb) => ({ ...crumb, label: escapeHtml(crumb.label) })),
      backHref: view.backHref,
      backLabel: escapeHtml(view.backLabel),
      emptyMessage: view.emptyMessage,
      entries: safeHistoryEntries(result.entries, view.fallbackActor),
      pagination: {
        page: result.page,
        totalPages: result.totalPages,
        totalRecords: result.totalRecords,
        startRecord: result.totalRecords ? (result.page - 1) * result.perPage + 1 : 0,
        endRecord: Math.min(result.totalRecords, result.page * result.perPage),
        previousHref: result.page > 1 ? hrefFor(result.page - 1) : "",
        nextHref: result.page < result.totalPages ? hrefFor(result.page + 1) : ""
      }
    });
  } catch (error) {
    next(error);
  }
}

type FareSettingsRenderOptions = {
  snapshot?: FareSettingsSnapshot;
  configuration?: FareSettingsConfiguration;
  ruleForm?: Record<string, string>;
  ruleFormId?: string;
  errors?: Record<string, string>;
  formError?: string;
  statusCode?: number;
  additionalSetForm?: AdditionalDistanceSlabSetFormValues;
  additionalSetFormId?: string;
  additionalCopied?: boolean;
  additionalRemoveSetId?: string;
  discountForm?: LocationDiscountFormValues;
  discountFormId?: string;
  discountRemoveId?: string;
  radiusDiscountForm?: RadiusLocationDiscountFormValues;
  radiusDiscountFormId?: string;
  radiusDiscountRemoveId?: string;
};

type FareSettingsPage = {
  category?: FareSettingsCategory;
  /** Sub-page title below the category, e.g. the additional distance slab set editor. */
  subpageTitle?: string;
};

type RoadChargeViewState = {
  saved: "saved" | "enabled" | "disabled" | null;
  errors: Record<string, string>;
  formError: string | null;
  submittedAmounts: Record<string, string>;
  submittedEffectiveDates: { effectiveFrom: string; effectiveUntil: string } | null;
  activationErrors: string[];
  submittedVerifiedOn: string;
};

/** Plain view model for the structured schedule partial (the partial escapes every value). */
function roadChargeScheduleView(schedule: RoadChargeSchedule, version: number, formAction: string, state: RoadChargeViewState) {
  const blockers = schedule.active ? [] : activationBlockers(schedule);
  return {
    ...state,
    schedule,
    version,
    formAction,
    activationAction: `${formAction}/activation`,
    historyLabel: "Version history",
    blockers,
    canEnable: !schedule.active && blockers.length === 0,
    effectiveFromValue: state.submittedEffectiveDates?.effectiveFrom ?? schedule.effectiveFrom ?? "",
    effectiveUntilValue: state.submittedEffectiveDates?.effectiveUntil ?? schedule.effectiveUntil ?? "",
    rates: schedule.rates.map((rate) => ({
      ...rate,
      value: Object.prototype.hasOwnProperty.call(state.submittedAmounts, rate.key) ? state.submittedAmounts[rate.key] : rate.amount,
      error: state.errors[rate.key] ?? null
    }))
  };
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
          : page.area?.slug === "london-congestion-charge"
            ? "london-congestion-charge"
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
      roadChargeView: feeScheduleSnapshot && isRoadChargeSchedule(feeScheduleSnapshot.schedule)
        ? roadChargeScheduleView(feeScheduleSnapshot.schedule, feeScheduleSnapshot.currentVersion, `${leafPathFor(page)}/fee-settings`, {
          saved: req.query.saved === "1" ? "saved" : req.query.enabled === "1" ? "enabled" : req.query.disabled === "1" ? "disabled" : null,
          errors: renderOptions.feeScheduleErrors ?? {},
          formError: renderOptions.feeScheduleFormError ?? null,
          submittedAmounts: renderOptions.submittedAmounts ?? {},
          submittedEffectiveDates: renderOptions.submittedEffectiveDates ?? null,
          activationErrors: renderOptions.activationErrors ?? [],
          submittedVerifiedOn: renderOptions.submittedVerifiedOn ?? ""
        })
        : undefined,
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
      feeScheduleHistory: feeScheduleSnapshot
        ? recentHistoryView(
          feeScheduleSnapshot.history,
          feeScheduleSnapshot.historyTotal,
          `${leafPathFor(page)}/fee-settings/history`,
          "Initial supplied draft"
        )
        : undefined,
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
  const fareStore = options.fareSettingsStore ?? fareSettingsStore;
  const poiStore = options.poiManagementStore ?? poiManagementStore;
  const loadManagedSlabTargets = async (): Promise<ManagedSlabTarget[]> => [
    ...(await airportFeesStore.list()).map((airport) => ({ type: "airport" as const, id: airport.id, displayName: airport.displayName })),
    ...(await poiStore.listPois()).map((poi) => ({ type: "poi" as const, id: poi.id, displayName: poi.displayName }))
  ];
  const loadOperationalBase = options.loadOperationalBase ?? getOperationalBase;
  const csrfGuard = requireCsrfToken({ appTitle: options.appTitle });
  const fareSettingsPath = "/settings/fare-settings";
  const fareSettingsHistoryPath = `${fareSettingsPath}/history`;
  router.use(noStoreProtectedResponse);

  const renderFareSettingsPage = async (
    req: Request,
    res: Response,
    next: NextFunction,
    page: FareSettingsPage,
    renderOptions: FareSettingsRenderOptions = {}
  ): Promise<void> => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        res.redirect("/access");
        return;
      }

      const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
      if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
        renderUnavailable(res, options.appTitle, systemSettingsModule);
        return;
      }

      const snapshot = renderOptions.snapshot ?? await fareStore.load();
      const configuration = renderOptions.configuration ?? snapshot.configuration;
      const categoryTitle = page.category?.title;
      const isRadiusDiscountPage = page.category?.slug === "operational-base-radius-discounts";
      const operationalBase = page.category?.slug === "dead-mileage-settings" || isRadiusDiscountPage
        ? await loadOperationalBase()
        : null;
      const operationalBaseVerified = isOperationalBaseVerified(operationalBase);
      const safeConfiguration: FareSettingsConfiguration = {
        ...configuration,
        deadMileage: {
          freeRadiusMiles: escapeHtml(configuration.deadMileage?.freeRadiusMiles ?? "")
        },
        minimumFareRules: (configuration.minimumFareRules ?? []).map((rule) => ({
          ...rule,
          id: escapeHtml(rule.id),
          name: escapeHtml(rule.name),
          poiId: escapeHtml(rule.poiId),
          minimumBaseFare: escapeHtml(rule.minimumBaseFare)
        })),
        fixedFares: (configuration.fixedFares ?? []).map((rule) => ({
          ...rule,
          id: escapeHtml(rule.id),
          name: escapeHtml(rule.name),
          origin: rule.origin.type === "poi"
            ? { ...rule.origin, poiId: escapeHtml(rule.origin.poiId) }
            : { ...rule.origin, postcode: escapeHtml(rule.origin.postcode) },
          destination: rule.destination.type === "poi"
            ? { ...rule.destination, poiId: escapeHtml(rule.destination.poiId) }
            : { ...rule.destination, postcode: escapeHtml(rule.destination.postcode) },
          baseFare: escapeHtml(rule.baseFare)
        })),
        distanceSlabs: (configuration.distanceSlabs ?? []).map((slab) => ({
          startMiles: escapeHtml(slab.startMiles),
          endMiles: escapeHtml(slab.endMiles),
          ratePerMile: escapeHtml(slab.ratePerMile)
        })),
        dailySurcharge: {
          ...configuration.dailySurcharge,
          percentage: escapeHtml(configuration.dailySurcharge.percentage),
          startTime: escapeHtml(configuration.dailySurcharge.startTime),
          endTime: escapeHtml(configuration.dailySurcharge.endTime)
        },
        bankHolidaySurcharge: {
          ...configuration.bankHolidaySurcharge,
          periods: configuration.bankHolidaySurcharge.periods.map((period) => ({
            label: escapeHtml(period.label),
            startDateTime: escapeHtml(period.startDateTime),
            endDateTime: escapeHtml(period.endDateTime),
            percentage: escapeHtml(period.percentage)
          }))
        }
      };
      const history = recentHistoryView(snapshot.history, snapshot.historyTotal, fareSettingsHistoryPath, "System");
      const safeErrors = Object.fromEntries(
        Object.entries(renderOptions.errors ?? {}).map(([key, value]) => [key, escapeHtml(value)])
      );
      const managedPois = page.category?.slug === "minimum-fare-rules" || page.category?.slug === "fixed-fares"
        ? (await airportFeesStore.list()).map((poi) => ({
          id: escapeHtml(poi.id),
          displayName: escapeHtml(poi.displayName)
        }))
        : [];
      const isAdditionalSlabsPage = page.category?.slug === "additional-distance-slabs";
      const isDiscountPage = page.category?.slug === "location-based-discounts";
      const slabTargets = isAdditionalSlabsPage || isDiscountPage || isRadiusDiscountPage ? await loadManagedSlabTargets() : [];
      const escapeSlabs = (slabs: FareSettingsConfiguration["distanceSlabs"]) => slabs.map((slab) => ({
        startMiles: escapeHtml(slab.startMiles),
        endMiles: escapeHtml(slab.endMiles),
        ratePerMile: escapeHtml(slab.ratePerMile)
      }));
      const describeTarget = (target: AdditionalDistanceSlabSet["target"]) => {
        const managed = slabTargets.find((item) => item.type === target.type && item.id === target.id);
        const kind = target.type === "airport" ? "Airport" : "POI";
        return managed
          ? { available: true, label: `${escapeHtml(managed.displayName)} <span class="fare-settings__help">(${kind})</span>` }
          : {
            available: false,
            label: target.id
              ? `Unavailable ${kind === "Airport" ? "airport" : "POI"} (internal ID ${escapeHtml(target.id)}) — edit this set to link an active airport or POI.`
              : "Not linked — edit this set to link an airport or POI."
          };
      };
      const additionalSetRecords = isAdditionalSlabsPage ? resolveAdditionalDistanceSlabSets(configuration) : [];
      const additionalSets = additionalSetRecords.map((set) => {
        const target = describeTarget(set.target);
        const finalSlab = set.distanceSlabs[set.distanceSlabs.length - 1];
        return {
          id: escapeHtml(set.id),
          urlId: escapeHtml(encodeURIComponent(set.id)),
          name: escapeHtml(set.name),
          targetLabel: target.label,
          targetAvailable: target.available,
          slabSummary: escapeHtml(`${set.distanceSlabs.length} slab${set.distanceSlabs.length === 1 ? "" : "s"} from ${set.distanceSlabs[0]?.startMiles ?? "0"} miles` +
            (finalSlab ? `; final slab open-ended from ${finalSlab.startMiles} miles at £${finalSlab.ratePerMile} per mile.` : ".")),
          distanceSlabs: escapeSlabs(set.distanceSlabs)
        };
      });
      const removeSet = renderOptions.additionalRemoveSetId
        ? additionalSets.find((set) => set.id === escapeHtml(renderOptions.additionalRemoveSetId ?? ""))
        : undefined;
      const editorForm = isAdditionalSlabsPage ? renderOptions.additionalSetForm : undefined;
      const editorUnavailableTarget = editorForm && editorForm.targetKey &&
        !slabTargets.some((target) => additionalSlabTargetKey(target) === editorForm.targetKey)
        ? (() => {
          const [type, ...rest] = editorForm.targetKey.split(":");
          const id = rest.join(":");
          const kind = type === "airport" ? "airport" : type === "poi" ? "POI" : "location";
          return escapeHtml(id ? `Unavailable ${kind} — internal ID ${id}` : `Unavailable location — ${editorForm.targetKey}`);
        })()
        : "";
      const additionalEditor = editorForm
        ? {
          id: escapeHtml(renderOptions.additionalSetFormId ?? ""),
          name: escapeHtml(editorForm.name),
          targetKey: escapeHtml(editorForm.targetKey),
          unavailableTargetLabel: editorUnavailableTarget,
          distanceSlabs: escapeSlabs(editorForm.distanceSlabs)
        }
        : null;
      const locationDiscounts = isDiscountPage
        ? (configuration.locationDiscounts ?? []).map((rule) => {
          const target = describeTarget(rule.location);
          return {
            id: escapeHtml(rule.id),
            urlId: escapeHtml(encodeURIComponent(rule.id)),
            name: escapeHtml(rule.name),
            locationLabel: target.label,
            locationAvailable: target.available,
            locationId: escapeHtml(rule.location.id),
            precisionLabel: rule.postcodePrecision === "full" ? "Full postcode" : "Outward code",
            postcodes: rule.postcodes.map(escapeHtml),
            discountPercentage: escapeHtml(rule.discountPercentage),
            validity: escapeHtml(rule.startDate && rule.endDate
              ? `${rule.startDate} to ${rule.endDate} (inclusive)`
              : rule.startDate ? `From ${rule.startDate} (no end date)`
                : rule.endDate ? `Until ${rule.endDate} (inclusive)` : "No date limits"),
            enabled: rule.enabled
          };
        })
        : [];
      const discountRemove = isDiscountPage && renderOptions.discountRemoveId
        ? locationDiscounts.find((rule) => rule.id === escapeHtml(renderOptions.discountRemoveId ?? "")) ?? null
        : null;
      const describeValidity = (rule: Pick<LocationDiscountRule, "startDate" | "endDate">) => escapeHtml(rule.startDate && rule.endDate
        ? `${rule.startDate} to ${rule.endDate} (inclusive)`
        : rule.startDate ? `From ${rule.startDate} (no end date)`
          : rule.endDate ? `Until ${rule.endDate} (inclusive)` : "No date limits");
      const radiusDiscounts = isRadiusDiscountPage
        ? (configuration.radiusLocationDiscounts ?? []).map((rule) => {
          const target = describeTarget(rule.location);
          return {
            id: escapeHtml(rule.id),
            urlId: escapeHtml(encodeURIComponent(rule.id)),
            name: escapeHtml(rule.name),
            locationLabel: target.label,
            locationAvailable: target.available,
            locationId: escapeHtml(rule.location.id),
            radiusMiles: escapeHtml(rule.radiusMiles),
            discountPercentage: escapeHtml(rule.discountPercentage),
            validity: describeValidity(rule),
            enabled: rule.enabled
          };
        })
        : [];
      const radiusDiscountRemove = isRadiusDiscountPage && renderOptions.radiusDiscountRemoveId
        ? radiusDiscounts.find((rule) => rule.id === escapeHtml(renderOptions.radiusDiscountRemoveId ?? "")) ?? null
        : null;
      const unavailableLocationLabel = (locationKey: string) => locationKey &&
        !slabTargets.some((target) => additionalSlabTargetKey(target) === locationKey)
        ? (() => {
          const [type, ...rest] = locationKey.split(":");
          const id = rest.join(":");
          const kind = type === "airport" ? "airport" : type === "poi" ? "POI" : "location";
          return escapeHtml(id ? `Unavailable ${kind} — internal ID ${id}` : `Unavailable location — ${locationKey}`);
        })()
        : "";
      const radiusForm = isRadiusDiscountPage ? renderOptions.radiusDiscountForm : undefined;
      const radiusDiscountEditor = radiusForm
        ? {
          id: escapeHtml(renderOptions.radiusDiscountFormId ?? ""),
          ...Object.fromEntries(Object.entries(radiusForm).map(([key, value]) => [key, escapeHtml(value)])) as RadiusLocationDiscountFormValues,
          unavailableLocationLabel: unavailableLocationLabel(radiusForm.locationKey)
        }
        : null;
      const discountForm = isDiscountPage ? renderOptions.discountForm : undefined;
      const discountUnavailableLocation = discountForm && discountForm.locationKey &&
        !slabTargets.some((target) => additionalSlabTargetKey(target) === discountForm.locationKey)
        ? (() => {
          const [type, ...rest] = discountForm.locationKey.split(":");
          const id = rest.join(":");
          const kind = type === "airport" ? "airport" : type === "poi" ? "POI" : "location";
          return escapeHtml(id ? `Unavailable ${kind} — internal ID ${id}` : `Unavailable location — ${discountForm.locationKey}`);
        })()
        : "";
      const discountEditor = discountForm
        ? {
          id: escapeHtml(renderOptions.discountFormId ?? ""),
          ...Object.fromEntries(Object.entries(discountForm).map(([key, value]) => [key, escapeHtml(value)])) as LocationDiscountFormValues,
          unavailableLocationLabel: discountUnavailableLocation
        }
        : null;
      const managedTargets = {
        airports: slabTargets.filter((target) => target.type === "airport")
          .map((target) => ({ key: escapeHtml(additionalSlabTargetKey(target)), displayName: escapeHtml(target.displayName) })),
        pois: slabTargets.filter((target) => target.type === "poi")
          .map((target) => ({ key: escapeHtml(additionalSlabTargetKey(target)), displayName: escapeHtml(target.displayName) }))
      };
      const baseSlabs = (snapshot.configuration.distanceSlabs ?? []).map(({ startMiles, endMiles, ratePerMile }) => ({ startMiles, endMiles, ratePerMile }));
      const ruleForm = Object.fromEntries(
        Object.entries(renderOptions.ruleForm ?? {}).map(([key, value]) => [key, escapeHtml(value)])
      );
      const fixedFareForms = (configuration.fixedFares ?? []).map((rule) => {
        const values = fixedFareRuleToForm(rule);
        return {
          id: rule.id,
          name: escapeHtml(values.name),
          originType: escapeHtml(values.originType),
          originPoiId: escapeHtml(values.originPoiId),
          originPostcode: escapeHtml(values.originPostcode),
          originPostcodeScope: escapeHtml(values.originPostcodeScope),
          destinationType: escapeHtml(values.destinationType),
          destinationPoiId: escapeHtml(values.destinationPoiId),
          destinationPostcode: escapeHtml(values.destinationPostcode),
          destinationPostcodeScope: escapeHtml(values.destinationPostcodeScope),
          baseFare: escapeHtml(values.baseFare)
        };
      }).concat([{
        id: "",
        name: "",
        originType: "",
        originPoiId: "",
        originPostcode: "",
        originPostcodeScope: "",
        destinationType: "",
        destinationPoiId: "",
        destinationPostcode: "",
        destinationPostcodeScope: "",
        baseFare: ""
      }]);
      const breadcrumbs = [
        { label: "System Settings", href: "/settings" },
        { label: "Fare Settings", href: "/settings/fare-settings" },
        ...(page.category
          ? page.subpageTitle
            ? [{ label: page.category.title, href: `/settings/fare-settings/${page.category.slug}` }, { label: page.subpageTitle }]
            : [{ label: page.category.title }]
          : [])
      ];

      res.status(renderOptions.statusCode ?? 200).render("pages/fare-settings", {
        title: categoryTitle ? `Fare Settings: ${page.subpageTitle ?? categoryTitle}` : "Fare Settings",
        appTitle: options.appTitle,
        email: escapeHtml(session.user.email),
        grantedByLabel: grantingRoles(roles, systemSettingsModule).map(formatRoleLabel).join(", "),
        categories: fareSettingsCategories,
        category: page.category,
        breadcrumbs,
        configuration: safeConfiguration,
        operationalBase: operationalBase && {
          latitude: operationalBase.latitude,
          longitude: operationalBase.longitude,
          providerPlaceId: escapeHtml(operationalBase.providerPlaceId ?? ""),
          updatedAt: operationalBase.updatedAt
        },
        operationalBaseVerified,
        managedPois,
        additionalSets,
        additionalEditor,
        additionalRemoveSet: removeSet ?? null,
        additionalCopied: renderOptions.additionalCopied ?? false,
        locationDiscounts,
        discountEditor,
        discountRemove,
        radiusDiscounts,
        radiusDiscountEditor,
        radiusDiscountRemove,
        managedTargets,
        baseSlabsJson: escapeHtml(JSON.stringify(baseSlabs)),
        baseSlabCount: baseSlabs.length,
        ruleForm,
        ruleFormId: renderOptions.ruleFormId ?? "",
        ruleFormSubmitted: renderOptions.ruleForm !== undefined,
        fixedFareForms,
        currentVersion: snapshot.currentVersion,
        history,
        errors: safeErrors,
        formError: renderOptions.formError ? escapeHtml(renderOptions.formError) : "",
        saved: req.query.saved === "1"
      });
    } catch (error) {
      next(error);
    }
  };

  router.get(fareSettingsPath, (req, res, next) => {
    void renderFareSettingsPage(req, res, next, {});
  });

  router.get(fareSettingsHistoryPath, (req, res, next) => {
    void renderConfigurationHistoryPage(req, res, next, options.appTitle, {
      title: "Fare Settings: Configuration history",
      heading: "Fare Settings: Configuration history",
      pageMeta: "System Settings · Fare Settings",
      breadcrumbs: [
        { label: "System Settings", href: "/settings" },
        { label: "Fare Settings", href: fareSettingsPath },
        { label: "Configuration history" }
      ],
      basePath: fareSettingsHistoryPath,
      backHref: fareSettingsPath,
      backLabel: "Fare Settings",
      fallbackActor: "System",
      emptyMessage: "No changes have been saved yet.",
      loadPage: (page) => fareStore.loadHistoryPage(page)
    });
  });

  const additionalSlabsCategory = fareSettingsCategories.find((category) => category.slug === "additional-distance-slabs");
  const additionalSlabsPath = `${fareSettingsPath}/additional-distance-slabs`;
  if (additionalSlabsCategory) {
    const category = additionalSlabsCategory;
    const createTitle = "Create additional distance slabs set";
    const editTitle = "Edit additional distance slabs set";
    const removeTitle = "Remove additional distance slabs set";
    const blankForm = (): AdditionalDistanceSlabSetFormValues => ({
      name: "",
      targetKey: "",
      distanceSlabs: [{ startMiles: "", endMiles: "", ratePerMile: "" }]
    });
    const formFromSet = (set: AdditionalDistanceSlabSet): AdditionalDistanceSlabSetFormValues => ({
      name: set.name,
      targetKey: set.target.id ? additionalSlabTargetKey(set.target) : "",
      distanceSlabs: set.distanceSlabs.map((slab) => ({ ...slab }))
    });
    // An independent snapshot of the saved base slabs: later base edits never change it.
    const copyOfBaseSlabs = (configuration: FareSettingsConfiguration) =>
      (configuration.distanceSlabs ?? []).map(({ startMiles, endMiles, ratePerMile }) => ({ startMiles, endMiles, ratePerMile }));
    const notFound = "The additional distance slabs set could not be found. Reload the page and try again.";

    router.get(additionalSlabsPath, (req, res, next) => {
      void renderFareSettingsPage(req, res, next, { category });
    });

    router.get(`${additionalSlabsPath}/new`, (req, res, next) => {
      void renderFareSettingsPage(req, res, next, { category, subpageTitle: createTitle }, {
        additionalSetForm: blankForm()
      });
    });

    for (const action of ["edit", "remove"] as const) {
      router.get(`${additionalSlabsPath}/:setId/${action}`, async (req, res, next) => {
        try {
          const snapshot = await fareStore.load();
          const set = resolveAdditionalDistanceSlabSets(snapshot.configuration).find((item) => item.id === req.params.setId);
          if (!set) {
            void renderFareSettingsPage(req, res, next, { category }, { snapshot, formError: notFound, statusCode: 404 });
            return;
          }
          void renderFareSettingsPage(req, res, next, { category, subpageTitle: action === "remove" ? removeTitle : editTitle }, action === "remove"
            ? { snapshot, additionalRemoveSetId: set.id }
            : { snapshot, additionalSetForm: formFromSet(set), additionalSetFormId: set.id });
        } catch (error) {
          next(error);
        }
      });
    }

    router.post(additionalSlabsPath, csrfGuard, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          return renderUnavailable(res, options.appTitle, systemSettingsModule);
        }

        const snapshot = await fareStore.load();
        const sets = resolveAdditionalDistanceSlabSets(snapshot.configuration);
        const setId = typeof req.body?.setId === "string" ? req.body.setId.trim() : "";
        const action = req.body?.setAction === "delete" || req.body?.setAction === "copy-base"
          ? req.body.setAction as "delete" | "copy-base"
          : "save";
        const existing = setId ? sets.find((set) => set.id === setId) : undefined;
        if (setId && !existing) {
          return renderFareSettingsPage(req, res, next, { category }, { snapshot, formError: notFound, statusCode: 404 });
        }
        const editorPage = { category, subpageTitle: existing ? editTitle : createTitle };
        const submittedForm = (): AdditionalDistanceSlabSetFormValues => ({
          name: typeof req.body?.name === "string" ? req.body.name : "",
          targetKey: typeof req.body?.targetKey === "string" ? req.body.targetKey : "",
          distanceSlabs: validateDistanceSlabsForm({ distanceSlabs: req.body?.distanceSlabs }).distanceSlabs
        });

        if (action === "copy-base") {
          // No-JavaScript fallback for "Copy base slabs data": re-render the unsaved editor only.
          const baseSlabs = copyOfBaseSlabs(snapshot.configuration);
          const form = submittedForm();
          return renderFareSettingsPage(req, res, next, editorPage, {
            snapshot,
            additionalSetForm: { ...form, distanceSlabs: baseSlabs.length ? baseSlabs : form.distanceSlabs },
            additionalSetFormId: existing?.id ?? "",
            additionalCopied: baseSlabs.length > 0
          });
        }

        const rawVersion = req.body?.baseVersion;
        const expectedVersion = typeof rawVersion === "string" && /^\d+$/.test(rawVersion)
          ? Number(rawVersion)
          : NaN;
        const versionError = !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
          ? { formError: "The settings version is missing or invalid. Reload this page before saving.", statusCode: 400 }
          : expectedVersion !== snapshot.currentVersion
            ? { formError: new FareSettingsVersionConflictError().message, statusCode: 409 }
            : null;
        if (versionError) {
          return action === "delete"
            ? renderFareSettingsPage(req, res, next, { category }, { snapshot, ...versionError })
            : renderFareSettingsPage(req, res, next, editorPage, {
              snapshot,
              additionalSetForm: submittedForm(),
              additionalSetFormId: existing?.id ?? "",
              ...versionError
            });
        }

        let nextSets: AdditionalDistanceSlabSet[];
        if (action === "delete") {
          if (!existing) {
            return renderFareSettingsPage(req, res, next, { category }, { snapshot, formError: notFound, statusCode: 404 });
          }
          nextSets = sets.filter((set) => set.id !== existing.id);
        } else {
          const validation = validateAdditionalDistanceSlabSetForm(req.body, await loadManagedSlabTargets(), sets, existing?.id ?? "");
          if (Object.keys(validation.errors).length || !validation.target) {
            return renderFareSettingsPage(req, res, next, editorPage, {
              snapshot,
              additionalSetForm: validation.values,
              additionalSetFormId: existing?.id ?? "",
              errors: validation.errors,
              statusCode: 400
            });
          }
          const updated: AdditionalDistanceSlabSet = {
            id: existing?.id ?? randomUUID(),
            name: validation.values.name,
            target: validation.target,
            distanceSlabs: validation.values.distanceSlabs
          };
          nextSets = existing ? sets.map((set) => set.id === existing.id ? updated : set) : [...sets, updated];
        }

        try {
          await fareStore.save(expectedVersion, withAdditionalDistanceSlabSets(snapshot.configuration, nextSets), {
            accountId: session.user.id,
            email: session.user.email
          });
        } catch (error) {
          if (!(error instanceof FareSettingsVersionConflictError)) throw error;
          const latest = await fareStore.load();
          return action === "delete"
            ? renderFareSettingsPage(req, res, next, { category }, { snapshot: latest, formError: error.message, statusCode: 409 })
            : renderFareSettingsPage(req, res, next, editorPage, {
              snapshot: latest,
              additionalSetForm: submittedForm(),
              additionalSetFormId: existing?.id ?? "",
              formError: error.message,
              statusCode: 409
            });
        }
        return res.redirect(303, `${additionalSlabsPath}?saved=1`);
      } catch (error) {
        return next(error);
      }
    });
  }

  const discountsCategory = fareSettingsCategories.find((category) => category.slug === "location-based-discounts");
  const discountsPath = `${fareSettingsPath}/location-based-discounts`;
  if (discountsCategory) {
    const category = discountsCategory;
    const createTitle = "Create location-based discount";
    const editTitle = "Edit location-based discount";
    const removeTitle = "Remove location-based discount";
    const notFound = "The location-based discount could not be found. Reload the page and try again.";
    // New rules are never enabled by default.
    const blankForm = (): LocationDiscountFormValues => ({
      name: "", locationKey: "", postcodePrecision: "", postcodes: "", discountPercentage: "", startDate: "", endDate: "", enabled: "no"
    });
    const rulesOf = (configuration: FareSettingsConfiguration): LocationDiscountRule[] => configuration.locationDiscounts ?? [];

    router.get(discountsPath, (req, res, next) => {
      void renderFareSettingsPage(req, res, next, { category });
    });

    router.get(`${discountsPath}/new`, (req, res, next) => {
      void renderFareSettingsPage(req, res, next, { category, subpageTitle: createTitle }, { discountForm: blankForm() });
    });

    for (const action of ["edit", "remove"] as const) {
      router.get(`${discountsPath}/:ruleId/${action}`, async (req, res, next) => {
        try {
          const snapshot = await fareStore.load();
          const rule = rulesOf(snapshot.configuration).find((item) => item.id === req.params.ruleId);
          if (!rule) {
            void renderFareSettingsPage(req, res, next, { category }, { snapshot, formError: notFound, statusCode: 404 });
            return;
          }
          void renderFareSettingsPage(req, res, next, { category, subpageTitle: action === "remove" ? removeTitle : editTitle }, action === "remove"
            ? { snapshot, discountRemoveId: rule.id }
            : { snapshot, discountForm: locationDiscountRuleToForm(rule), discountFormId: rule.id });
        } catch (error) {
          next(error);
        }
      });
    }

    router.post(discountsPath, csrfGuard, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          return renderUnavailable(res, options.appTitle, systemSettingsModule);
        }

        const snapshot = await fareStore.load();
        const rules = rulesOf(snapshot.configuration);
        const ruleId = typeof req.body?.ruleId === "string" ? req.body.ruleId.trim() : "";
        const rawAction = req.body?.ruleAction;
        const action = rawAction === "delete" || rawAction === "enable" || rawAction === "disable"
          ? rawAction as "delete" | "enable" | "disable"
          : "save";
        const existing = ruleId ? rules.find((rule) => rule.id === ruleId) : undefined;
        if ((ruleId || action !== "save") && !existing) {
          return renderFareSettingsPage(req, res, next, { category }, { snapshot, formError: notFound, statusCode: 404 });
        }
        const editorPage = { category, subpageTitle: existing ? editTitle : createTitle };
        const submittedForm = (): LocationDiscountFormValues => validateLocationDiscountForm(req.body, [], []).values;

        const rawVersion = req.body?.baseVersion;
        const expectedVersion = typeof rawVersion === "string" && /^\d+$/.test(rawVersion) ? Number(rawVersion) : NaN;
        const versionError = !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
          ? { formError: "The settings version is missing or invalid. Reload this page before saving.", statusCode: 400 }
          : expectedVersion !== snapshot.currentVersion
            ? { formError: new FareSettingsVersionConflictError().message, statusCode: 409 }
            : null;
        if (versionError) {
          return action === "save"
            ? renderFareSettingsPage(req, res, next, editorPage, {
              snapshot, discountForm: submittedForm(), discountFormId: existing?.id ?? "", ...versionError
            })
            : renderFareSettingsPage(req, res, next, { category }, { snapshot, ...versionError });
        }

        let nextRules: LocationDiscountRule[];
        if (action === "delete") {
          nextRules = rules.filter((rule) => rule.id !== existing!.id);
        } else if (action === "disable") {
          nextRules = rules.map((rule) => rule.id === existing!.id ? { ...rule, enabled: false } : rule);
        } else if (action === "enable") {
          // Re-validate the saved rule so a conflicting or unavailable rule can never be enabled.
          const validation = validateLocationDiscountForm(
            { ...locationDiscountRuleToForm(existing!), enabled: "yes" },
            await loadManagedSlabTargets(),
            rules,
            existing!.id
          );
          if (!validation.rule) {
            const reason = Object.values(validation.errors).join(" ");
            return renderFareSettingsPage(req, res, next, { category }, {
              snapshot,
              formError: `“${existing!.name}” was not enabled. ${reason}`,
              statusCode: 400
            });
          }
          nextRules = rules.map((rule) => rule.id === existing!.id ? { ...rule, enabled: true } : rule);
        } else {
          const validation = validateLocationDiscountForm(req.body, await loadManagedSlabTargets(), rules, existing?.id ?? "");
          if (!validation.rule) {
            return renderFareSettingsPage(req, res, next, editorPage, {
              snapshot,
              discountForm: validation.values,
              discountFormId: existing?.id ?? "",
              errors: validation.errors,
              statusCode: 400
            });
          }
          const updated: LocationDiscountRule = { id: existing?.id ?? randomUUID(), ...validation.rule };
          nextRules = existing ? rules.map((rule) => rule.id === existing.id ? updated : rule) : [...rules, updated];
        }

        try {
          await fareStore.save(expectedVersion, { ...snapshot.configuration, locationDiscounts: nextRules }, {
            accountId: session.user.id,
            email: session.user.email
          });
        } catch (error) {
          if (!(error instanceof FareSettingsVersionConflictError)) throw error;
          const latest = await fareStore.load();
          return action === "save"
            ? renderFareSettingsPage(req, res, next, editorPage, {
              snapshot: latest, discountForm: submittedForm(), discountFormId: existing?.id ?? "", formError: error.message, statusCode: 409
            })
            : renderFareSettingsPage(req, res, next, { category }, { snapshot: latest, formError: error.message, statusCode: 409 });
        }
        return res.redirect(303, `${discountsPath}?saved=1`);
      } catch (error) {
        return next(error);
      }
    });
  }

  const radiusDiscountsCategory = fareSettingsCategories.find((category) => category.slug === "operational-base-radius-discounts");
  const radiusDiscountsPath = `${fareSettingsPath}/operational-base-radius-discounts`;
  if (radiusDiscountsCategory) {
    const category = radiusDiscountsCategory;
    const createTitle = "Create operational-base radius discount";
    const editTitle = "Edit operational-base radius discount";
    const removeTitle = "Remove operational-base radius discount";
    const notFound = "The operational-base radius discount could not be found. Reload the page and try again.";
    // New rules are never enabled by default.
    const blankForm = (): RadiusLocationDiscountFormValues => ({
      name: "", locationKey: "", radiusMiles: "", discountPercentage: "", startDate: "", endDate: "", enabled: "no"
    });
    const rulesOf = (configuration: FareSettingsConfiguration): RadiusLocationDiscountRule[] => configuration.radiusLocationDiscounts ?? [];

    router.get(radiusDiscountsPath, (req, res, next) => {
      void renderFareSettingsPage(req, res, next, { category });
    });

    router.get(`${radiusDiscountsPath}/new`, (req, res, next) => {
      void renderFareSettingsPage(req, res, next, { category, subpageTitle: createTitle }, { radiusDiscountForm: blankForm() });
    });

    for (const action of ["edit", "remove"] as const) {
      router.get(`${radiusDiscountsPath}/:ruleId/${action}`, async (req, res, next) => {
        try {
          const snapshot = await fareStore.load();
          const rule = rulesOf(snapshot.configuration).find((item) => item.id === req.params.ruleId);
          if (!rule) {
            void renderFareSettingsPage(req, res, next, { category }, { snapshot, formError: notFound, statusCode: 404 });
            return;
          }
          void renderFareSettingsPage(req, res, next, { category, subpageTitle: action === "remove" ? removeTitle : editTitle }, action === "remove"
            ? { snapshot, radiusDiscountRemoveId: rule.id }
            : { snapshot, radiusDiscountForm: radiusLocationDiscountRuleToForm(rule), radiusDiscountFormId: rule.id });
        } catch (error) {
          next(error);
        }
      });
    }

    router.post(radiusDiscountsPath, csrfGuard, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          return renderUnavailable(res, options.appTitle, systemSettingsModule);
        }

        const snapshot = await fareStore.load();
        const rules = rulesOf(snapshot.configuration);
        const ruleId = typeof req.body?.ruleId === "string" ? req.body.ruleId.trim() : "";
        const rawAction = req.body?.ruleAction;
        const action = rawAction === "delete" || rawAction === "enable" || rawAction === "disable"
          ? rawAction as "delete" | "enable" | "disable"
          : "save";
        const existing = ruleId ? rules.find((rule) => rule.id === ruleId) : undefined;
        if ((ruleId || action !== "save") && !existing) {
          return renderFareSettingsPage(req, res, next, { category }, { snapshot, formError: notFound, statusCode: 404 });
        }
        const editorPage = { category, subpageTitle: existing ? editTitle : createTitle };
        const submittedForm = (): RadiusLocationDiscountFormValues => validateRadiusLocationDiscountForm(req.body, [], [], false).values;

        const rawVersion = req.body?.baseVersion;
        const expectedVersion = typeof rawVersion === "string" && /^\d+$/.test(rawVersion) ? Number(rawVersion) : NaN;
        const versionError = !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
          ? { formError: "The settings version is missing or invalid. Reload this page before saving.", statusCode: 400 }
          : expectedVersion !== snapshot.currentVersion
            ? { formError: new FareSettingsVersionConflictError().message, statusCode: 409 }
            : null;
        if (versionError) {
          return action === "save"
            ? renderFareSettingsPage(req, res, next, editorPage, {
              snapshot, radiusDiscountForm: submittedForm(), radiusDiscountFormId: existing?.id ?? "", ...versionError
            })
            : renderFareSettingsPage(req, res, next, { category }, { snapshot, ...versionError });
        }

        let nextRules: RadiusLocationDiscountRule[];
        if (action === "delete") {
          nextRules = rules.filter((rule) => rule.id !== existing!.id);
        } else if (action === "disable") {
          nextRules = rules.map((rule) => rule.id === existing!.id ? { ...rule, enabled: false } : rule);
        } else if (action === "enable") {
          // Re-validate the saved rule so a conflicting, unavailable, or base-less rule can never be enabled.
          const validation = validateRadiusLocationDiscountForm(
            { ...radiusLocationDiscountRuleToForm(existing!), enabled: "yes" },
            await loadManagedSlabTargets(),
            rules,
            isOperationalBaseVerified(await loadOperationalBase()),
            existing!.id
          );
          if (!validation.rule) {
            const reason = Object.values(validation.errors).join(" ");
            return renderFareSettingsPage(req, res, next, { category }, {
              snapshot,
              formError: `“${existing!.name}” was not enabled. ${reason}`,
              statusCode: 400
            });
          }
          nextRules = rules.map((rule) => rule.id === existing!.id ? { ...rule, enabled: true } : rule);
        } else {
          const validation = validateRadiusLocationDiscountForm(
            req.body,
            await loadManagedSlabTargets(),
            rules,
            isOperationalBaseVerified(await loadOperationalBase()),
            existing?.id ?? ""
          );
          if (!validation.rule) {
            return renderFareSettingsPage(req, res, next, editorPage, {
              snapshot,
              radiusDiscountForm: validation.values,
              radiusDiscountFormId: existing?.id ?? "",
              errors: validation.errors,
              statusCode: 400
            });
          }
          const updated: RadiusLocationDiscountRule = { id: existing?.id ?? randomUUID(), ...validation.rule };
          nextRules = existing ? rules.map((rule) => rule.id === existing.id ? updated : rule) : [...rules, updated];
        }

        try {
          await fareStore.save(expectedVersion, { ...snapshot.configuration, radiusLocationDiscounts: nextRules }, {
            accountId: session.user.id,
            email: session.user.email
          });
        } catch (error) {
          if (!(error instanceof FareSettingsVersionConflictError)) throw error;
          const latest = await fareStore.load();
          return action === "save"
            ? renderFareSettingsPage(req, res, next, editorPage, {
              snapshot: latest, radiusDiscountForm: submittedForm(), radiusDiscountFormId: existing?.id ?? "", formError: error.message, statusCode: 409
            })
            : renderFareSettingsPage(req, res, next, { category }, { snapshot: latest, formError: error.message, statusCode: 409 });
        }
        return res.redirect(303, `${radiusDiscountsPath}?saved=1`);
      } catch (error) {
        return next(error);
      }
    });
  }

  for (const category of fareSettingsCategories) {
    if (category.slug === "additional-distance-slabs" || category.slug === "location-based-discounts" ||
        category.slug === "operational-base-radius-discounts") continue;
    const categoryPath = `${fareSettingsPath}/${category.slug}`;
    router.get(categoryPath, (req, res, next) => {
      // Links to the former airport-specific editor on Distance slabs now open Additional distance slabs.
      if (category.slug === "distance-slabs" && typeof req.query.airportSet === "string") {
        res.redirect(302, additionalSlabsPath);
        return;
      }
      void renderFareSettingsPage(req, res, next, { category });
    });

    if (!category.configurable) continue;

    router.post(categoryPath, csrfGuard, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          return renderUnavailable(res, options.appTitle, systemSettingsModule);
        }

        const snapshot = await fareStore.load();
        if (category.slug === "dead-mileage-settings") {
          const validation = validateDeadMileageRadius(req.body);
          const ruleForm = { freeRadiusMiles: validation.freeRadiusMiles };
          const rawVersion = req.body?.baseVersion;
          const expectedVersion = typeof rawVersion === "string" && /^\d+$/.test(rawVersion)
            ? Number(rawVersion)
            : NaN;
          if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
            return renderFareSettingsPage(req, res, next, { category }, {
              snapshot, ruleForm,
              formError: "The settings version is missing or invalid. Reload this page before saving.",
              statusCode: 400
            });
          }
          if (expectedVersion !== snapshot.currentVersion) {
            return renderFareSettingsPage(req, res, next, { category }, {
              snapshot, ruleForm,
              formError: new FareSettingsVersionConflictError().message,
              statusCode: 409
            });
          }
          if (!isOperationalBaseVerified(await loadOperationalBase())) {
            return renderFareSettingsPage(req, res, next, { category }, {
              snapshot, ruleForm,
              formError: "Dead-mileage settings cannot be enabled: the operational base does not have verified saved coordinates.",
              statusCode: 400
            });
          }
          if (Object.keys(validation.errors).length) {
            return renderFareSettingsPage(req, res, next, { category }, {
              snapshot, ruleForm, errors: validation.errors, statusCode: 400
            });
          }
          try {
            await fareStore.save(expectedVersion, {
              ...snapshot.configuration,
              deadMileage: { freeRadiusMiles: validation.freeRadiusMiles }
            }, {
              accountId: session.user.id,
              email: session.user.email
            });
          } catch (error) {
            if (!(error instanceof FareSettingsVersionConflictError)) throw error;
            const latest = await fareStore.load();
            return renderFareSettingsPage(req, res, next, { category }, {
              snapshot: latest,
              formError: error.message,
              statusCode: 409
            });
          }
          return res.redirect(303, `${categoryPath}?saved=1`);
        }
        if (category.slug === "minimum-fare-rules" || category.slug === "fixed-fares") {
          const isMinimumFareRule = category.slug === "minimum-fare-rules";
          const rules: Array<MinimumFareRule | FixedFareRule> = isMinimumFareRule
            ? snapshot.configuration.minimumFareRules ?? []
            : snapshot.configuration.fixedFares ?? [];
          const ruleId = typeof req.body?.ruleId === "string" ? req.body.ruleId.trim() : "";
          const isDelete = req.body?.ruleAction === "delete";
          const rawVersion = req.body?.baseVersion;
          const expectedVersion = typeof rawVersion === "string" && /^\d+$/.test(rawVersion)
            ? Number(rawVersion)
            : NaN;
          if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
            return renderFareSettingsPage(req, res, next, { category }, {
              snapshot,
              ruleFormId: ruleId,
              formError: "The settings version is missing or invalid. Reload this page before saving.",
              statusCode: 400
            });
          }
          if (expectedVersion !== snapshot.currentVersion) {
            return renderFareSettingsPage(req, res, next, { category }, {
              snapshot,
              formError: new FareSettingsVersionConflictError().message,
              statusCode: 409
            });
          }

          let nextRules: Array<MinimumFareRule | FixedFareRule>;
          let ruleForm: Record<string, string> | undefined;
          let errors: Record<string, string> = {};
          if (isDelete) {
            if (!ruleId || !rules.some((rule) => rule.id === ruleId)) {
              return renderFareSettingsPage(req, res, next, { category }, {
                snapshot,
                formError: "The rule could not be found. Reload the page and try again.",
                statusCode: 404
              });
            }
            nextRules = rules.filter((rule) => rule.id !== ruleId);
          } else if (isMinimumFareRule) {
            const validation = validateMinimumFareRuleForm(req.body, await airportFeesStore.list());
            errors = validation.errors;
            ruleForm = validation.values;
            const existing = ruleId ? rules.find((rule) => rule.id === ruleId) : undefined;
            if (ruleId && !existing) {
              return renderFareSettingsPage(req, res, next, { category }, {
                snapshot,
                ruleForm,
                ruleFormId: ruleId,
                formError: "The rule could not be found. Reload the page and try again.",
                statusCode: 404
              });
            }
            if (Object.keys(errors).length) {
              return renderFareSettingsPage(req, res, next, { category }, {
                snapshot,
                ruleForm,
                ruleFormId: ruleId,
                errors,
                statusCode: 400
              });
            }
            const updatedRule: MinimumFareRule = {
              id: ruleId || randomUUID(),
              ...validation.values
            };
            nextRules = ruleId
              ? rules.map((rule) => rule.id === ruleId ? updatedRule : rule)
              : [...rules, updatedRule];
          } else {
            const validation = validateFixedFareRuleForm(req.body, await airportFeesStore.list());
            errors = validation.errors;
            ruleForm = validation.values;
            const existing = ruleId ? rules.find((rule) => rule.id === ruleId) : undefined;
            if (ruleId && !existing) {
              return renderFareSettingsPage(req, res, next, { category }, {
                snapshot,
                ruleForm,
                ruleFormId: ruleId,
                formError: "The rule could not be found. Reload the page and try again.",
                statusCode: 404
              });
            }
            if (Object.keys(errors).length || !validation.rule) {
              return renderFareSettingsPage(req, res, next, { category }, {
                snapshot,
                ruleForm,
                ruleFormId: ruleId,
                errors,
                statusCode: 400
              });
            }
            const updatedRule: FixedFareRule = {
              id: ruleId || randomUUID(),
              ...validation.rule
            };
            nextRules = ruleId
              ? rules.map((rule) => rule.id === ruleId ? updatedRule : rule)
              : [...rules, updatedRule];
          }

          const nextConfiguration: FareSettingsConfiguration = isMinimumFareRule
            ? {
              ...snapshot.configuration,
              minimumFareRules: nextRules.filter((rule): rule is MinimumFareRule => "poiId" in rule)
            }
            : {
              ...snapshot.configuration,
              fixedFares: nextRules.filter((rule): rule is FixedFareRule => "origin" in rule)
            };
          try {
            await fareStore.save(expectedVersion, nextConfiguration, {
              accountId: session.user.id,
              email: session.user.email
            });
          } catch (error) {
            if (!(error instanceof FareSettingsVersionConflictError)) throw error;
            const latest = await fareStore.load();
            return renderFareSettingsPage(req, res, next, { category }, {
              snapshot: latest,
              formError: error.message,
              statusCode: 409
            });
          }
          return res.redirect(303, `${categoryPath}?saved=1`);
        }

        const distanceSlabSubmission = category.slug === "distance-slabs"
          ? validateDistanceSlabsForm(req.body)
          : null;
        const validatedFareSettings = distanceSlabSubmission
          ? {
            configuration: {
              ...snapshot.configuration,
              distanceSlabs: distanceSlabSubmission.distanceSlabs
            },
            errors: distanceSlabSubmission.errors
          }
          : validateFareSettingsForm(req.body, snapshot.configuration);
        const { configuration, errors } = validatedFareSettings;
        const rawVersion = req.body?.baseVersion;
        const expectedVersion = typeof rawVersion === "string" && /^\d+$/.test(rawVersion)
          ? Number(rawVersion)
          : NaN;
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
          return renderFareSettingsPage(req, res, next, { category }, {
            snapshot,
            configuration,
            errors,
            formError: "The settings version is missing or invalid. Reload this page before saving.",
            statusCode: 400
          });
        }
        if (expectedVersion !== snapshot.currentVersion) {
          return renderFareSettingsPage(req, res, next, { category }, {
            snapshot,
            formError: new FareSettingsVersionConflictError().message,
            statusCode: 409
          });
        }
        if (Object.keys(errors).length > 0) {
          return renderFareSettingsPage(req, res, next, { category }, {
            snapshot,
            configuration,
            errors,
            statusCode: 400
          });
        }

        try {
          await fareStore.save(expectedVersion, configuration, {
            accountId: session.user.id,
            email: session.user.email
          });
        } catch (error) {
          if (!(error instanceof FareSettingsVersionConflictError)) throw error;
          const latest = await fareStore.load();
          return renderFareSettingsPage(req, res, next, { category }, {
            snapshot: latest,
            formError: error.message,
            statusCode: 409
          });
        }

        return res.redirect(303, `${categoryPath}?saved=1`);
      } catch (error) {
        return next(error);
      }
    });
  }

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
        const structured = isRoadChargeSchedule(snapshot.schedule) ? snapshot.schedule : null;
        const structuredEdit = structured ? validateRoadChargeScheduleEdit(structured, req.body) : null;
        const { amounts, errors } = structuredEdit
          ?? validateLondonFeeRateAmounts(snapshot.schedule as Exclude<typeof snapshot.schedule, RoadChargeSchedule>, req.body);
        const submittedEffectiveDates = structured ? {
          effectiveFrom: typeof req.body?.effectiveFrom === "string" ? req.body.effectiveFrom.slice(0, 20) : "",
          effectiveUntil: typeof req.body?.effectiveUntil === "string" ? req.body.effectiveUntil.slice(0, 20) : ""
        } : undefined;
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
            submittedEffectiveDates,
            statusCode: 400
          });
        }
        if (Object.keys(errors).length > 0) {
          return renderTollFeesPage(req, res, next, options.appTitle, feeSettingsPage, feeScheduleStore, airportFeesStore, {
            feeScheduleSnapshot: snapshot,
            feeScheduleErrors: errors,
            feeScheduleFormError: structured ? "Correct the highlighted fields. Nothing was saved." : undefined,
            submittedAmounts,
            submittedEffectiveDates,
            statusCode: 400
          });
        }

        try {
          await feeScheduleStore.save(scheme, expectedVersion, amounts, {
            accountId: session.user.id,
            email: session.user.email
          }, structuredEdit ? { effectiveFrom: structuredEdit.effectiveFrom, effectiveUntil: structuredEdit.effectiveUntil } : undefined);
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

  const registerFeeScheduleHistory = (
    feeSettingsPath: string,
    scheme: LondonFeeScheduleScheme,
    page: TollFeesPage
  ) => {
    const historyPath = `${feeSettingsPath}/history`;
    const feeSettingsPage: TollFeesPage = { ...page, section: "fee-settings" };
    router.get(historyPath, (req, res, next) => {
      const breadcrumbs = buildBreadcrumbs(feeSettingsPage);
      breadcrumbs[breadcrumbs.length - 1].href = feeSettingsPath;
      const historyLabel = scheme === "dartford-crossing" ? "Draft version history" : "Version history";
      breadcrumbs.push({ label: historyLabel });
      const title = `${pageTitle(feeSettingsPage)}: ${historyLabel}`;
      void renderConfigurationHistoryPage(req, res, next, options.appTitle, {
        title,
        heading: title,
        pageMeta: "System Settings · Toll & Fees",
        breadcrumbs,
        basePath: historyPath,
        backHref: feeSettingsPath,
        backLabel: pageTitle(feeSettingsPage),
        fallbackActor: "Initial supplied draft",
        emptyMessage: "No versions have been recorded yet.",
        loadPage: (requestedPage) => feeScheduleStore.loadHistoryPage(scheme, requestedPage)
      });
    });
  };

  const registerFeeScheduleActivation = (
    feeSettingsPath: string,
    scheme: LondonFeeScheduleScheme,
    page: TollFeesPage
  ) => {
    const feeSettingsPage: TollFeesPage = { ...page, section: "fee-settings" };
    router.post(`${feeSettingsPath}/activation`, requireCsrfToken({ appTitle: options.appTitle }), async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!canAccessWorkspace(roles, systemSettingsModule.key)) {
          return renderUnavailable(res, options.appTitle, systemSettingsModule);
        }

        const snapshot = await feeScheduleStore.load(scheme);
        const action = req.body?.action;
        const rawVersion = req.body?.baseVersion;
        const expectedVersion = typeof rawVersion === "string" && /^\d+$/.test(rawVersion) ? Number(rawVersion) : NaN;
        const verifiedOn = typeof req.body?.verifiedOn === "string" ? req.body.verifiedOn.trim().slice(0, 20) : "";
        const rerender = (statusCode: number, extra: TollFeesRenderOptions) =>
          renderTollFeesPage(req, res, next, options.appTitle, feeSettingsPage, feeScheduleStore, airportFeesStore, {
            feeScheduleSnapshot: snapshot,
            submittedVerifiedOn: verifiedOn,
            statusCode,
            ...extra
          });
        if (!isRoadChargeSchedule(snapshot.schedule)) {
          return rerender(400, { activationErrors: ["This schedule is a legacy draft and cannot be enabled."] });
        }
        if ((action !== "enable" && action !== "disable") || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
          return rerender(400, { activationErrors: ["The request is missing the action or schedule version. Reload this page and try again."] });
        }

        try {
          await feeScheduleStore.setActivation(
            scheme,
            expectedVersion,
            action === "enable"
              ? { action, verifiedOn, sourcesConfirmed: req.body?.confirmSources === "yes" }
              : { action },
            { accountId: session.user.id, email: session.user.email },
            new Date()
          );
        } catch (error) {
          if (error instanceof RoadChargeActivationError) return rerender(400, { activationErrors: error.blockers });
          if (!(error instanceof LondonFeeScheduleVersionConflictError)) throw error;
          return renderTollFeesPage(req, res, next, options.appTitle, feeSettingsPage, feeScheduleStore, airportFeesStore, {
            feeScheduleSnapshot: await feeScheduleStore.load(scheme),
            activationErrors: [error.message],
            statusCode: 409
          });
        }
        return res.redirect(303, `${feeSettingsPath}?${action === "enable" ? "enabled" : "disabled"}=1`);
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

        if (area.slug === "london-lez" || area.slug === "london-ulez" || area.slug === "london-congestion-charge") {
          const scheme: LondonFeeScheduleScheme = area.slug;
          registerFeeSchedulePost(`${areaPath}/fee-settings`, scheme, { category, area });
          registerFeeScheduleHistory(`${areaPath}/fee-settings`, scheme, { category, area });
          registerFeeScheduleActivation(`${areaPath}/fee-settings`, scheme, { category, area });
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
      registerFeeScheduleHistory(`${categoryPath}/fee-settings`, category.slug, { category });
    }
    if (category.slug === "blackwall-silvertown-tunnels") {
      registerFeeScheduleActivation(`${categoryPath}/fee-settings`, category.slug, { category });
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
