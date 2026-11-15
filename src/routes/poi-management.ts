import { Router, type NextFunction, type Request, type Response } from "express";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { requireCsrfToken } from "../middleware/csrf";
import { getSessionAccount } from "../services/api";
import {
  poiFeeRecordToForm,
  poiManagementStore,
  poiRecordToForm,
  validatePoiFeeForm,
  validatePoiForm,
  type PoiFeeFormValues,
  type PoiFeeRecord,
  type PoiFormValues,
  type PoiManagementStore,
  type PoiRecord
} from "../services/poi-management";
import { readMapConfiguration } from "../services/maps";

type PoiManagementRouterOptions = {
  appTitle: string;
  store?: PoiManagementStore;
};

type RenderOptions = {
  poiForm?: PoiFormValues;
  poiErrors?: Record<string, string>;
  poiFormError?: string;
  feeForm?: PoiFeeFormValues;
  feeErrors?: Record<string, string>;
  feeFormError?: string;
  statusCode?: number;
};

const EMPTY_POI_FORM: PoiFormValues = {
  id: "",
  displayName: "",
  category: "",
  placeId: "",
  locationLabel: "",
  latitude: "",
  longitude: "",
  notes: ""
};

const EMPTY_FEE_FORM: PoiFeeFormValues = {
  id: "",
  poiId: "",
  action: "",
  amount: "",
  feeBasis: "",
  trigger: "",
  notes: ""
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapePoi(record: PoiRecord): PoiRecord {
  return {
    ...record,
    id: escapeHtml(record.id),
    displayName: escapeHtml(record.displayName),
    category: escapeHtml(record.category),
    placeId: escapeHtml(record.placeId),
    locationLabel: escapeHtml(record.locationLabel),
    notes: escapeHtml(record.notes)
  };
}

function escapeFee(record: PoiFeeRecord): PoiFeeRecord {
  return {
    ...record,
    id: escapeHtml(record.id),
    poiId: escapeHtml(record.poiId),
    poiDisplayName: escapeHtml(record.poiDisplayName),
    action: escapeHtml(record.action),
    amount: escapeHtml(record.amount),
    feeBasis: escapeHtml(record.feeBasis),
    notes: escapeHtml(record.notes)
  };
}

function safeValues<T extends Record<string, string>>(values: T): T {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, escapeHtml(value)])
  ) as T;
}

function safeErrors(errors: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(errors ?? {}).map(([key, value]) => [key, escapeHtml(value)]));
}

function hasSystemSettingsAccess(roles: unknown): boolean {
  return Array.isArray(roles) && roles.includes("superuser");
}

function unavailable(res: Response, appTitle: string): void {
  res.status(403).render("pages/unavailable", {
    title: "Unavailable",
    appTitle,
    message: "Your current session does not include the System settings role required for POI configuration."
  });
}

async function renderPage(
  req: Request,
  res: Response,
  next: NextFunction,
  appTitle: string,
  store: PoiManagementStore,
  page: "pois" | "fees",
  options: RenderOptions = {}
): Promise<void> {
  try {
    const session = await getSessionAccount(req.headers.cookie);
    if (!session.authenticated || !session.user) {
      res.redirect("/access");
      return;
    }
    const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
    if (!hasSystemSettingsAccess(roles)) {
      unavailable(res, appTitle);
      return;
    }

    const poiEditId = page === "pois" && typeof req.query.edit === "string" ? req.query.edit : "";
    const feeEditId = page === "fees" && typeof req.query.edit === "string" ? req.query.edit : "";
    const editingPoi = poiEditId ? await store.getPoi(poiEditId) : null;
    const editingFee = feeEditId ? await store.getFee(feeEditId) : null;
    if ((poiEditId && !editingPoi) || (feeEditId && !editingFee)) {
      res.status(404).render("pages/unavailable", { title: "Not found", appTitle });
      return;
    }

    const pois = await store.listPois();
    const fees = page === "fees" ? await store.listFees() : [];
    const mapConfiguration = readMapConfiguration();
    const poiForm = safeValues(options.poiForm ?? (editingPoi ? poiRecordToForm(editingPoi) : EMPTY_POI_FORM));
    const feeForm = safeValues(options.feeForm ?? (editingFee ? poiFeeRecordToForm(editingFee) : EMPTY_FEE_FORM));
    const title = page === "pois" ? "POIs" : "POI Fees";
    res.status(options.statusCode ?? 200).render("pages/poi-management", {
      title,
      appTitle,
      page,
      email: escapeHtml(session.user.email),
      grantedByLabel: "System Control (superuser)",
      pois: pois.map(escapePoi),
      fees: fees.map(escapeFee),
      poiForm,
      poiErrors: safeErrors(options.poiErrors),
      poiFormError: options.poiFormError ? escapeHtml(options.poiFormError) : "",
      feeForm,
      feeErrors: safeErrors(options.feeErrors),
      feeFormError: options.feeFormError ? escapeHtml(options.feeFormError) : "",
      mapConfigured: Boolean(mapConfiguration.enabled && mapConfiguration.browserApiKey),
      showPoiForm: Boolean(mapConfiguration.enabled && mapConfiguration.browserApiKey || editingPoi || options.poiForm),
      mapBrowserApiKey: escapeHtml(mapConfiguration.browserApiKey ?? ""),
      saved: req.query.saved === "1",
      deleted: req.query.deleted === "1",
      hasFees: req.query.hasFees === "1"
    });
  } catch (error) {
    next(error);
  }
}

