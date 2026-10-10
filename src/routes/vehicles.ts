import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, SessionAccount } from "../services/api";
import { resolveHelpContent } from "../services/help";
import { canManageStaff } from "../services/staff";
import {
  listLicensingAuthoritiesForManagement,
  listVehicleLicenses,
  saveVehicleLicense,
  VEHICLE_LICENSE_TYPES
} from "../services/licensing";
import {
  assignVehicleDriver, createVehicle, createVehicleDocument, getDocumentStatus, getVehicleById, getVehicleDocument,
  getVehicleDriverSummary, listBaggageCategories, listDrivers, listVehicleClasses, listVehicleDocuments, listVehicleDriverAssignments, listVehicles,
  consumeVehicleDocumentUploadRateLimit, consumeVehicleMutationRateLimit, updateVehicle, validateVehicleDocumentUpload,
  consumeVehicleDocumentDownloadRateLimit,
  VEHICLE_DEFAULT_PER_PAGE, VEHICLE_DOCUMENT_MAX_BYTES, VEHICLE_DOCUMENT_TYPES, VEHICLE_FUEL_TYPES, VEHICLE_STATUS_OPTIONS, VehicleDriverAssignmentError,
  VehicleInput, VehicleNotFoundError, VehicleValidationError
} from "../services/vehicles";

type Options = {
  appTitle: string;
  loadSession?: (cookie?: string) => Promise<SessionAccount>;
  consumeUploadRateLimit?: (key: string) => Promise<boolean>;
  consumeDownloadRateLimit?: (key: string) => Promise<boolean>;
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: VEHICLE_DOCUMENT_MAX_BYTES } });
const text = (value: unknown) => String(value ?? "").trim();
function input(body: any): VehicleInput {
  const year = text(body.year);
  const rawClasses = Array.isArray(body.classKeys) ? body.classKeys : [body.classKeys || body.vehicleClassKey];
  const baggageCapacities: Record<string, number | null> = {};
  for (const key of ["xl_suitcase", "l_suitcase", "cabin_bag", "backpack"]) {
    const value = text(body[`capacity_${key}`]);
    baggageCapacities[key] = value === "" ? null : Number(value);
  }
  return { registration: text(body.registration), make: text(body.make), model: text(body.model),
    year: year ? Number(year) : null, colour: text(body.colour) || null,
    classKeys: rawClasses.map(text).filter(Boolean), fuelType: text(body.fuelType) as any,
    passengerCapacity: Number(body.passengerCapacity), status: text(body.status) as any,
    registeredKeeperDetails: text(body.registeredKeeperDetails) || null,
    notes: text(body.notes) || null, baggageCapacities };
}
// Re-renders submitted values with the same shape the form uses for stored vehicles.
function formVehicle(value: VehicleInput, id?: string) {
  return { ...value, id, classes: (value.classKeys || []).map((key) => ({ key })),
    capacities: Object.entries(value.baggageCapacities || {}).filter(([, quantity]) => quantity != null)
      .map(([categoryKey, maxQuantity]) => ({ categoryKey, maxQuantity })) };
}
const SAFE_DOCUMENT_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
function safeDownloadName(document: any): string {
  const fallback = `${text(document.document_type) || "vehicle-document"}.pdf`;
  return (text(document.original_filename) || fallback).replace(/[^a-z0-9._ -]/gi, "_");
}

