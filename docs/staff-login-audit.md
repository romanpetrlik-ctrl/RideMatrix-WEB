# Staff login audit events

The web layer records internal-user authentication outcomes in `staff_login_audit`.
It uses the stable event names `staff_login_succeeded` and `staff_login_failed`.

Each event stores `occurred_at`, `account_id` when available, the normalized
`login_identifier` when submitted or known, `success`, and request
`ip_address` and `user_agent` when available. Failed events additionally store
one category: `invalid_credentials`, `disabled_account`, `unauthorized`,
`blocked`, or `system_failure`. Passwords, hashes, cookies, tokens, and CSRF
values are never persisted.

## Which sign-ins are recorded

Events are written by the web layer only:

- `GET /auth/callback` (`src/routes/auth-callback.ts`) records
  `staff_login_succeeded` for an authenticated session with at least one role,
  and `staff_login_failed` (`unauthorized`) for a missing session or a session
  without roles.
- `GET /access` records `staff_login_failed` when the external session lookup
  itself fails.

The sign-in link e-mailed by `POST /access` is generated and verified by the
external auth API (`API_BASE_URL`), so whether a successful sign-in reaches
`/auth/callback` depends on that API's post-verification redirect. Sessions
that land directly on `/entry`, `/access`, or a workspace page are **not**
recorded. To check whether successful events are being stored, run:

```sql
SELECT occurred_at, event_name, account_id, success
FROM staff_login_audit
ORDER BY occurred_at DESC
LIMIT 20;
```

Historical sign-ins that never reached `/auth/callback` are not backfilled.

## Staff directory and login history

The staff directory (`GET /staff`) shows **Last login** as the most recent of:

1. the latest `staff_login_succeeded` event in `staff_login_audit` for the
   account — matched by `account_id`, or, only for events stored without an
   account id, by case-insensitive trimmed email (`login_identifier`); and
2. an optional last-login column on the externally owned `users` table
   (`last_login_at`, `last_login`, `last_sign_in_at`, or `last_signed_in_at`)
   when one exists.

Failed events never count as a login. Rows with malformed timestamps are
ignored. `Never` is shown only when neither source has a value. The external
`users` table is only read, never altered.

Each email address in the directory links to `GET /staff/:accountId/audit`,
which lists up to 200 of that account's newest events (UTC timestamp, outcome,
event name, failure category, IP address, user agent). The page uses the same
authorization as `/staff` (`canManageStaff`: `admin`/`superuser` or the
`manage_users` permission), redirects unauthenticated users to `/access`,
returns 403 to unauthorized users, and returns 404 for malformed ids, unknown
users, and accounts without an internal staff role. Only the selected
account's events are queried, and all values are HTML-escaped.
