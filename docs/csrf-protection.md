# CSRF protection

All state-changing HTML form submissions are protected by a signed, per-browser CSRF token.

## Design

Authentication is owned by an external auth service (`API_BASE_URL`, see `src/services/api.ts`);
this web layer has no durable server-side session store it could attach a classic synchronizer
token to. The implementation therefore uses a **signed synchronizer token bound to a dedicated
CSRF cookie**:

1. `createCsrfProtection()` (`src/middleware/csrf.ts`) runs for every request, after
   `express.urlencoded`.
2. If the request has no `rm_csrf` cookie, a fresh 256-bit random secret is generated and set as
   an `HttpOnly`, `SameSite=Lax`, `Path=/` cookie (`Secure` when `NODE_ENV=production`).
3. The token handed to the page is `v1.<issuedAt>.<HMAC-SHA256(signing key, cookie secret |
   identity | issuedAt)>`. The cookie secret itself is never rendered, so a token leaked from a
   page cannot be turned into the cookie value.
4. Every non-`GET`/`HEAD`/`OPTIONS` request must present a matching token in the `_csrf` form
   field (or the `x-csrf-token` header). Verification recomputes the HMAC from *that browser's*
   cookie and compares in constant time, then enforces the 12-hour token lifetime.
5. Missing, malformed, forged, expired, or foreign-session tokens are rejected with the
   application's shared `403` "Unavailable" page. The reason is never echoed back to the client,
   and neither tokens nor cookie secrets are ever logged.

`CSRF_SECRET` should be set in production so tokens survive restarts and work across instances.
When it is unset, a random process-local key is generated; tokens then become invalid after a
restart, which only means an open form has to be reloaded.

### Known limitation

Because the binding is to the CSRF cookie (and optionally a caller-supplied identity) rather than
to a server-side session record, a token is **not** invalidated the moment the external auth
session ends — it expires with the token lifetime or when the browser drops the CSRF cookie.
Cross-browser and cross-session replay is prevented, since a token only verifies against the
cookie it was issued with. Authentication and authorization are unchanged: CSRF validation runs
in addition to, never instead of, the existing session and role checks, and unauthenticated
requests still redirect to `/access`.

## Protected routes

| Route                              | Form                                        |
| ---------------------------------- | ------------------------------------------- |
| `POST /access`                     | Access request (sign-in email)              |
| `POST /exit`                       | Sign out (header)                           |
| `POST /choose-role`                | Workspace switch tiles                      |
| `POST /staff/invite`               | Create / Invite user                        |
| `POST /customers/register`         | New customer registration                   |
| `POST /customers/import`           | Cabcher CSV import (multipart)              |
| `POST /customers/:id/edit`         | Customer edit                               |
| `POST /customers/:id/delete`       | Customer delete                             |
| `POST /customers/:id/suspend`      | Customer suspend/reactivate                 |
| `POST /recovery/backup`            | Recovery step 1 confirmation                |
| `POST /recovery/warning`           | Recovery step 2 confirmation                |
| `POST /recovery/restart`           | Recovery step 3 confirmation                |

Read-only `GET` routes are not protected, as required.

`POST /customers/import` uses a multipart body that the global middleware cannot read, so that
route validates the token with `requireCsrfToken()` immediately after multer has parsed the
upload. Any future multipart route must do the same.

## Rendering the token

The middleware exposes `csrfToken` and a pre-rendered `csrfField` on `res.locals`. Templates
include it inside the `<form>` element:

```ejs
<form method="post" action="/staff/invite">
  <%- locals.csrfField || "" %>
  ...
</form>
```

and, inside the raw-HTML `body` strings used by `layouts/base`:

```ejs
<form method="post" action="/recovery/backup">
  ${locals.csrfField || ""}
  ...
</form>
```

Tokens are only ever placed in hidden form fields — never in URLs, log output, success notices,
or error messages.

## Tests

- `src/services/csrf.test.ts` — token signing, expiry, tampering, cross-session and cross-identity
  rejection, cookie parsing.
- `src/routes/csrf.test.ts` — the rendered form contains a token, a valid token succeeds, missing
  and invalid tokens are rejected with `403`, a token cannot be replayed by another session,
  unauthenticated requests still redirect to `/access`, authorization is still enforced, and an
  existing protected form keeps working with a valid token.
