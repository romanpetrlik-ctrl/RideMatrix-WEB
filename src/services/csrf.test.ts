import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  CSRF_COOKIE_NAME,
  createCsrfCookieSecret,
  createCsrfToken,
  readCookie,
  verifyCsrfToken
} from "./csrf";

describe("CSRF token service", () => {
  const signingKey = "test-signing-key";

  test("a freshly issued token verifies against its own cookie secret", () => {
    const cookieSecret = createCsrfCookieSecret();
    const token = createCsrfToken({ cookieSecret, signingKey });

    assert.deepEqual(verifyCsrfToken(token, { cookieSecret, signingKey }), { valid: true });
  });

  test("the token never contains the cookie secret itself", () => {
    const cookieSecret = createCsrfCookieSecret();
    const token = createCsrfToken({ cookieSecret, signingKey });

    assert.ok(!token.includes(cookieSecret));
  });

  test("a missing token is reported as missing", () => {
    const cookieSecret = createCsrfCookieSecret();

    assert.deepEqual(verifyCsrfToken(undefined, { cookieSecret, signingKey }), {
      valid: false,
      reason: "missing"
    });
    assert.deepEqual(verifyCsrfToken("   ", { cookieSecret, signingKey }), {
      valid: false,
      reason: "missing"
    });
  });

  test("a malformed token is rejected", () => {
    const cookieSecret = createCsrfCookieSecret();

    assert.deepEqual(verifyCsrfToken("not-a-token", { cookieSecret, signingKey }), {
      valid: false,
      reason: "malformed"
    });
  });

  test("a tampered signature is rejected", () => {
    const cookieSecret = createCsrfCookieSecret();
    const token = createCsrfToken({ cookieSecret, signingKey });
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    assert.deepEqual(verifyCsrfToken(tampered, { cookieSecret, signingKey }), {
      valid: false,
      reason: "invalid"
    });
  });

  test("a token issued for another browser session is rejected", () => {
    const tokenOfSessionA = createCsrfToken({ cookieSecret: createCsrfCookieSecret(), signingKey });

    assert.deepEqual(
      verifyCsrfToken(tokenOfSessionA, { cookieSecret: createCsrfCookieSecret(), signingKey }),
      { valid: false, reason: "invalid" }
    );
  });

  test("a token bound to another user identity is rejected", () => {
    const cookieSecret = createCsrfCookieSecret();
    const token = createCsrfToken({ cookieSecret, identity: "user-a", signingKey });

    assert.deepEqual(verifyCsrfToken(token, { cookieSecret, identity: "user-b", signingKey }), {
      valid: false,
      reason: "invalid"
    });
  });

  test("a token signed with a different signing key is rejected", () => {
    const cookieSecret = createCsrfCookieSecret();
    const token = createCsrfToken({ cookieSecret, signingKey: "other-key" });

    assert.deepEqual(verifyCsrfToken(token, { cookieSecret, signingKey }), {
      valid: false,
      reason: "invalid"
    });
  });

  test("an expired token is rejected", () => {
    const cookieSecret = createCsrfCookieSecret();
    const issuedAt = Date.now() - 60_000;
    const token = createCsrfToken({ cookieSecret, signingKey, issuedAt });

    assert.deepEqual(verifyCsrfToken(token, { cookieSecret, signingKey, maxAgeMs: 1_000 }), {
      valid: false,
      reason: "expired"
    });
  });

  test("verification fails closed when no cookie secret is present", () => {
    const token = createCsrfToken({ cookieSecret: createCsrfCookieSecret(), signingKey });

    assert.deepEqual(verifyCsrfToken(token, { cookieSecret: "", signingKey }), {
      valid: false,
      reason: "invalid"
    });
  });

  test("cookie values are read from the raw cookie header", () => {
    assert.equal(readCookie(`other=1; ${CSRF_COOKIE_NAME}=abc; last=2`, CSRF_COOKIE_NAME), "abc");
    assert.equal(readCookie("other=1", CSRF_COOKIE_NAME), null);
    assert.equal(readCookie(undefined, CSRF_COOKIE_NAME), null);
  });
});
