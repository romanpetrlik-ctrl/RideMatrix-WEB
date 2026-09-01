import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  CSRF_COOKIE_NAME,
  CSRF_FIELD_NAME,
  CSRF_HEADER_NAME,
  CsrfVerificationResult,
  DEFAULT_TOKEN_MAX_AGE_MS,
  createCsrfCookieSecret,
  createCsrfToken,
  readCookie,
  verifyCsrfToken
} from "../services/csrf";

export type RequestCsrfContext = {
  /** Token rendered into forms for this request. */
  token: string;
  /** True when validation was deferred because the body is multipart. */
  deferred: boolean;
  verify: (candidate: unknown) => CsrfVerificationResult;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      csrf?: RequestCsrfContext;
    }
  }
}

export type CsrfProtectionOptions = {
  appTitle?: string;
  /** Defaults to true when NODE_ENV=production so the cookie is HTTPS-only. */
  cookieSecure?: boolean;
  maxAgeMs?: number;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pre-rendered hidden input, usable from EJS templates and raw HTML bodies. */
export function renderCsrfField(token: string): string {
  return `<input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtmlAttribute(token)}" />`;
}

function isMultipart(req: Request): boolean {
  return String(req.headers["content-type"] || "")
    .toLowerCase()
    .includes("multipart/form-data");
}

function extractSubmittedToken(req: Request): unknown {
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body ? body[CSRF_FIELD_NAME] : undefined;

  if (typeof fromBody === "string") {
    return fromBody;
  }

  return req.headers[CSRF_HEADER_NAME];
}

/**
 * Rejects the request with the application's standard 403 "unavailable" page.
 * The failure reason is intentionally not echoed back to the client and the
 * submitted token is never logged.
 */
function rejectRequest(res: Response, appTitle: string): void {
  res.status(403).render("pages/unavailable", {
    title: "Unavailable",
    appTitle
  });
}

/**
 * Validates the CSRF token attached to an already-parsed request body. Used
 * directly as route middleware after a body parser that the global middleware
 * cannot see through (for example multer for multipart uploads).
 */
export function requireCsrfToken(options: CsrfProtectionOptions = {}): RequestHandler {
  const appTitle = options.appTitle || process.env.APP_TITLE || "RideMatrix";

  return (req: Request, res: Response, next: NextFunction) => {
    const context = req.csrf;

    if (!context) {
      // Fail closed: without the CSRF middleware there is no cookie secret to
      // verify against, so the state-changing request cannot be trusted.
      return rejectRequest(res, appTitle);
    }

    const result = context.verify(extractSubmittedToken(req));

    if (!result.valid) {
      return rejectRequest(res, appTitle);
    }

    context.deferred = false;
    return next();
  };
}

/**
 * Issues a CSRF token for every request (exposed to views as `csrfToken`) and
 * validates it on state-changing requests.
 *
 * Validation is deferred for multipart bodies, which are parsed later by the
 * route's upload middleware; those routes must apply `requireCsrfToken()`
 * immediately after their upload middleware.
 */
export function createCsrfProtection(options: CsrfProtectionOptions = {}): RequestHandler {
  const appTitle = options.appTitle || process.env.APP_TITLE || "RideMatrix";
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TOKEN_MAX_AGE_MS;
  const secure = options.cookieSecure ?? process.env.NODE_ENV === "production";
  const validate = requireCsrfToken({ appTitle });

  return (req: Request, res: Response, next: NextFunction) => {
    let cookieSecret = readCookie(req.headers.cookie, CSRF_COOKIE_NAME);

    if (!cookieSecret) {
      cookieSecret = createCsrfCookieSecret();
      res.cookie(CSRF_COOKIE_NAME, cookieSecret, {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
        maxAge: maxAgeMs
      });
    }

    const boundSecret = cookieSecret;
    const token = createCsrfToken({ cookieSecret: boundSecret });

    req.csrf = {
      token,
      deferred: false,
      verify: (candidate: unknown) =>
        verifyCsrfToken(candidate, { cookieSecret: boundSecret, maxAgeMs })
    };

    // Rendered by the shared CSRF form-field partial. Never placed in URLs.
    res.locals.csrfToken = token;
    res.locals.csrfField = renderCsrfField(token);

    if (SAFE_METHODS.has(req.method)) {
      return next();
    }

    if (isMultipart(req)) {
      req.csrf.deferred = true;
      return next();
    }

    return validate(req, res, next);
  };
}
