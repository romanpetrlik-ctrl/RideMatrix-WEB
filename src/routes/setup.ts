import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { requireCsrfToken } from "../middleware/csrf";
import { noStoreProtectedResponse } from "../middleware/no-store";
import { SessionAccount, getSessionAccount } from "../services/api";
import { listLicensingAuthorities } from "../services/licensing";
import {
  CLEANUP_TARGETS,
  CleanupTarget,
  MissingAuthRoleError,
  SetupValidationError,
  assertSafeNotificationSinkForTestEmail,
  bootstrapRealInstallerSuperuser,
  completeInitialSetup,
  deactivateLegacyOperationalAccounts,
  getBootstrapState,
  getSetupOverview,
  isSetupAdministrationRole,
  listSetupAuditEvents,
  saveOperatorAddress,
  saveOperatorLicence,
  saveOperatorLicenceDocument,
  saveOperatorProfile
} from "../services/system-setup";

type SetupRouterOptions = {
  appTitle: string;
  loadSession?: (cookieHeader?: string) => Promise<SessionAccount>;
};

const setupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const SETUP_STEP_PATHS = {
  bootstrap_superuser: "/setup/bootstrap-superuser",
  operator_profile: "/setup/operator-profile",
  registered_pho_address: "/setup/registered-pho-address",
  operational_address: "/setup/operational-address",
  pho_licence: "/setup/pho-licence",
  licence_document: "/setup/licence-document",
  review_confirmation: "/setup/review",
  completed: "/setup/completed"
} as const;

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized ? normalized : null;
}

function parseAllowedBootstrapEmails(): string[] {
  return String(process.env.INITIAL_SETUP_ALLOWED_EMAILS || "")
    .split(",")
    .map((entry) => normalizeText(entry).toLowerCase())
    .filter(Boolean);
}

function stepFromPath(routePath: string): keyof typeof SETUP_STEP_PATHS {
  const found = (Object.entries(SETUP_STEP_PATHS) as Array<[keyof typeof SETUP_STEP_PATHS, string]>).find(
    ([, href]) => href === routePath
  );
  return found?.[0] ?? "bootstrap_superuser";
}

function isStepReachable(requestedPath: string, currentStep: keyof typeof SETUP_STEP_PATHS): boolean {
  const order = Object.keys(SETUP_STEP_PATHS) as Array<keyof typeof SETUP_STEP_PATHS>;
  const requestedStep = stepFromPath(requestedPath);
  return order.indexOf(requestedStep) <= order.indexOf(currentStep);
}

