import { Router } from "express";
import multer from "multer";
import { requireCsrfToken } from "../middleware/csrf";
import { getSessionAccount, SessionAccount } from "../services/api";
import { canManageStaff } from "../services/staff";
import {
  assignVehicleDriver, createVehicle, createVehicleDocument, getVehicleById, getVehicleDocument,
  listBaggageCategories, listDrivers, listVehicleClasses, listVehicleDocuments, listVehicles,
  updateVehicle, VEHICLE_DEFAULT_PER_PAGE, VEHICLE_STATUS_OPTIONS, VehicleInput
} from "../services/vehicles";

type Options = { appTitle: string; loadSession?: (cookie?: string) => Promise<SessionAccount> };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const text = (value: unknown) => String(value ?? "").trim();
function input(body: any): VehicleInput {
  const year = text(body.year);
  return { registration: text(body.registration), make: text(body.make), model: text(body.model),
    year: year ? Number(year) : null, colour: text(body.colour) || null,
    vehicleClassKey: text(body.vehicleClassKey), status: text(body.status) as any || "available",
    notes: text(body.notes) || null };
}

export function createVehiclesRouter(options: Options): Router {
  const router = Router();
  const loadSession = options.loadSession || getSessionAccount;
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
  const renderForm = async (res: any, data: any, status = 200) => res.status(status).render("pages/vehicles/form", {
    title: data.vehicle ? "Edit vehicle" : "New vehicle", appTitle: options.appTitle,
    classes: await listVehicleClasses(), statuses: VEHICLE_STATUS_OPTIONS, ...data
  });

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
  router.post("/vehicles/new", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const value = input(req.body);
      try { await createVehicle(value); return res.redirect("/vehicles?notice=created"); }
      catch (error) { return renderForm(res, { vehicle: value, errors: [(error as Error).message] }, 400); }
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/:vehicleId/edit", async (req, res, next) => {
    try { if (await guard(req, res)) { const vehicle = await getVehicleById(req.params.vehicleId); if (!vehicle) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle }); return renderForm(res, { vehicle, errors: [] }); } } catch (error) { next(error); }
  });
  router.post("/vehicles/:vehicleId/edit", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const value = input(req.body); await updateVehicle(req.params.vehicleId, value); return res.redirect(`/vehicles/${req.params.vehicleId}?notice=updated`);
    } catch (error) { return next(error); }
  });
  router.get("/vehicles/:vehicleId", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const vehicle = await getVehicleById(req.params.vehicleId);
      if (!vehicle) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
      return res.render("pages/vehicles/detail", { title: vehicle.registration, appTitle: options.appTitle, email: res.locals.vehicleUser.email,
        vehicle, documents: await listVehicleDocuments(vehicle.id), drivers: await listDrivers(), baggageCategories: await listBaggageCategories(),
        notice: text(req.query.notice) });
    } catch (error) { return next(error); }
  });
  router.post("/vehicles/:vehicleId/driver", async (req, res, next) => {
    try { if (await guard(req, res)) { await assignVehicleDriver(req.params.vehicleId, text(req.body.driverId)); return res.redirect(`/vehicles/${req.params.vehicleId}?notice=driver-updated`); } } catch (error) { next(error); }
  });
  router.post("/vehicles/:vehicleId/documents", upload.single("document"), requireCsrfToken({ appTitle: options.appTitle }), async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const file = req.file;
      if (!file || !text(req.body.documentType)) return res.redirect(`/vehicles/${req.params.vehicleId}?notice=document-required`);
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
      res.type(document.mime_type || "application/octet-stream").send(document.content);
    } catch (error) { next(error); }
  });
  return router;
}
