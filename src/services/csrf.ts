import crypto from "node:crypto";

/**
 * Synchronizer-style CSRF tokens, signed with HMAC-SHA256 and bound to a
 * per-browser secret that is stored in an httpOnly cookie.
 *
 * Authentication in this application is owned by an external auth service (see
 * `src/services/api.ts`); this web layer has no durable server-side session
 * store it could attach a synchronizer token to. Tokens are therefore bound to
 * a dedicated, httpOnly, SameSite=Lax CSRF cookie that is unique per browser
 * session, plus an optional caller-supplied identity (for example the
 * authenticated user id). A token issued for one browser/session cannot be
 * replayed against another one, because the signature only verifies against
 * that browser's own cookie secret.
 *
 * Known limitation: because the binding is to the CSRF cookie rather than to a
 * server-side session record, tokens are not invalidated when the external auth
 * session ends. Tokens still expire after `DEFAULT_TOKEN_MAX_AGE_MS`.
 */

/** Name of the httpOnly cookie holding the per-browser CSRF secret. */
export const CSRF_COOKIE_NAME = "rm_csrf";

/** Name of the hidden form field carrying the token. */
export const CSRF_FIELD_NAME = "_csrf";

/** Request header accepted as an alternative to the form field. */
export const CSRF_HEADER_NAME = "x-csrf-token";

/** Tokens older than this are rejected and a fresh form must be requested. */
export const DEFAULT_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const TOKEN_VERSION = "v1";

export function createCsrfCookieSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Resolves the signing key. `CSRF_SECRET` should be configured in production so
 * that tokens stay valid across restarts and across multiple instances; when it
 * is absent a process-local random key is generated instead (tokens then become
 * invalid after a restart, which only forces the form to be reloaded).
 */
let ephemeralSigningKey: string | null = null;

export function resolveCsrfSigningKey(): string {
  const configured = String(process.env.CSRF_SECRET || "").trim();

  if (configured) {
    return configured;
  }

  if (!ephemeralSigningKey) {
    ephemeralSigningKey = crypto.randomBytes(32).toString("base64url");
  }

  return ephemeralSigningKey;
}

function sign(signingKey: string, payload: string): string {
  return crypto.createHmac("sha256", signingKey).update(payload).digest("base64url");
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

export type CsrfTokenBinding = {
  /** Per-browser secret taken from the CSRF cookie. */
  cookieSecret: string;
  /** Optional additional binding, e.g. the authenticated user id. */
  identity?: string | null;
};

export type CreateCsrfTokenOptions = CsrfTokenBinding & {
  signingKey?: string;
  issuedAt?: number;
};

/**
 * Creates a token of the form `v1.<issuedAt>.<signature>`. The token never
 * contains the cookie secret itself, so it is safe to render into HTML.
 */
export function createCsrfToken(options: CreateCsrfTokenOptions): string {
  const signingKey = options.signingKey ?? resolveCsrfSigningKey();
  const issuedAt = options.issuedAt ?? Date.now();
  const payload = `${TOKEN_VERSION}|${options.cookieSecret}|${options.identity ?? ""}|${issuedAt}`;

  return `${TOKEN_VERSION}.${issuedAt}.${sign(signingKey, payload)}`;
}

export type VerifyCsrfTokenOptions = CsrfTokenBinding & {
  signingKey?: string;
  maxAgeMs?: number;
  now?: number;
};

export type CsrfVerificationResult =
  | { valid: true }
  | { valid: false; reason: "missing" | "malformed" | "expired" | "invalid" };

/**
 * Verifies a submitted token against the browser's CSRF cookie secret.
 * Never logs or returns the token or the cookie secret.
 */
export function verifyCsrfToken(
  token: unknown,
  options: VerifyCsrfTokenOptions
): CsrfVerificationResult {
  const candidate = typeof token === "string" ? token.trim() : "";

  if (!candidate) {
    return { valid: false, reason: "missing" };
  }

  if (!options.cookieSecret) {
    return { valid: false, reason: "invalid" };
  }

  const parts = candidate.split(".");

  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { valid: false, reason: "malformed" };
  }

  const issuedAt = Number(parts[1]);

  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    return { valid: false, reason: "malformed" };
  }

  const signingKey = options.signingKey ?? resolveCsrfSigningKey();
  const expected = createCsrfToken({
    cookieSecret: options.cookieSecret,
    identity: options.identity,
    signingKey,
    issuedAt
  });

  if (!timingSafeEqual(candidate, expected)) {
    return { valid: false, reason: "invalid" };
  }

  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TOKEN_MAX_AGE_MS;

  if (now - issuedAt > maxAgeMs || issuedAt - now > maxAgeMs) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true };
}

/** Minimal cookie-header parser; the project has no cookie-parser dependency. */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) {
      continue;
    }

    if (part.slice(0, separator).trim() !== name) {
      continue;
    }

    const value = part.slice(separator + 1).trim();

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}
