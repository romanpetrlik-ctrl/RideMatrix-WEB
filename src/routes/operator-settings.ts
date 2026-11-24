import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { getSessionAccount, type SessionAccount } from "../services/api";
import { listLicensingAuthorities } from "../services/licensing";
import {
  getSetupOverview,
  saveOperatorAddress,
  saveOperatorLicence,
  saveOperatorLicenceDocument,
  saveOperatorProfile,
  SetupValidationError,
  type SetupOverview
} from "../services/system-setup";
import { canAccessWorkspace, systemSettingsModule } from "./role-sections";

type Options = {
  appTitle: string;
  loadSession?: (cookieHeader?: string) => Promise<SessionAccount>;
};

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES }
});

const text = (value: unknown): string => String(value ?? "").trim();
const optionalText = (value: unknown): string | null => text(value) || null;
const optionalNumber = (value: unknown): number | null => {
  const normalized = text(value);
  return normalized ? Number(normalized) : null;
};

function licenceStatusReason(overview: SetupOverview): string {
  const licence = overview.licence;
  if (!licence) return "PHO licence is not set up yet.";
  if (licence.status === "active") return "";
  if (!overview.latestDocument) return "Licence is not active: upload a licence document.";
  return "Licence is not active: the licensing authority or licence dates are not valid.";
}

export function createOperatorSettingsRouter(options: Options): Router {
  const router = Router();
  router.use("/settings/operator", noStoreProtectedResponse);
  const csrf = requireCsrfToken({ appTitle: options.appTitle });

  const loadSession = options.loadSession ?? getSessionAccount;
  const requireSystemSettings = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) return res.redirect("/access");
      if (!canAccessWorkspace(session.user.roles, systemSettingsModule.key)) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }
      res.locals.operatorSettingsActor = {
        userId: String(session.user.id || ""),
        email: String(session.user.email || "").trim().toLowerCase(),
        roles: session.user.roles
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };

  // Multer must run before requireCsrfToken so the multipart token field is available.
  const readDocumentUpload = (req: Request, res: Response, next: NextFunction) => {
    documentUpload.single("licenceDocument")(req, res, (error: unknown) => {
      if (error) {
        res.locals.operatorSettingsUploadError =
          error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
            ? "Licence document must be 10 MB or smaller."
            : "The licence document upload could not be read.";
      }
      next();
    });
  };

  async function renderPage(res: Response, email: string, errors: string[] = [], notice = "", status = 200) {
    const [overview, authorities] = await Promise.all([getSetupOverview(), listLicensingAuthorities()]);
    return res.status(status).render("pages/operator-settings", {
      title: "Operator & licence",
      appTitle: options.appTitle,
      email,
      overview,
      authorities,
      licenceReason: licenceStatusReason(overview),
      errors,
      notice
    });
  }

  router.get("/settings/operator", requireSystemSettings, async (req, res, next) => {
    try {
      const actor = res.locals.operatorSettingsActor as { email: string };
      return await renderPage(res, actor.email, [], req.query.notice === "saved" ? "saved" : "");
    } catch (error) {
      return next(error);
    }
  });

  router.post("/settings/operator", requireSystemSettings, readDocumentUpload, csrf, async (req, res, next) => {
    const actor = res.locals.operatorSettingsActor as { userId: string; email: string; roles: string[] };
    const postSetup = { postSetup: true };
    try {
      const section = text(req.body?.section);
      if (section === "profile") {
        await saveOperatorProfile(actor, {
          legalName: text(req.body.legalName),
          tradingName: optionalText(req.body.tradingName),
          licenceHolderName: text(req.body.licenceHolderName)
        }, postSetup);
      } else if (section === "address") {
        const addressType = text(req.body.addressType) === "operational" ? "operational" : "registered_pho";
        await saveOperatorAddress(actor, {
          addressType,
          formattedAddress: text(req.body.formattedAddress),
          houseNameNumber: optionalText(req.body.houseNameNumber),
          addressLine1: text(req.body.addressLine1),
          addressLine2: optionalText(req.body.addressLine2),
          addressLine3: optionalText(req.body.addressLine3),
          cityTown: text(req.body.cityTown),
          county: optionalText(req.body.county),
          state: optionalText(req.body.state),
          postcode: text(req.body.postcode),
          countryCode: text(req.body.countryCode),
          countryName: text(req.body.countryName),
          latitude: optionalNumber(req.body.latitude),
          longitude: optionalNumber(req.body.longitude),
          providerName: optionalText(req.body.providerName),
          providerPlaceId: optionalText(req.body.providerPlaceId)
        }, undefined, postSetup);
      } else if (section === "licence") {
        await saveOperatorLicence(actor, {
          licenceNumber: text(req.body.licenceNumber),
          licensingAuthorityId: text(req.body.licensingAuthorityId),
          validFrom: text(req.body.validFrom),
          validTo: optionalText(req.body.validTo)
        }, postSetup);
      } else if (section === "document") {
        if (res.locals.operatorSettingsUploadError) {
          return await renderPage(res, actor.email, [res.locals.operatorSettingsUploadError], "", 400);
        }
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) {
          return await renderPage(res, actor.email, ["Upload a licence document."], "", 400);
        }
        await saveOperatorLicenceDocument(actor, {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          buffer: file.buffer
        }, postSetup);
      } else {
        return await renderPage(res, actor.email, ["Unknown settings section."], "", 400);
      }
      return res.redirect(303, "/settings/operator?notice=saved");
    } catch (error) {
      if (error instanceof SetupValidationError) {
        return await renderPage(res, actor.email, [error.message], "", 400);
      }
      return next(error);
    }
  });

  return router;
}
