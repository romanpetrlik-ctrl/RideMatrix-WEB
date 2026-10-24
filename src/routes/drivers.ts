import { randomUUID } from "node:crypto";
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
  transitionDriverStatus,
  updateDriverProfile
} from "../services/drivers";
import { canManageStaff } from "../services/staff";
import { listLicensingAuthoritiesForManagement } from "../services/licensing";
import { VEHICLE_DOCUMENT_MAX_BYTES } from "../services/vehicles";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: VEHICLE_DOCUMENT_MAX_BYTES } });

type Options = {
  appTitle: string;
  loadSession?: (cookie?: string) => Promise<SessionAccount>;
  transitionDriverStatus?: typeof transitionDriverStatus;
  getDriverById?: typeof getDriverById;
  updateDriverProfile?: typeof updateDriverProfile;
  listDriverEntityDocuments?: typeof listDriverEntityDocuments;
  listDriverLicenses?: typeof listDriverLicenses;
  listLicensingAuthoritiesForManagement?: typeof listLicensingAuthoritiesForManagement;
};

const text = (value: unknown) => String(value ?? "").trim();

function notFound(res: any, appTitle: string) {
  return res.status(404).render("pages/unavailable", { title: "Not found", appTitle });
}

function renderDriverLoadFailure(res: any, appTitle: string, driverId: string, operation: string, error: unknown) {
  const correlationId = randomUUID();
  console.error(`[drivers] Failed to ${operation} driver ${driverId} (reference ${correlationId}):`, error);
  return res.status(500).render("pages/drivers/unavailable", {
    title: "Driver record unavailable",
    appTitle,
    message: `We couldn't load this driver record. Reference: ${correlationId}`
  });
}

function renderDriverPage(
  res: any,
  view: string,
  locals: Record<string, unknown>,
  status: number,
  driverId: string,
  operation: string
) {
  return res.status(status).render(view, locals, (error: Error | null, html: string) => {
    if (error) return renderDriverLoadFailure(res, String(locals.appTitle || "RideMatrix"), driverId, operation, error);
    return res.send(html);
  });
}

export function createDriversRouter(options: Options): Router {
  const router = Router();
  const loadSession = options.loadSession || getSessionAccount;
  const saveDriverStatus = options.transitionDriverStatus || transitionDriverStatus;
  const loadDriver = options.getDriverById || getDriverById;
  const saveDriverProfile = options.updateDriverProfile || updateDriverProfile;
  const loadDriverDocuments = options.listDriverEntityDocuments || listDriverEntityDocuments;
  const loadDriverLicenses = options.listDriverLicenses || listDriverLicenses;
  const loadLicensingAuthorities = options.listLicensingAuthoritiesForManagement || listLicensingAuthoritiesForManagement;
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
    const locals = {
      title: data.isNew ? "New driver" : (data.profileComplete ? "Edit driver" : "Complete driver profile"),
      appTitle: options.appTitle,
      isNew: Boolean(data.isNew),
      ...data
    };
    return renderDriverPage(res, "pages/drivers/form", locals, status, text(data.driverId), "render profile form for");
  }

  async function renderDetail(res: any, driver: any, notice = "", status = 200) {
    const locals = {
      title: driver.displayName,
      appTitle: options.appTitle,
      email: res.locals.driverUser.email,
      notice,
      driver,
      documents: await loadDriverDocuments(driver.id),
      licences: await loadDriverLicenses(driver.id),
      documentLabels: DRIVER_DOCUMENT_LABELS,
      authorities: await loadLicensingAuthorities(),
      editingLicenseId: text(res.req?.query?.editLicense)
    };
    return renderDriverPage(res, "pages/drivers/detail", locals, status, driver.id, "render detail page for");
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
        isNew: true,
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
          isNew: true,
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
      const driver = await loadDriver(text(req.params.driverId));
      if (!driver) return notFound(res, options.appTitle);
      return renderDetail(res, driver, text(req.query.notice));
    } catch (error) {
      return renderDriverLoadFailure(res, options.appTitle, text(req.params.driverId), "load", error);
    }
  });

  router.get("/drivers/:driverId/edit", async (req, res, next) => {
    try {
      if (!(await guard(req, res))) return;
      const driver = await loadDriver(text(req.params.driverId));
      if (!driver) return notFound(res, options.appTitle);
      return renderForm(res, {
        email: res.locals.driverUser.email,
        driverId: driver.id,
        firstName: driver.firstName,
        lastName: driver.lastName,
        shortName: driver.shortName,
        profileComplete: driver.profileComplete,
        accountOptions: [],
        errors: []
      });
    } catch (error) {
      return renderDriverLoadFailure(res, options.appTitle, text(req.params.driverId), "load edit form for", error);
    }
  });

  router.post("/drivers/:driverId/edit", requireAuthorizedDriverManager, localMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const driverId = text(req.params.driverId);
      const firstName = text(req.body.firstName);
      const lastName = text(req.body.lastName);
      const shortName = buildDriverShortName(firstName, lastName);
      try {
        const updated = await saveDriverProfile(driverId, { firstName, lastName });
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
          profileComplete: Boolean(firstName && lastName),
          accountOptions: [],
          errors: [error.message]
        }, 400);
      }
    } catch (error) {
      next(error);
    }
  });

  router.post("/drivers/:driverId/archive", requireAuthorizedDriverManager, localMutationRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const driverId = text(req.params.driverId);
      await saveDriverStatus({
        driverId,
        status: "archived",
        reason: text(req.body.reason),
        actorId: res.locals.driverUser.id,
        actorEmail: res.locals.driverUser.email
      });
      return res.redirect(`/drivers/${encodeURIComponent(driverId)}?notice=archived`);
    } catch (error) {
      if (error instanceof DriverValidationError) {
        const notice = error.message === "A reason is required for this status transition."
          ? "archive-reason-required"
          : "archive-invalid";
        return res.redirect(`/drivers/${encodeURIComponent(text(req.params.driverId))}?notice=${notice}`);
      }
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