export function createSetupRouter(options: SetupRouterOptions): Router {
  const router = Router();
  router.use(noStoreProtectedResponse);
  const loadSession = options.loadSession ?? getSessionAccount;
  const setupRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false
  });

  async function resolveSession(req: Parameters<typeof loadSession>[0]): Promise<SessionAccount> {
    return loadSession(req);
  }

  function toActor(session: SessionAccount): { userId: string; email: string; roles: string[] } {
    return {
      userId: String(session.user?.id || ""),
      email: String(session.user?.email || "").trim().toLowerCase(),
      roles: Array.isArray(session.user?.roles) ? session.user?.roles : []
    };
  }

  async function canAccessSetupAdministration(session: SessionAccount): Promise<boolean> {
    if (!session.authenticated || !session.user) {
      return false;
    }
    const overview = await getSetupOverview();
    if (!overview.bootstrapCompleted) {
      const allowedBootstrapEmails = parseAllowedBootstrapEmails();
      if (allowedBootstrapEmails.length === 0) {
        return isSetupAdministrationRole(session.user.roles || []);
      }
      return (
        isSetupAdministrationRole(session.user.roles || []) ||
        allowedBootstrapEmails.includes(String(session.user.email || "").trim().toLowerCase())
      );
    }
    if (!isSetupAdministrationRole(session.user.roles || [])) {
      return false;
    }
    if (session.user.roles.includes("superuser")) {
      return true;
    }
    const bootstrap = await getBootstrapState();
    return (
      bootstrap?.status === "completed" &&
      bootstrap.installerUserId === session.user.id &&
      session.user.roles.includes("admin")
    );
  }

  async function renderWizard(
    res: any,
    session: SessionAccount,
    requestedPath: string,
    errors: string[] = [],
    notice: string | null = null,
    formOverrides: Record<string, string> = {}
  ) {
    const overview = await getSetupOverview();
    const currentPath = SETUP_STEP_PATHS[overview.currentStep];

    if (overview.setupCompleted && requestedPath !== SETUP_STEP_PATHS.completed) {
      return res.redirect(SETUP_STEP_PATHS.completed);
    }

    if (!isStepReachable(requestedPath, overview.currentStep) && requestedPath !== currentPath) {
      return res.redirect(currentPath);
    }

    const authorities = await listLicensingAuthorities();
    const setupAudit = await listSetupAuditEvents(10);
    const formData = {
      installerEmail: session.user?.email || "",
      legalName: overview.operator?.legalName || "",
      tradingName: overview.operator?.tradingName || "",
      licenceHolderName: overview.operator?.licenceHolderName || "",
      licenceNumber: overview.licence?.licenceNumber || "",
      licensingAuthorityId: overview.licence?.licensingAuthorityId || "",
      validFrom: overview.licence?.validFrom || "",
      validTo: overview.licence?.validTo || "",
      formattedAddress:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.formattedAddress
          : overview.addressDetails.registeredPho?.formattedAddress) || "",
      houseNameNumber:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.houseNameNumber
          : overview.addressDetails.registeredPho?.houseNameNumber) || "",
      addressLine1:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.addressLine1
          : overview.addressDetails.registeredPho?.addressLine1) || "",
      addressLine2:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.addressLine2
          : overview.addressDetails.registeredPho?.addressLine2) || "",
      addressLine3:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.addressLine3
          : overview.addressDetails.registeredPho?.addressLine3) || "",
      cityTown:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.cityTown
          : overview.addressDetails.registeredPho?.cityTown) || "",
      county:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.county
          : overview.addressDetails.registeredPho?.county) || "",
      state:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.state
          : overview.addressDetails.registeredPho?.state) || "",
      postcode:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.postcode
          : overview.addressDetails.registeredPho?.postcode) || "",
      countryCode:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.countryCode
          : overview.addressDetails.registeredPho?.countryCode) || "",
      countryName:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.countryName
          : overview.addressDetails.registeredPho?.countryName) || "",
      latitude:
        String(
          requestedPath === SETUP_STEP_PATHS.operational_address
            ? overview.addressDetails.operational?.latitude ?? ""
            : overview.addressDetails.registeredPho?.latitude ?? ""
        ) || "",
      longitude:
        String(
          requestedPath === SETUP_STEP_PATHS.operational_address
            ? overview.addressDetails.operational?.longitude ?? ""
            : overview.addressDetails.registeredPho?.longitude ?? ""
        ) || "",
      providerName:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.providerName
          : overview.addressDetails.registeredPho?.providerName) || "",
      providerPlaceId:
        (requestedPath === SETUP_STEP_PATHS.operational_address
          ? overview.addressDetails.operational?.providerPlaceId
          : overview.addressDetails.registeredPho?.providerPlaceId) || ""
    };

    for (const [key, value] of Object.entries(formOverrides)) {
      if (typeof value === "string") {
        (formData as Record<string, string>)[key] = value;
      }
    }

    return res.render("pages/setup/wizard", {
      title: "Initial Setup",
      appTitle: options.appTitle,
      email: session.user?.email || "",
      currentPath,
      requestedPath,
      stepPaths: SETUP_STEP_PATHS,
      setup: overview,
      authorities,
      errors,
      notice,
      formData,
      setupAudit,
      cleanupTargets: CLEANUP_TARGETS
    });
  }

  router.get("/setup", setupRateLimit, async (req, res, next) => {
    try {
      const session = await resolveSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }

      if (!(await canAccessSetupAdministration(session))) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }

      const overview = await getSetupOverview();
      return res.redirect(SETUP_STEP_PATHS[overview.currentStep]);
    } catch (error) {
      next(error);
    }
  });

  for (const stepPath of Object.values(SETUP_STEP_PATHS)) {
    router.get(stepPath, setupRateLimit, async (req, res, next) => {
      try {
        const session = await resolveSession(req.headers.cookie);
        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }
        if (!(await canAccessSetupAdministration(session))) {
          return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
        }
        return renderWizard(res, session, req.path);
      } catch (error) {
        next(error);
      }
    });
  }

  const csrfGuard = requireCsrfToken({ appTitle: options.appTitle });

  router.post("/setup/bootstrap-superuser", setupRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const session = await resolveSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }
      if (!(await canAccessSetupAdministration(session))) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }

      await bootstrapRealInstallerSuperuser({
        actor: toActor(session),
        installerEmail: normalizeText(req.body.installerEmail)
      });

      const overview = await getSetupOverview();
      return res.redirect(SETUP_STEP_PATHS[overview.currentStep]);
    } catch (error) {
      if (error instanceof SetupValidationError || error instanceof MissingAuthRoleError) {
        const session = await resolveSession(req.headers.cookie).catch(() => ({ authenticated: false } as SessionAccount));
        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }
        return renderWizard(
          res,
          session,
          req.path.replace(/\/$/, ""),
          [error.message],
          null,
          {
            installerEmail: normalizeText(req.body.installerEmail)
          }
        );
      }
      return next(error);
    }
  });

  router.post("/setup/operator-profile", setupRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const session = await resolveSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }
      if (!(await canAccessSetupAdministration(session))) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }

      await saveOperatorProfile(toActor(session), {
        legalName: normalizeText(req.body.legalName),
        tradingName: normalizeText(req.body.tradingName),
        licenceHolderName: normalizeText(req.body.licenceHolderName),
        status: "trial"
      });

      return res.redirect(SETUP_STEP_PATHS.registered_pho_address);
    } catch (error) {
      if (error instanceof SetupValidationError || error instanceof MissingAuthRoleError) {
        const session = await resolveSession(req.headers.cookie).catch(() => ({ authenticated: false } as SessionAccount));
        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }
        return renderWizard(res, session, req.path, [error.message], null, {
          legalName: normalizeText(req.body.legalName),
          tradingName: normalizeText(req.body.tradingName),
          licenceHolderName: normalizeText(req.body.licenceHolderName),
        });
      }
      return next(error);
    }
  });

  router.post("/setup/registered-pho-address", setupRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const session = await resolveSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }
      if (!(await canAccessSetupAdministration(session))) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }

      await saveOperatorAddress(toActor(session), {
        addressType: "registered_pho",
        formattedAddress: normalizeText(req.body.formattedAddress),
        houseNameNumber: normalizeOptionalText(req.body.houseNameNumber),
        addressLine1: normalizeText(req.body.addressLine1),
        addressLine2: normalizeOptionalText(req.body.addressLine2),
        addressLine3: normalizeOptionalText(req.body.addressLine3),
        cityTown: normalizeText(req.body.cityTown),
        county: normalizeOptionalText(req.body.county),
        state: normalizeOptionalText(req.body.state),
        postcode: normalizeText(req.body.postcode),
        countryCode: normalizeText(req.body.countryCode),
        countryName: normalizeText(req.body.countryName),
        latitude: normalizeOptionalText(req.body.latitude) ? Number(req.body.latitude) : null,
        longitude: normalizeOptionalText(req.body.longitude) ? Number(req.body.longitude) : null,
        providerName: normalizeOptionalText(req.body.providerName),
        providerPlaceId: normalizeOptionalText(req.body.providerPlaceId)
      });

      return res.redirect(SETUP_STEP_PATHS.operational_address);
    } catch (error) {
      if (error instanceof SetupValidationError || error instanceof MissingAuthRoleError) {
        const session = await resolveSession(req.headers.cookie).catch(() => ({ authenticated: false } as SessionAccount));
        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }
        return renderWizard(res, session, req.path, [error.message], null, {
          formattedAddress: normalizeText(req.body.formattedAddress),
          houseNameNumber: normalizeText(req.body.houseNameNumber),
          addressLine1: normalizeText(req.body.addressLine1),
          addressLine2: normalizeText(req.body.addressLine2),
          addressLine3: normalizeText(req.body.addressLine3),
          cityTown: normalizeText(req.body.cityTown),
          county: normalizeText(req.body.county),
          state: normalizeText(req.body.state),
          postcode: normalizeText(req.body.postcode),
          countryCode: normalizeText(req.body.countryCode),
          countryName: normalizeText(req.body.countryName),
          latitude: normalizeText(req.body.latitude),
          longitude: normalizeText(req.body.longitude),
          providerName: normalizeText(req.body.providerName),
          providerPlaceId: normalizeText(req.body.providerPlaceId)
        });
      }
      return next(error);
    }
  });

  router.post("/setup/operational-address", setupRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const session = await resolveSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }
      if (!(await canAccessSetupAdministration(session))) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }

      await saveOperatorAddress(toActor(session), {
        addressType: "operational",
        formattedAddress: normalizeText(req.body.formattedAddress),
        houseNameNumber: normalizeOptionalText(req.body.houseNameNumber),
        addressLine1: normalizeText(req.body.addressLine1),
        addressLine2: normalizeOptionalText(req.body.addressLine2),
        addressLine3: normalizeOptionalText(req.body.addressLine3),
        cityTown: normalizeText(req.body.cityTown),
        county: normalizeOptionalText(req.body.county),
        state: normalizeOptionalText(req.body.state),
        postcode: normalizeText(req.body.postcode),
        countryCode: normalizeText(req.body.countryCode),
        countryName: normalizeText(req.body.countryName),
        latitude: normalizeOptionalText(req.body.latitude) ? Number(req.body.latitude) : null,
        longitude: normalizeOptionalText(req.body.longitude) ? Number(req.body.longitude) : null,
        providerName: normalizeOptionalText(req.body.providerName),
        providerPlaceId: normalizeOptionalText(req.body.providerPlaceId)
      });

      return res.redirect(SETUP_STEP_PATHS.pho_licence);
    } catch (error) {
      if (error instanceof SetupValidationError || error instanceof MissingAuthRoleError) {
        const session = await resolveSession(req.headers.cookie).catch(() => ({ authenticated: false } as SessionAccount));
        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }
        return renderWizard(res, session, req.path, [error.message], null, {
          formattedAddress: normalizeText(req.body.formattedAddress),
          houseNameNumber: normalizeText(req.body.houseNameNumber),
          addressLine1: normalizeText(req.body.addressLine1),
          addressLine2: normalizeText(req.body.addressLine2),
          addressLine3: normalizeText(req.body.addressLine3),
          cityTown: normalizeText(req.body.cityTown),
          county: normalizeText(req.body.county),
          state: normalizeText(req.body.state),
          postcode: normalizeText(req.body.postcode),
          countryCode: normalizeText(req.body.countryCode),
          countryName: normalizeText(req.body.countryName),
          latitude: normalizeText(req.body.latitude),
          longitude: normalizeText(req.body.longitude),
          providerName: normalizeText(req.body.providerName),
          providerPlaceId: normalizeText(req.body.providerPlaceId)
        });
      }
      return next(error);
    }
  });

  router.post("/setup/pho-licence", setupRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const session = await resolveSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }
      if (!(await canAccessSetupAdministration(session))) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }

      await saveOperatorLicence(toActor(session), {
        licenceNumber: normalizeText(req.body.licenceNumber),
        licensingAuthorityId: normalizeText(req.body.licensingAuthorityId),
        validFrom: normalizeText(req.body.validFrom),
        validTo: normalizeOptionalText(req.body.validTo)
      });
      return res.redirect(SETUP_STEP_PATHS.licence_document);
    } catch (error) {
      if (error instanceof SetupValidationError || error instanceof MissingAuthRoleError) {
        const session = await resolveSession(req.headers.cookie).catch(() => ({ authenticated: false } as SessionAccount));
        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }
        return renderWizard(res, session, req.path, [error.message], null, {
          licenceNumber: normalizeText(req.body.licenceNumber),
          licensingAuthorityId: normalizeText(req.body.licensingAuthorityId),
          validFrom: normalizeText(req.body.validFrom),
          validTo: normalizeText(req.body.validTo)
        });
      }
      return next(error);
    }
  });

  const uploadCsrfGuard = requireCsrfToken({ appTitle: options.appTitle });

  function requireSameOriginMultipart(req: any, res: any, next: any) {
    const originHeader = String(req.headers.origin || req.headers.referer || "").trim();
    if (!originHeader) {
      return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
    }
    try {
      const origin = new URL(originHeader);
      const host = String(req.headers.host || "");
      if (!host || origin.host !== host) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }
      return next();
    } catch {
      return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
    }
  }

  router.post(
    "/setup/licence-document",
    setupRateLimit,
    requireSameOriginMultipart,
    setupUpload.single("licenceDocument"),
    uploadCsrfGuard,
    async (req, res, next) => {
      try {
        const session = await resolveSession(req.headers.cookie);
        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }
        if (!(await canAccessSetupAdministration(session))) {
          return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
        }

        if (!req.file) {
          return renderWizard(res, session, SETUP_STEP_PATHS.licence_document, [
            "Upload a licence document."
          ]);
        }

        await saveOperatorLicenceDocument(toActor(session), {
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
          buffer: req.file.buffer
        });

        return res.redirect(SETUP_STEP_PATHS.review_confirmation);
      } catch (error) {
        if (error instanceof SetupValidationError || error instanceof MissingAuthRoleError) {
          const session = await resolveSession(req.headers.cookie).catch(() => ({ authenticated: false } as SessionAccount));
          if (!session.authenticated || !session.user) {
            return res.redirect("/access");
          }
          return renderWizard(res, session, SETUP_STEP_PATHS.licence_document, [error.message]);
        }
        return next(error);
      }
    }
  );

  router.post("/setup/review", setupRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const session = await resolveSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }
      if (!(await canAccessSetupAdministration(session))) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }

      if (normalizeText(req.body.confirmSetup) !== "yes") {
        return renderWizard(res, session, SETUP_STEP_PATHS.review_confirmation, [
          "Confirm setup completion before continuing."
        ]);
      }

      await completeInitialSetup(toActor(session));

      return res.redirect(SETUP_STEP_PATHS.completed);
    } catch (error) {
      if (error instanceof SetupValidationError || error instanceof MissingAuthRoleError) {
        const session = await resolveSession(req.headers.cookie).catch(() => ({ authenticated: false } as SessionAccount));
        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }
        return renderWizard(res, session, SETUP_STEP_PATHS.review_confirmation, [error.message]);
      }
      return next(error);
    }
  });

  router.post("/setup/cleanup-accounts", setupRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const session = await resolveSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }
      if (!(await canAccessSetupAdministration(session))) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }

      const selected: unknown[] = Array.isArray(req.body.cleanupTargets)
        ? req.body.cleanupTargets
        : [req.body.cleanupTargets];
      const targets = selected
        .map((entry) => normalizeText(entry))
        .filter((entry): entry is CleanupTarget =>
          (CLEANUP_TARGETS as readonly string[]).includes(entry)
        );

      await deactivateLegacyOperationalAccounts(toActor(session), targets);
      return renderWizard(
        res,
        session,
        SETUP_STEP_PATHS.completed,
        [],
        "Cleanup request completed. Selected legacy operational accounts were deactivated from internal access roles."
      );
    } catch (error) {
      if (error instanceof SetupValidationError || error instanceof MissingAuthRoleError) {
        const session = await resolveSession(req.headers.cookie).catch(() => ({ authenticated: false } as SessionAccount));
        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }
        return renderWizard(res, session, SETUP_STEP_PATHS.completed, [error.message]);
      }
      return next(error);
    }
  });

  router.post("/setup/test-account-access-code", setupRateLimit, csrfGuard, async (req, res, next) => {
    try {
      const session = await resolveSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return res.redirect("/access");
      }
      if (!(await canAccessSetupAdministration(session))) {
        return res.status(403).render("pages/unavailable", { title: "Unavailable", appTitle: options.appTitle });
      }

      const email = normalizeText(req.body.testAccountEmail).toLowerCase();
      await assertSafeNotificationSinkForTestEmail(email);

      return renderWizard(
        res,
        session,
        SETUP_STEP_PATHS.completed,
        [],
        `Test-account access-code request is allowed for ${email}. Use the standard /access flow in the configured test sink environment.`
      );
    } catch (error) {
      if (error instanceof SetupValidationError || error instanceof MissingAuthRoleError) {
        const session = await resolveSession(req.headers.cookie).catch(() => ({ authenticated: false } as SessionAccount));
        if (!session.authenticated || !session.user) {
          return res.redirect("/access");
        }
        return renderWizard(res, session, SETUP_STEP_PATHS.completed, [error.message]);
      }
      return next(error);
    }
  });

  return router;
}