export function createPoiManagementRouter(options: PoiManagementRouterOptions): Router {
  const router = Router();
  const store = options.store ?? poiManagementStore;
  const csrfGuard = requireCsrfToken({ appTitle: options.appTitle });
  router.use(noStoreProtectedResponse);

  for (const [page, path] of [["pois", "/settings/pois"], ["fees", "/settings/poi-fees"]] as const) {
    router.get(path, (req, res, next) => {
      void renderPage(req, res, next, options.appTitle, store, page);
    });

    router.post(path, csrfGuard, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!hasSystemSettingsAccess(roles)) return unavailable(res, options.appTitle);
        const actor = { accountId: session.user.id || null, email: session.user.email };

        if (page === "pois") {
          const validation = validatePoiForm(req.body);
          const id = validation.values.id || null;
          if (id && !await store.getPoi(id)) {
            return renderPage(req, res, next, options.appTitle, store, page, {
              poiForm: validation.values,
              poiFormError: "The POI could not be found. Reload the page and try again.",
              statusCode: 404
            });
          }
          if (Object.keys(validation.errors).length) {
            return renderPage(req, res, next, options.appTitle, store, page, {
              poiForm: validation.values,
              poiErrors: validation.errors,
              statusCode: 400
            });
          }
          const record = await store.savePoi(id, validation.values, actor);
          if (!record) {
            return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
          }
        } else {
          const pois = await store.listPois();
          const validation = validatePoiFeeForm(req.body, pois.map((poi) => poi.id));
          const id = validation.values.id || null;
          if (id && !await store.getFee(id)) {
            return renderPage(req, res, next, options.appTitle, store, page, {
              feeForm: validation.values,
              feeFormError: "The POI Fee could not be found. Reload the page and try again.",
              statusCode: 404
            });
          }
          if (Object.keys(validation.errors).length) {
            return renderPage(req, res, next, options.appTitle, store, page, {
              feeForm: validation.values,
              feeErrors: validation.errors,
              statusCode: 400
            });
          }
          const record = await store.saveFee(id, validation.values, actor);
          if (!record) {
            return renderPage(req, res, next, options.appTitle, store, page, {
              feeForm: validation.values,
              feeFormError: "The selected POI is unavailable. Select an existing POI and try again.",
              statusCode: 400
            });
          }
        }

        return res.redirect(303, `${path}?saved=1`);
      } catch (error) {
        return next(error);
      }
    });

    router.post(`${path}/:id/delete`, csrfGuard, async (req, res, next) => {
      try {
        const session = await getSessionAccount(req.headers.cookie);
        if (!session.authenticated || !session.user) return res.redirect("/access");
        const roles = Array.isArray(session.user.roles) ? session.user.roles : [];
        if (!hasSystemSettingsAccess(roles)) return unavailable(res, options.appTitle);
        const actor = { accountId: session.user.id || null, email: session.user.email };
        const recordId = typeof req.params.id === "string" ? req.params.id : "";
        if (page === "pois") {
          const result = await store.deletePoi(recordId, actor);
          if (result === "not-found") {
            return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
          }
          if (result === "has-fees") return res.redirect(303, `${path}?hasFees=1`);
        } else {
          const deleted = await store.deleteFee(recordId, actor);
          if (!deleted) return res.status(404).render("pages/unavailable", { title: "Not found", appTitle: options.appTitle });
        }
        return res.redirect(303, `${path}?deleted=1`);
      } catch (error) {
        return next(error);
      }
    });
  }

  return router;
}
