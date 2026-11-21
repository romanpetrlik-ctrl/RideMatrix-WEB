import { Router, type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import {
  BOOKING_DASHBOARD_VIEWS,
  archiveBooking as archiveBookingRecord,
  BOOKING_WORKFLOW_STATUSES,
  changeBookingStatus as changeBookingStatusRecord,
  listBookingStatusColors,
  saveBookingStatusColor,
  listOpenBookingIntegrationAlerts,
  listBookingDashboard,
  resolveBookingIntegrationAlert,
  type BookingDashboardRecord,
  type BookingDashboardView,
  type BookingWorkflowStatus
} from "../services/booking-dashboard";
import { getSessionAccount, type SessionAccount } from "../services/api";
import type { BookingRoute } from "../services/booking-routing";
import type { BookingPrice, BookingStops } from "../services/booking-pricing";
import { buildCustomerQuote } from "../services/customer-quote";
import { readMapConfiguration } from "../services/maps";
import {
  BOOKING_COUNT_FIELDS,
  BOOKING_COUNT_MAX,
  BOOKING_PAYMENT_METHODS,
  BOOKING_PAYER_TYPES,
  BookingPriceChangedError,
  SERVICE_TIMEZONE,
  STOP_KEYS,
  UnresolvedPriceNotAcknowledgedError,
  cargoSummary,
  createNewBooking,
  defaultNewBookingDependencies,
  defaultServiceDateTime,
  formatInServiceTimezone,
  getBookingManagerCandidate,
  getNewBooking,
  listBookingManagerCandidates,
  NEW_CUSTOMER_SELECTION_VALUE,
  quoteJourney,
  readNewBookingDraft,
  serviceTimeOptions,
  validateNewBooking,
  type BookingActor,
  type BookingFieldError,
  type BookingManagerCandidate,
  type NewBookingDependencies,
  type NewBookingDraft,
  type PricingReferenceData,
  type SavedNewBooking,
  type ValidatedBooking
} from "../services/new-bookings";

export type BookingsRouterOptions = {
  appTitle: string;
  loadSession?: (cookieHeader?: string) => Promise<SessionAccount>;
  dependencies?: Partial<NewBookingDependencies>;
  listManagers?: () => Promise<BookingManagerCandidate[]>;
  getManager?: (customerId: string) => Promise<BookingManagerCandidate | null>;
  createBooking?: typeof createNewBooking;
  getBooking?: (id: string) => Promise<SavedNewBooking | null>;
  listDashboardBookings?: (view: BookingDashboardView, search: string) => Promise<BookingDashboardRecord[]>;
  listIntegrationAlerts?: typeof listOpenBookingIntegrationAlerts;
  resolveIntegrationAlert?: typeof resolveBookingIntegrationAlert;
  archiveBooking?: typeof archiveBookingRecord;
  changeBookingStatus?: typeof changeBookingStatusRecord;
  now?: () => Date;
  mapConfiguration?: () => { browserApiKey?: string; mapId?: string };
};

class AuthorizationError extends Error {}

async function requireAdmin(cookieHeader: string | undefined, loadSession: (cookieHeader?: string) => Promise<SessionAccount>): Promise<BookingActor> {
  const session = await loadSession(cookieHeader);
  if (!session.authenticated || !session.user) throw new AuthorizationError("unauthenticated");
  const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
  if (!roles.includes("admin")) throw new AuthorizationError("forbidden");
  return { accountId: session.user.id, email: session.user.email };
}

function emptyDraft(now: Date): NewBookingDraft {
  const service = defaultServiceDateTime(now);
  const emptyStop = { kind: "", managedId: "", placeId: "", label: "", houseNameNumber: "" };
  return {
    customerMode: "existing",
    customerId: "",
    newCustomerGivenName: "",
    newCustomerSurname: "",
    newCustomerPhone: "",
    newCustomerEmail: "",
    managerName: "",
    managerPhone: "",
    managerEmail: "",
    notifyBookingManager: false,
    bookingManagerWhatsappOptIn: false,
    payerType: "booking_manager",
    payerName: "",
    payerEmail: "",
    payerPhone: "",
    passengerIsManager: true,
    passengerName: "",
    passengerPhone: "",
    passengerEmail: "",
    passengerWhatsappOptIn: false,
    serviceDate: service.date,
    serviceTime: service.time,
    vehicleClassKey: "",
    paymentMethod: "",
    stops: { pickup: { ...emptyStop }, via1: { ...emptyStop }, via2: { ...emptyStop }, dropoff: { ...emptyStop } },
    viaActive: { via1: false, via2: false },
    counts: Object.fromEntries(BOOKING_COUNT_FIELDS.map(([field]) => [field, "0"])) as NewBookingDraft["counts"],
    childSeatRequired: "no",
    boosterRequired: "no",
    confirmedPoiFeeIds: [],
    saveWithUnresolvedPrice: false,
    quotedTotal: "",
    quotedStatus: "",
    quotedFingerprint: ""
  };
}

function serializeStops(stops: BookingStops) {
  const ordered = [
    { type: "pickup", stop: stops.pickup },
    ...stops.vias.map((stop) => ({ type: "via", stop })),
    { type: "dropoff", stop: stops.dropoff }
  ];
  return ordered.map(({ type, stop }) => ({
    type,
    kind: stop.kind,
    label: stop.label,
    latitude: stop.latitude,
    longitude: stop.longitude,
    postcode: stop.postcode,
    coordinatesVerified: stop.coordinatesVerified
  }));
}

function serializeRoute(route: BookingRoute) {
  if (route.status !== "resolved") return { status: route.status, reason: route.reason, message: route.message };
  return {
    status: route.status,
    distanceMiles: route.distanceMiles,
    durationSeconds: route.durationSeconds,
    trafficModel: route.trafficModel,
    tollsReported: route.tollsReported,
    zones: route.zones.map((zone) => ({ zone: zone.zone, label: zone.label })),
    tunnelCrossings: route.tunnelCrossings.map((crossing) => ({ tunnel: crossing.tunnel, label: crossing.label, direction: crossing.direction })),
    path: route.path.map((point) => [point.latitude, point.longitude])
  };
}

export function createBookingsRouter(options: BookingsRouterOptions): Router {
  const router = Router();
  router.use("/bookings", noStoreProtectedResponse);
  const loadSession = options.loadSession ?? getSessionAccount;
  const dependencies: NewBookingDependencies = { ...defaultNewBookingDependencies, ...options.dependencies };
  const listManagers = options.listManagers ?? (() => listBookingManagerCandidates());
  const getManager = options.getManager ?? getBookingManagerCandidate;
  const saveBooking = options.createBooking ?? createNewBooking;
  const loadBooking = options.getBooking ?? getNewBooking;
  const loadDashboardBookings = options.listDashboardBookings ?? ((view, search) => listBookingDashboard(view, search, options.now?.() ?? new Date()));
  const archiveSavedBooking = options.archiveBooking ?? archiveBookingRecord;
  const changeSavedBookingStatus = options.changeBookingStatus ?? changeBookingStatusRecord;
  const csrfGuard = requireCsrfToken({ appTitle: options.appTitle });
  const mapConfiguration = options.mapConfiguration ?? (() => {
    const configuration = readMapConfiguration();
    return configuration.enabled ? { browserApiKey: configuration.browserApiKey, mapId: configuration.mapId } : {};
  });
  const quoteRateLimit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const saveRateLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const archiveRateLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const statusRateLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

  const requireAdminSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.bookingActor = await requireAdmin(req.headers.cookie, loadSession);
      return next();
    } catch (error) {
      if (error instanceof AuthorizationError && error.message === "unauthenticated") {
        return req.method === "GET" ? res.redirect("/access") : res.status(401).json({ error: "Sign in again to continue." });
      }
      if (error instanceof AuthorizationError) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }
      return next(error);
    }
  };

  async function renderForm(
    res: Response,
    status: number,
    draft: NewBookingDraft,
    reference: PricingReferenceData,
    extras: {
      errors?: BookingFieldError[];
      formError?: string;
      quote?: { route: BookingRoute; price: BookingPrice; fingerprint: string; stops: BookingStops } | null
    }
  ) {
    const actor = res.locals.bookingActor as BookingActor;
    const managers = await listManagers();
    const selected = draft.customerId && !managers.some((manager) => manager.customerId === draft.customerId)
      ? await getManager(draft.customerId)
      : null;
    const maps = mapConfiguration();
    const counts = Object.fromEntries(BOOKING_COUNT_FIELDS.map(([field]) => [field, Number(draft.counts[field]) || 0])) as Parameters<typeof cargoSummary>[0];
    return res.status(status).render("pages/bookings/new", {
      title: "New Booking",
      appTitle: options.appTitle,
      email: actor.email,
      draft,
      newCustomerSelectionValue: NEW_CUSTOMER_SELECTION_VALUE,
      errors: extras.errors ?? [],
      formError: extras.formError ?? "",
      managers: selected ? [selected, ...managers] : managers,
      airports: reference.airports.map((airport) => ({ id: airport.id, displayName: airport.displayName })),
      pois: reference.pois.map((poi) => ({ id: poi.id, displayName: poi.displayName, category: poi.category })),
      confirmationFees: reference.poiFees.filter((fee) => fee.trigger === "confirmation").map((fee) => ({
        id: fee.id, poiId: fee.poiId, poiDisplayName: fee.poiDisplayName, action: fee.action, amount: fee.amount, feeBasis: fee.feeBasis
      })),
      stopKeys: STOP_KEYS,
      countFields: BOOKING_COUNT_FIELDS,
      countMax: BOOKING_COUNT_MAX,
      vehicleClasses: reference.vehicleClasses,
      paymentMethods: BOOKING_PAYMENT_METHODS,
      payerTypes: BOOKING_PAYER_TYPES,
      timeOptions: serviceTimeOptions(),
      serviceTimezone: SERVICE_TIMEZONE,
      cargoSummaryText: cargoSummary(counts, draft.childSeatRequired === "yes", draft.boosterRequired === "yes"),
      createdByEmail: actor.email,
      mapsBrowserApiKey: maps.browserApiKey ?? "",
      mapsMapId: maps.mapId ?? "",
      quote: extras.quote
        ? { route: serializeRoute(extras.quote.route), price: extras.quote.price, fingerprint: extras.quote.fingerprint, stops: serializeStops(extras.quote.stops) }
        : null
    });
  }

  router.get("/bookings", requireAdminSession, async (req, res, next) => {
    try {
      const actor = res.locals.bookingActor as BookingActor;
      const session = await loadSession(req.headers.cookie);
      const requestedView = typeof req.query.view === "string" ? req.query.view : "";
      const view: BookingDashboardView = BOOKING_DASHBOARD_VIEWS.includes(requestedView as BookingDashboardView)
        ? requestedView as BookingDashboardView
        : "today";
      const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
      const [bookings, integrationAlerts] = await Promise.all([
        loadDashboardBookings(view, search),
        (options.listIntegrationAlerts ?? listOpenBookingIntegrationAlerts)()
      ]);
      return res.render("pages/bookings/index", {
        title: "Bookings",
        appTitle: options.appTitle,
        email: actor.email,
        canManageStatusColors: session.user?.roles.includes("superuser") ?? false,
        contextBarActions: [{ label: "New booking", href: "/bookings/new", tone: "primary" }],
        bookings,
        integrationAlerts,
        view,
        search,
        notice: typeof req.query.notice === "string" ? req.query.notice : "",
        error: req.query.error === "archive-reason-required"
          ? "Enter a reason to archive this booking."
          : req.query.error === "cancel-reason-required"
            ? "Enter a reason to cancel this booking."
            : req.query.error === "cancel-reason-too-long"
              ? "The cancellation reason must be no more than 500 characters."
              : ""
      });

    } catch (error) {
      return next(error);
    }
  });

  router.post("/bookings/integration-alerts/:alertId/resolve", requireAdminSession, csrfGuard, async (req, res, next) => {
    try {
      const actor = res.locals.bookingActor as BookingActor;
      await (options.resolveIntegrationAlert ?? resolveBookingIntegrationAlert)({
        alertId: String(req.params.alertId),
        actorId: actor.accountId,
        actorEmail: actor.email
      });
      const view = typeof req.body?.view === "string" && BOOKING_DASHBOARD_VIEWS.includes(req.body.view as BookingDashboardView)
        ? req.body.view : "today";
      return res.redirect(303, `/bookings?view=${encodeURIComponent(view)}&notice=alert-resolved`);
    } catch (error) {
      return next(error);
    }
  });

  const requireSuperuserForStatusColors = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect("/access");
      if (!session.user.roles.includes("superuser")) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }
      res.locals.statusColorActor = { accountId: session.user.id, email: session.user.email };
      return next();
    } catch (error) {
      return next(error);
    }
  };

  router.get("/bookings/status-colors", requireSuperuserForStatusColors, async (_req, res, next) => {
    try {
      const actor = res.locals.statusColorActor as BookingActor;
      return res.render("pages/bookings/status-colors", {
        title: "Booking status colours",
        appTitle: options.appTitle,
        email: actor.email,
        colors: await listBookingStatusColors(),
        notice: typeof _req.query.notice === "string" ? _req.query.notice : ""
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/bookings/status-colors", requireSuperuserForStatusColors, statusRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const actor = res.locals.statusColorActor as BookingActor;
      const statusType = req.body?.statusType === "live" ? "live" : req.body?.statusType === "operational" ? "operational" : null;
      const statusKey = typeof req.body?.statusKey === "string" ? req.body.statusKey : "";
      const colorHex = typeof req.body?.colorHex === "string" ? req.body.colorHex : "";
      if (!statusType || !/^#[0-9A-Fa-f]{6}$/.test(colorHex)) {
        return res.redirect(303, "/bookings/status-colors?notice=invalid");
      }
      const result = await saveBookingStatusColor({
        statusType,
        statusKey,
        colorHex,
        actorId: actor.accountId,
        actorEmail: actor.email
      });
      return res.redirect(303, `/bookings/status-colors?notice=${result}`);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/bookings/new", requireAdminSession, async (req, res, next) => {
    try {
      const reference = await dependencies.loadReferenceData();
      const draft = emptyDraft(dependencies.now());
      const customerId = typeof req.query.customerId === "string" ? req.query.customerId.trim().slice(0, 100) : "";
      const manager = customerId ? await getManager(customerId) : null;
      if (manager) {
        draft.customerId = manager.customerId;
        draft.managerName = manager.name;
        draft.managerPhone = manager.phone;
        draft.managerEmail = manager.email;
      }
      return await renderForm(res, 200, draft, reference, {
        formError: customerId && !manager ? "The requested customer is not an active booking manager. Select one below." : ""
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/bookings/quote", requireAdminSession, quoteRateLimit, async (req, res, next) => {
    try {
      const draft = readNewBookingDraft(req.body);
      const reference = await dependencies.loadReferenceData();
      const { errors, booking } = await validateNewBooking(draft, reference, dependencies, getManager);
      if (!booking) return res.status(422).json({ ok: false, errors });
      const quote = await quoteJourney(booking, reference, dependencies.computeRoute);
      return res.json({
        ok: true,
        errors: [],
        stops: serializeStops(booking.stops),
        route: serializeRoute(quote.route),
        price: quote.price,
        fingerprint: quote.fingerprint
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/bookings", requireAdminSession, saveRateLimit, async (req, res, next) => {
    try {
      const actor = res.locals.bookingActor as BookingActor;
      const draft = readNewBookingDraft(req.body);
      const reference = await dependencies.loadReferenceData();
      const { errors, booking } = await validateNewBooking(draft, reference, dependencies, getManager);
      if (!booking) {
        return await renderForm(res, 422, draft, reference, { errors, formError: "Correct the highlighted fields before saving." });
      }
      const quote = await quoteJourney(booking, reference, dependencies.computeRoute);
      try {
        const saved = await saveBooking(booking as ValidatedBooking, quote, draft, actor, dependencies.now());
        return res.redirect(303, `/bookings/${encodeURIComponent(saved.id)}?notice=created`);
      } catch (error) {
        if (error instanceof BookingPriceChangedError || error instanceof UnresolvedPriceNotAcknowledgedError) {
          const refreshed: NewBookingDraft = {
            ...draft,
            quotedStatus: quote.price.status,
            quotedTotal: quote.price.total ?? "",
            quotedFingerprint: quote.fingerprint,
            saveWithUnresolvedPrice: error instanceof BookingPriceChangedError ? false : draft.saveWithUnresolvedPrice
          };
          return await renderForm(res, 409, refreshed, reference, {
            formError: error.message,
            errors: error instanceof UnresolvedPriceNotAcknowledgedError
              ? [{ field: "saveWithUnresolvedPrice", message: error.message }]
              : [],
            quote: { ...quote, stops: booking.stops }
          });
        }
        throw error;
      }
    } catch (error) {
      return next(error);
    }
  });

  router.post("/bookings/:bookingId/archive", requireAdminSession, archiveRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const actor = res.locals.bookingActor as BookingActor;
      const bookingId = typeof req.params.bookingId === "string" ? req.params.bookingId : "";
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      const requestedView = typeof req.body?.view === "string" ? req.body.view : "";
      const view: BookingDashboardView = BOOKING_DASHBOARD_VIEWS.includes(requestedView as BookingDashboardView)
        ? requestedView as BookingDashboardView
        : "today";
      const search = typeof req.body?.search === "string" ? req.body.search.trim().slice(0, 100) : "";
      const queryString = new URLSearchParams({ view, ...(search ? { search } : {}) }).toString();
      if (!reason || reason.length > 500) {
        return res.redirect(303, `/bookings?${queryString}&error=archive-reason-required`);
      }
      const result = await archiveSavedBooking({
        bookingId,
        reason,
        actorId: actor.accountId,
        actorEmail: actor.email
      });

      if (result === "not-found") return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      return res.redirect(303, `/bookings?${queryString}&notice=archived`);
    } catch (error) {
      return next(error);
    }
  });

  router.post("/bookings/:bookingId/status", requireAdminSession, statusRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const actor = res.locals.bookingActor as BookingActor;
      const bookingId = typeof req.params.bookingId === "string" ? req.params.bookingId : "";
      const requestedStatus = typeof req.body?.status === "string" ? req.body.status : "";
      const status = BOOKING_WORKFLOW_STATUSES.includes(requestedStatus as BookingWorkflowStatus)
        ? requestedStatus as BookingWorkflowStatus
        : null;
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      const requestedView = typeof req.body?.view === "string" ? req.body.view : "";
      const view: BookingDashboardView = BOOKING_DASHBOARD_VIEWS.includes(requestedView as BookingDashboardView)
        ? requestedView as BookingDashboardView
        : "today";
      const search = typeof req.body?.search === "string" ? req.body.search.trim().slice(0, 100) : "";
      const queryString = new URLSearchParams({ view, ...(search ? { search } : {}) }).toString();
      if (!status) return res.redirect(303, `/bookings?${queryString}&notice=status-invalid`);
      if (status === "Cancelled" && !reason) {
        return res.redirect(303, `/bookings?${queryString}&error=cancel-reason-required`);
      }
      if (status === "Cancelled" && reason.length > 500) {
        return res.redirect(303, `/bookings?${queryString}&error=cancel-reason-too-long`);
      }
      const result = await changeSavedBookingStatus({
        bookingId,
        status,
        reason,
        actorId: actor.accountId,
        actorEmail: actor.email
      });
      if (result === "not-found") return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      const notice = result === "updated" ? "status-updated" : result === "unchanged" ? "status-unchanged" : "status-not-changed";
      return res.redirect(303, `/bookings?${queryString}&notice=${notice}`);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/bookings/:bookingId", requireAdminSession, async (req, res, next) => {
    try {
      const actor = res.locals.bookingActor as BookingActor;
      const booking = await loadBooking(String(req.params.bookingId));
      if (!booking) return res.status(404).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      const maps = mapConfiguration();
      const counts = Object.fromEntries(BOOKING_COUNT_FIELDS.map(([field]) => [field, booking.counts[field] ?? 0])) as Parameters<typeof cargoSummary>[0];
      return res.render("pages/bookings/detail", {
        title: `Booking ${booking.reference}`,
        appTitle: options.appTitle,
        email: actor.email,
        booking,
        notice: req.query.notice === "created" ? "created" : "",
        createdAtDisplay: formatInServiceTimezone(booking.createdAt),
        serviceTimezone: booking.serviceTimezone ?? SERVICE_TIMEZONE,
        cargoSummaryText: cargoSummary(counts, booking.childSeatRequired === true, booking.boosterRequired === true),
        mapsBrowserApiKey: maps.browserApiKey ?? "",
        mapsMapId: maps.mapId ?? "",
        customerQuote: booking.price ? buildCustomerQuote(booking.price) : null
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
