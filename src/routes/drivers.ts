import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, SessionAccount } from "../services/api";
import {
  buildDriverShortName,
  createDriverProfile,
  DRIVER_DEFAULT_PER_PAGE,
  DRIVER_DOCUMENT_LABELS,
  DRIVER_STATUS_FILTERS,
  DriverValidationError,
  getDriverById,
  listDriverEntityDocuments,
  listDriverLicenses,
  listDrivers,
  listUnprofiledDriverAccounts,
  readDriverEntityDocumentContent,
  saveDriverEntityDocument,
  saveDriverLicense,
  updateDriverProfile
} from "../services/drivers";
import { canManageStaff } from "../services/staff";
import { listLicensingAuthoritiesForManagement } from "../services/licensing";
import { VEHICLE_DOCUMENT_MAX_BYTES } from "../services/vehicles";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: VEHICLE_DOCUMENT_MAX_BYTES } });

type Options = {
  appTitle: string;
  loadSession?: (cookie?: string) => Promise<SessionAccount>;
};

const text = (value: unknown) => String(value ?? "").trim();

function notFound(res: any, appTitle: string) {
  return res.status(404).render("pages/unavailable", { title: "Not found", appTitle });
}

export function createDriversRouter(options: Options): Router {
  const router = Router();
  const loadSession = options.loadSession || getSessionAccount;
  const csrfGuard = requireCsrfToken({ appTitle: options.appTitle });
  router.use(noStoreProtectedResponse);

  const localMutationRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false
  });

  const localDocumentUploadRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
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
    if (!session.authenticated || !session.user) {
      res.redirect("/access");
      return false;
    }
    if (!(await canManageStaff(session.user.roles || []))) {
      res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      return false;
    }
    res.locals.driverUser = session.user;
    return true;
  }

  async function requireAuthorizedDriverManager(req: any, res: any, next: any) {
    try {
      if (await guard(req, res)) return next();
    } catch (error) {
      next(error);
    }
  }

  async function renderForm(res: any, data: any, status = 200) {
    return res.status(status).render("pages/drivers/form", {
      title: data.driverId ? "Edit driver" : "New driver",
      appTitle: options.appTitle,
      ...data
    });
  }

  async function renderDetail(res: any, driver: any, notice = "", status = 200) {
    return res.status(status).render("pages/drivers/detail", {
      title: driver.shortName,
      appTitle: options.appTitle,
      email: res.locals.driverUser.email,
      notice,
      driver,
      documents: await listDriverEntityDocuments(driver.id),
      licences: await listDriverLicenses(driver.id),
      documentLabels: DRIVER_DOCUMENT_LABELS,
      authorities: await listLicensingAuthoritiesForManagement(),
      editingLicenseId: text(res.req?.query?.editLicense)
    });
  }

  router.get("/drivers", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const search = text(req.query.q);
      const page = Number(req.query.page || 1);
      const perPage = Number(req.query.perPage || DRIVER_DEFAULT_PER_PAGE);
      const result = await listDrivers({ search, status: req.query.status, page, perPage });
      return res.render("pages/drivers/index", {
        title: result.status === "active" ? "Active drivers" : "Drivers",
        appTitle: options.appTitle,
        email: res.locals.driverUser.email,
        statuses: DRIVER_STATUS_FILTERS.filter((item) => item),
        notice: text(req.query.notice),
        ...result,
        startRecord: result.total ? (result.page - 1) * result.perPage + 1 : 0,
        endRecord: Math.min(result.total, result.page * result.perPage)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/drivers/new", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      return renderForm(res, {
        email: res.locals.driverUser.email,
        driverId: "",
        firstName: "",
        lastName: "",
        shortName: "",
        accountOptions: await listUnprofiledDriverAccounts(),
        errors: []
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/drivers/new", requireAuthorizedDriverManager, localMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const driverId = text(req.body.driverId);
      const firstName = text(req.body.firstName);
      const lastName = text(req.body.lastName);
      const shortName = buildDriverShortName(firstName, lastName);
      try {
        const driver = await createDriverProfile(driverId, { firstName, lastName });
        return res.redirect(`/drivers/${encodeURIComponent(driver.id)}?notice=created`);
      } catch (error) {
        if (!(error instanceof DriverValidationError)) throw error;
        return renderForm(res, {
          email: res.locals.driverUser.email,
          driverId,
          firstName,
          lastName,
          shortName,
          accountOptions: await listUnprofiledDriverAccounts(),
          errors: [error.message]
        }, 400);
      }
    } catch (error) {
      next(error);
    }
  });

  router.get("/drivers/:driverId", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const driver = await getDriverById(text(req.params.driverId));
      if (!driver) return notFound(res, options.appTitle);
      return renderDetail(res, driver, text(req.query.notice));
    } catch (error) {
      next(error);
    }
  });

  router.get("/drivers/:driverId/edit", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const driver = await getDriverById(text(req.params.driverId));
      if (!driver) return notFound(res, options.appTitle);
      return renderForm(res, {
        email: res.locals.driverUser.email,
        driverId: driver.id,
        firstName: driver.firstName,
        lastName: driver.lastName,
        shortName: driver.shortName,
        accountOptions: [],
        errors: []
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/drivers/:driverId/edit", requireAuthorizedDriverManager, localMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const driverId = text(req.params.driverId);
      const firstName = text(req.body.firstName);
      const lastName = text(req.body.lastName);
      const shortName = buildDriverShortName(firstName, lastName);
      try {
        const updated = await updateDriverProfile(driverId, { firstName, lastName });
        if (!updated) return notFound(res, options.appTitle);
        return res.redirect(`/drivers/${encodeURIComponent(driverId)}?notice=updated`);
      } catch (error) {
        if (!(error instanceof DriverValidationError)) throw error;
        return renderForm(res, {
          email: res.locals.driverUser.email,
          driverId,
          firstName,
          lastName,
          shortName,
          accountOptions: [],
          errors: [error.message]
        }, 400);
      }
    } catch (error) {
      next(error);
    }
  });

  router.post("/drivers/:driverId/licences", requireAuthorizedDriverManager, localMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const driverId = text(req.params.driverId);
      const driver = await getDriverById(driverId);
      if (!driver) return notFound(res, options.appTitle);
      const licenseId = text(req.body.licenseId);
      try {
        const saved = await saveDriverLicense(driverId, {
          licensingAuthorityId: text(req.body.licensingAuthorityId),
          licenseReference: text(req.body.licenseReference),
          validFrom: text(req.body.validFrom),
          validUntil: text(req.body.validUntil),
          notes: text(req.body.notes)
        }, licenseId || undefined);
        if (licenseId && !saved) return notFound(res, options.appTitle);
        return res.redirect(`/drivers/${encodeURIComponent(driverId)}?notice=licence-saved`);
      } catch (error) {
        if (error instanceof DriverValidationError || (error as { code?: string }).code === "23503") {
          const query = licenseId
            ? `?notice=licence-invalid&editLicense=${encodeURIComponent(licenseId)}`
            : "?notice=licence-invalid";
          return res.redirect(`/drivers/${encodeURIComponent(driverId)}${query}`);
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/drivers/:driverId/documents",
    requireAuthorizedDriverManager,
    localDocumentUploadRateLimit,
    upload.single("document"),
    csrfGuard,
    async (req, res, next) => {
      try {
        const driverId = text(req.params.driverId);
        const driver = await getDriverById(driverId);
        if (!driver) return notFound(res, options.appTitle);
        const file = req.file;
        if (!file || !text(req.body.category)) {
          return res.redirect(`/drivers/${encodeURIComponent(driverId)}?notice=document-required`);
        }
        try {
          await saveDriverEntityDocument({
            driverId,
            category: text(req.body.category),
            file,
            uploadedBy: res.locals.driverUser.id
          });
          return res.redirect(`/drivers/${encodeURIComponent(driverId)}?notice=document-added`);
        } catch (error) {
          if (error instanceof DriverValidationError) {
            return res.redirect(`/drivers/${encodeURIComponent(driverId)}?notice=document-invalid`);
          }
          throw error;
        }
      } catch (error) {
        next(error);
      }
    }
  );

  router.get("/drivers/documents/:documentId/view", requireAuthorizedDriverManager, localDocumentDownloadRateLimit, async (req, res, next) => {
    try {
      const result = await readDriverEntityDocumentContent(text(req.params.documentId));
      if (!result) return notFound(res, options.appTitle);
      const mimeType = result.document.mime_type || "application/octet-stream";
      res.setHeader("Content-Type", mimeType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.send(result.content);
    } catch (error) {
      next(error);
    }
  });

  router.get("/drivers/documents/:documentId/download", requireAuthorizedDriverManager, localDocumentDownloadRateLimit, async (req, res, next) => {
    try {
      const result = await readDriverEntityDocumentContent(text(req.params.documentId));
      if (!result) return notFound(res, options.appTitle);
      const mimeType = result.document.mime_type || "application/octet-stream";
      res.setHeader("Content-Type", mimeType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", `attachment; filename="${result.document.original_filename}"`);
      return res.send(result.content);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
