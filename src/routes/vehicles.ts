import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { requireCsrfToken } from "../middleware/csrf";
import { getSessionAccount, SessionAccount } from "../services/api";
import { resolveHelpContent } from "../services/help";
import { canManageStaff } from "../services/staff";
import {
  assignVehicleDriver, createVehicle, createVehicleDocument, getVehicleById, getVehicleDocument,
  getVehicleDriverSummary, listBaggageCategories, listDrivers, listVehicleClasses, listVehicleDocuments, listVehicleDriverAssignments, listVehicles,
  consumeVehicleDocumentUploadRateLimit, consumeVehicleMutationRateLimit, updateVehicle, validateVehicleDocumentUpload,
  VEHICLE_DEFAULT_PER_PAGE, VEHICLE_DOCUMENT_TYPES, VEHICLE_FUEL_TYPES, VEHICLE_STATUS_OPTIONS, VehicleInput
} from "../services/vehicles";

type Options = {
  appTitle: string;
  loadSession?: (cookie?: string) => Promise<SessionAccount>;
  consumeUploadRateLimit?: (key: string) => Promise<boolean>;
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
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
    wheelchairAccessible: body.wheelchairAccessible === "on",
    notes: text(body.notes) || null, baggageCapacities };
}
function safeDownloadName(document: any): string {
  const fallback = `${text(document.document_type) || "vehicle-document"}.pdf`;
  return (text(document.original_filename) || fallback).replace(/[^a-z0-9._ -]/gi, "_");
}

export function createVehiclesRouter(options: Options): Router {
  const router = Router();
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
  const renderForm = async (res: any, data: any, status = 200) => res.status(status).render("pages/vehicles/form", {
    title: data.vehicle ? "Edit vehicle" : "New vehicle", appTitle: options.appTitle,
    classes: await listVehicleClasses(), baggageCategories: await listBaggageCategories(),
    statuses: VEHICLE_STATUS_OPTIONS, fuelTypes: VEHICLE_FUEL_TYPES, helpFor: resolveHelpContent, ...data
  });
  const csrfGuard = requireCsrfToken({ appTitle: options.appTitle });

  router.get("/vehicles", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const search = text(req.query.q), page = Number(req.query.page || 1), perPage = Number(req.query.perPage || VEHICLE_DEFAULT_PER_PAGE);
      const result = await listVehicles({ search, page, perPage });
      return res.render("pages/vehicles/index", { title: "Vehicles", appTitle: options.appTitle, email: res.locals.vehicleUser.email,
        search, ...result, startRecord: result.total ? (result.page - 1) * result.perPage + 1 : 0,
        endRecord: Math.min(result.total, result.page * result.perPage) });
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/new", async (req, res, next) => {
    try { if (await guard(req, res)) return renderForm(res, { vehicle: null, errors: [] }); } catch (error) { next(error); }
  });
  router.post("/vehicles/new", requireAuthorizedVehicleManager, localVehicleMutationRateLimit, vehicleMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const value = input(req.body);
      try { await createVehicle(value); return res.redirect("/vehicles?notice=created"); }
      catch (error) { return renderForm(res, { vehicle: value, errors: [(error as Error).message] }, 400); }
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/:vehicleId/edit", async (req, res, next) => {
    try { if (await guard(req, res)) { const vehicle = await getVehicleById(req.params.vehicleId); if (!vehicle) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle }); return renderForm(res, { vehicle, errors: [] }); } } catch (error) { next(error); }
  });
  router.post("/vehicles/:vehicleId/edit", requireAuthorizedVehicleManager, localVehicleMutationRateLimit, vehicleMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const vehicleId = text(req.params.vehicleId);
      const value = input(req.body); await updateVehicle(vehicleId, value); return res.redirect(`/vehicles/${vehicleId}?notice=updated`);
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/:vehicleId", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const vehicle = await getVehicleById(req.params.vehicleId);
      if (!vehicle) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      return res.render("pages/vehicles/detail", { title: vehicle.registration, appTitle: options.appTitle, email: res.locals.vehicleUser.email,
        vehicle, documents: await listVehicleDocuments(vehicle.id), driverAssignments: await listVehicleDriverAssignments(vehicle.id),
        drivers: await listDrivers(), baggageCategories: await listBaggageCategories(), documentTypes: VEHICLE_DOCUMENT_TYPES,
        helpFor: resolveHelpContent, notice: text(req.query.notice) });
    } catch (error) { return next(error); }
  });
  router.post("/vehicles/:vehicleId/driver", requireAuthorizedVehicleManager, localVehicleMutationRateLimit, vehicleMutationRateLimit, csrfGuard, async (req, res, next) => {
    try { const vehicleId = text(req.params.vehicleId); await assignVehicleDriver(vehicleId, text(req.body.driverId)); return res.redirect(`/vehicles/${vehicleId}?notice=driver-updated`); } catch (error) { next(error); }
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
      return res.render("pages/vehicles/operations", { title: "Driver assignment history", appTitle: options.appTitle, email: res.locals.vehicleUser.email, vehicle });
    } catch (error) { return next(error); }
  });
  // CodeQL may not identify the custom PostgreSQL-backed limiter below as a
  // framework rate limiter. It is intentionally before multer and CSRF parsing:
  // authorization runs first, then the atomic distributed counter, then the
  // bounded upload parser and CSRF validator.
  router.post("/vehicles/:vehicleId/documents", requireAuthorizedVehicleManager, localDocumentUploadRateLimit, limitDocumentUploads, upload.single("document"), requireCsrfToken({ appTitle: options.appTitle }), async (req, res, next) => {
    try {
      const file = req.file;
      if (!file || !text(req.body.documentType)) return res.redirect(`/vehicles/${req.params.vehicleId}?notice=document-required`);
      validateVehicleDocumentUpload(file);
      await createVehicleDocument({ vehicleId: text(req.params.vehicleId), documentType: text(req.body.documentType), documentNumber: text(req.body.documentNumber),
        issuedOn: text(req.body.issuedOn), expiresOn: text(req.body.expiresOn), originalFilename: file.originalname, mimeType: file.mimetype,
        content: file.buffer, uploadedBy: res.locals.vehicleUser.id });
      return res.redirect(`/vehicles/${req.params.vehicleId}?notice=document-added`);
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/documents/:documentId", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const document = await getVehicleDocument(req.params.documentId);
      if (!document || !document.content) return res.sendStatus(404);
      const disposition = text(req.query.download) === "1" ? "attachment" : "inline";
      res.setHeader("Content-Disposition", `${disposition}; filename="${safeDownloadName(document)}"`);
      res.type(document.mime_type || "application/octet-stream").send(document.content);
    } catch (error) { next(error); }
  });
  return router;
}
