import { Router, type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, type SessionAccount } from "../services/api";
import type { BookingRoute } from "../services/booking-routing";
import type { BookingPrice, BookingStops } from "../services/booking-pricing";
import { buildCustomerQuote } from "../services/customer-quote";
import { readMapConfiguration } from "../services/maps";
import {
  BOOKING_COUNT_FIELDS,
  BOOKING_COUNT_MAX,
  BOOKING_PAYMENT_METHODS,
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
  quoteJourney,
  readNewBookingDraft,
  serviceTimeOptions,
  validateJourney,
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
    passengerIsManager: true,
    passengerName: "",
    passengerPhone: "",
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
  const mapConfiguration = options.mapConfiguration ?? (() => {
    const configuration = readMapConfiguration();
    return configuration.enabled ? { browserApiKey: configuration.browserApiKey, mapId: configuration.mapId } : {};
  });
  const quoteRateLimit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const saveRateLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

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
      const errors: BookingFieldError[] = [];
      const journey = await validateJourney(draft, reference, dependencies, errors);
      if (!journey) return res.status(422).json({ ok: false, errors });
      const quote = await quoteJourney(journey, reference, dependencies.computeRoute);
      return res.json({
        ok: true,
        errors: [],
        stops: serializeStops(journey.stops),
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