export function createVehiclesRouter(options: Options): Router {
  const router = Router();
  router.use(noStoreProtectedResponse);
  const loadSession = options.loadSession || getSessionAccount;
  const localDocumentUploadRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false
  });
  const localVehicleMutationRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false
  });
  const localDocumentDownloadRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false
  });
  async function guard(req: any, res: any): Promise<boolean> {
    const session = await loadSession(req.headers.cookie);
    if (!session.authenticated || !session.user) { res.redirect("/access"); return false; }
    if (!(await canManageStaff(session.user.roles || []))) {
      res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      return false;
    }
    res.locals.vehicleUser = session.user;
    return true;
  }
  async function requireAuthorizedVehicleManager(req: any, res: any, next: any) {
    try {
      if (await guard(req, res)) return next();
    } catch (error) {
      return next(error);
    }
  }
  async function limitDocumentUploads(req: any, res: any, next: any) {
    try {
      // This is an atomic PostgreSQL window counter, so limits apply across
      // processes and instances; no unbounded process-local state is used.
      const userId = text(res.locals.vehicleUser?.id);
      const consumeRateLimit = options.consumeUploadRateLimit || consumeVehicleDocumentUploadRateLimit;
      const allowed = await consumeRateLimit(
        `vehicle-document:${userId}`
      );
      if (!allowed) return res.status(429).send("Too many document uploads. Try again later.");
      return next();
    } catch (error) {
      return next(error);
    }
  }
  async function vehicleMutationRateLimit(req: any, res: any, next: any) {
    try {
      const userId = text(res.locals.vehicleUser?.id);
      const allowed = await consumeVehicleMutationRateLimit(`vehicle-mutation:${userId}`);
      if (!allowed) return res.status(429).send("Too many vehicle updates. Try again later.");
      return next();
    } catch (error) {
      return next(error);
    }
  }
  async function limitDocumentDownloads(req: any, res: any, next: any) {
    try {
      const userId = text(res.locals.vehicleUser?.id);
      const consumeRateLimit = options.consumeDownloadRateLimit || consumeVehicleDocumentDownloadRateLimit;
      if (!(await consumeRateLimit(`vehicle-document-download:${userId}`))) {
        return res.status(429).send("Too many document downloads. Try again later.");
      }
      return next();
    } catch (error) {
      return next(error);
    }
  }
  const renderForm = async (res: any, data: any, status = 200) => res.status(status).render("pages/vehicles/form", {
    title: data.vehicle?.id ? "Edit vehicle" : "New vehicle", appTitle: options.appTitle,
    classes: await listVehicleClasses(), baggageCategories: await listBaggageCategories(),
    statuses: VEHICLE_STATUS_OPTIONS, fuelTypes: VEHICLE_FUEL_TYPES, helpFor: resolveHelpContent, ...data
  });
  const csrfGuard = requireCsrfToken({ appTitle: options.appTitle });

  router.get("/vehicles", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const search = text(req.query.q), page = Number(req.query.page || 1), perPage = Number(req.query.perPage || VEHICLE_DEFAULT_PER_PAGE);
      const result = await listVehicles({ search, status: req.query.status, page, perPage });
      return res.render("pages/vehicles/index", { title: result.status === "active" ? "Active vehicles" : "Vehicles", appTitle: options.appTitle,
        email: res.locals.vehicleUser.email, search, statuses: VEHICLE_STATUS_OPTIONS, notice: text(req.query.notice), ...result,
        startRecord: result.total ? (result.page - 1) * result.perPage + 1 : 0,
        endRecord: Math.min(result.total, result.page * result.perPage) });
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/new", async (req, res, next) => {
    try { if (await guard(req, res)) return renderForm(res, { vehicle: null, errors: [] }); } catch (error) { next(error); }
  });
  router.post("/vehicles/new", requireAuthorizedVehicleManager, localVehicleMutationRateLimit, vehicleMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const value = input(req.body);
      try { const vehicle = await createVehicle(value); return res.redirect(`/vehicles/${encodeURIComponent(vehicle.id)}?notice=created`); }
      catch (error) {
        if (!(error instanceof VehicleValidationError)) throw error;
        return renderForm(res, { vehicle: formVehicle(value), errors: [error.message] }, 400);
      }
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/:vehicleId/edit", async (req, res, next) => {
    try { if (await guard(req, res)) { const vehicle = await getVehicleById(req.params.vehicleId); if (!vehicle) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle }); return renderForm(res, { vehicle, errors: [] }); } } catch (error) { next(error); }
  });
  router.post("/vehicles/:vehicleId/edit", requireAuthorizedVehicleManager, localVehicleMutationRateLimit, vehicleMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const vehicleId = text(req.params.vehicleId);
      const value = input(req.body);
      try {
        const vehicle = await updateVehicle(vehicleId, value);
        if (!vehicle) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
        return res.redirect(`/vehicles/${encodeURIComponent(vehicleId)}?notice=updated`);
      } catch (error) {
        if (!(error instanceof VehicleValidationError)) throw error;
        return renderForm(res, { vehicle: formVehicle(value, vehicleId), errors: [error.message] }, 400);
      }
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/:vehicleId", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const vehicle = await getVehicleById(req.params.vehicleId);
      if (!vehicle) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      return res.render("pages/vehicles/detail", { title: vehicle.registration, appTitle: options.appTitle, email: res.locals.vehicleUser.email,
        vehicle, documents: await listVehicleDocuments(vehicle.id), licenses: await listVehicleLicenses(vehicle.id),
        authorities: await listLicensingAuthoritiesForManagement(), licenseTypes: VEHICLE_LICENSE_TYPES,
        driverAssignments: await listVehicleDriverAssignments(vehicle.id),
        drivers: await listDrivers(), baggageCategories: await listBaggageCategories(), documentTypes: VEHICLE_DOCUMENT_TYPES,
        helpFor: resolveHelpContent, notice: text(req.query.notice) });
    } catch (error) { return next(error); }
  });
  router.post("/vehicles/:vehicleId/licenses", requireAuthorizedVehicleManager, localVehicleMutationRateLimit, vehicleMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const vehicleId = text(req.params.vehicleId);
      const vehicle = await getVehicleById(vehicleId);
      if (!vehicle) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      const licenseId = text(req.body.licenseId);
      try {
        const saved = await saveVehicleLicense(vehicleId, {
          licensingAuthorityId: text(req.body.licensingAuthorityId),
          licenseType: text(req.body.licenseType) as typeof VEHICLE_LICENSE_TYPES[number],
          vehicleLicenseBadge: text(req.body.vehicleLicenseBadge) || null,
          clearVehicleLicenseBadge: text(req.body.clearVehicleLicenseBadge) === "1",
          licenseReference: text(req.body.licenseReference) || null,
          validFrom: text(req.body.validFrom),
          validUntil: text(req.body.validUntil) || null,
          notes: text(req.body.notes) || null
        }, licenseId || undefined);
        if (licenseId && !saved) return res.sendStatus(404);
        return res.redirect(`/vehicles/${encodeURIComponent(vehicleId)}?notice=license-saved`);
      } catch (error) {
        if ((error as { code?: string }).code === "23503"
          || (error instanceof Error && (error.message.includes("licence") || error.message.includes("license") || error.message.includes("authority")))) {
          return res.redirect(`/vehicles/${encodeURIComponent(vehicleId)}?notice=license-invalid`);
        }
        throw error;
      }
    } catch (error) { return next(error); }
  });
  router.post("/vehicles/:vehicleId/driver", requireAuthorizedVehicleManager, localVehicleMutationRateLimit, vehicleMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const vehicleId = text(req.params.vehicleId);
      try {
        const outcome = await assignVehicleDriver(vehicleId, text(req.body.driverId));
        const notice = outcome === "unchanged" ? "driver-unchanged" : outcome === "unassigned" ? "driver-unassigned" : "driver-updated";
        return res.redirect(`/vehicles/${encodeURIComponent(vehicleId)}?notice=${notice}`);
      } catch (error) {
        if (error instanceof VehicleNotFoundError) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
        if (!(error instanceof VehicleDriverAssignmentError)) throw error;
        return res.redirect(`/vehicles/${encodeURIComponent(vehicleId)}?notice=driver-invalid`);
      }
    } catch (error) { next(error); }
  });
  router.get("/vehicles/:vehicleId/driver-details", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const vehicle = await getVehicleById(req.params.vehicleId);
      if (!vehicle) return res.sendStatus(404);
      return res.render("pages/vehicles/operations", {
        title: "View driver details", appTitle: options.appTitle, email: res.locals.vehicleUser.email, vehicle,
        driverSummary: await getVehicleDriverSummary(vehicle.id)
      });
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/:vehicleId/bookings", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const vehicle = await getVehicleById(req.params.vehicleId);
      if (!vehicle) return res.sendStatus(404);
      return res.render("pages/vehicles/operations", { title: "Assigned bookings", appTitle: options.appTitle, email: res.locals.vehicleUser.email, vehicle });
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/:vehicleId/driver-history", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const vehicle = await getVehicleById(req.params.vehicleId);
      if (!vehicle) return res.sendStatus(404);
      return res.render("pages/vehicles/operations", { title: "Driver assignment history", appTitle: options.appTitle, email: res.locals.vehicleUser.email, vehicle,
        driverAssignments: await listVehicleDriverAssignments(vehicle.id) });
    } catch (error) { return next(error); }
  });
  // CodeQL may not identify the custom PostgreSQL-backed limiter below as a
  // framework rate limiter. It is intentionally before multer and CSRF parsing:
  // authorization runs first, then the atomic distributed counter, then the
  // bounded upload parser and CSRF validator.
  router.post("/vehicles/:vehicleId/documents", requireAuthorizedVehicleManager, localDocumentUploadRateLimit, limitDocumentUploads, upload.single("document"), requireCsrfToken({ appTitle: options.appTitle }), async (req, res, next) => {
    try {
      const file = req.file;
      const vehicleId = text(req.params.vehicleId);
      const vehicle = await getVehicleById(vehicleId);
      if (!vehicle) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      const detailUrl = `/vehicles/${encodeURIComponent(vehicle.id)}`;
      if (!file || !text(req.body.documentType)) return res.redirect(`${detailUrl}?notice=document-required`);
      try { validateVehicleDocumentUpload(file); } catch { return res.redirect(`${detailUrl}?notice=document-invalid-file`); }
      if (!(VEHICLE_DOCUMENT_TYPES as readonly string[]).includes(text(req.body.documentType))) return res.redirect(`${detailUrl}?notice=document-invalid-type`);
      const licenseId = text(req.body.licenseId);
      const vehicleLicenses = licenseId ? await listVehicleLicenses(vehicle.id) : [];
      if (licenseId && !vehicleLicenses.some((license) => license.id === licenseId)) {
        return res.redirect(`${detailUrl}?notice=document-invalid-license`);
      }
      if (text(req.body.documentType) === "hackney_ph_badge" && !licenseId) {
        return res.redirect(`${detailUrl}?notice=document-invalid-license`);
      }
      const expiresOn = text(req.body.expiresOn);
      const expiryStatus = /^\d{4}-\d{2}-\d{2}$/.test(expiresOn) ? getDocumentStatus(expiresOn) : "Missing";
      if (expiryStatus === "Missing" || expiryStatus === "Expired") return res.redirect(`${detailUrl}?notice=document-invalid-expiry`);
      await createVehicleDocument({ vehicleId: vehicle.id, documentType: text(req.body.documentType), documentNumber: text(req.body.documentNumber),
        issuedOn: text(req.body.issuedOn), expiresOn: text(req.body.expiresOn), originalFilename: file.originalname, mimeType: file.mimetype,
        content: file.buffer, uploadedBy: res.locals.vehicleUser.id, licenseId: licenseId || null });
      return res.redirect(`${detailUrl}?notice=document-added`);
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/documents/:documentId", requireAuthorizedVehicleManager, localDocumentDownloadRateLimit, limitDocumentDownloads, async (req, res, next) => {
    try {
      const document = await getVehicleDocument(text(req.params.documentId));
      if (!document || !document.content) return res.sendStatus(404);
      const disposition = text(req.query.download) === "1" ? "attachment" : "inline";
      res.setHeader("Content-Disposition", `${disposition}; filename="${safeDownloadName(document)}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type(SAFE_DOCUMENT_MIME_TYPES.has(text(document.mime_type)) ? text(document.mime_type) : "application/octet-stream").send(document.content);
    } catch (error) { next(error); }
  });
  return router;
}
