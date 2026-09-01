# Database readiness audit (read-only)

`npm run audit:db` inspects the schema of whatever database `DATABASE_URL` points at and reports
whether it is ready for

- the internal auth / `/staff/invite` onboarding flow, and
- the Cabcher customer import.

The audit is **strictly read-only**:

- every statement it issues must match `SELECT`/`WITH` and is rejected if it contains any of
  `insert`, `update`, `delete`, `alter`, `create`, `drop`, `truncate`, `grant`, `revoke`, `copy`,
  `merge`, `vacuum`, `refresh` (`assertReadOnlyStatement` in `src/services/db-readiness-audit.ts`),
- all queries run inside a `BEGIN READ ONLY` transaction that is always rolled back,
- it runs no migrations, no seeds, and no import,
- **it does not create `roman.petrlik@hotmail.com`**, **does not modify
  `bookings@romanairporttransfers.co.uk`**, and **does not import customers**.

It also never prints passwords, login codes, tokens, full connection strings, or unrelated
customer data. The connection target is reduced to `host/database`, and the two accounts the
audit must look for are reported with masked addresses (`bo***s@romanairporttransfers.co.uk`).

## Running it

```bash
# Human-readable report
DATABASE_URL='<production connection string>' npm run audit:db

# Machine-readable JSON (for tickets, CI artefacts, or diffing)
DATABASE_URL='<production connection string>' npm run audit:db -- --json
```

Run it from an environment that can reach the production database (for example on the VPS, next
to the application). A read-only database role is sufficient and recommended.

Exit codes:

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| `0`  | No blocker found (`READY` or `NEEDS_REVIEW`)                     |
| `2`  | At least one section is `BLOCKED`                                |
| `3`  | At least one section is `NOT_VERIFIED` (no reachable database)   |
| `1`  | The audit itself failed unexpectedly                             |

## Interpreting the report

Each of the three sections — **auth schema**, **customer schema**, **customer import** — carries
one status:

| Status         | Meaning                                                                                 |
| -------------- | --------------------------------------------------------------------------------------- |
| `READY`        | Every check passed on the database that was actually inspected.                          |
| `NEEDS_REVIEW` | No blocker, but at least one warning needs a human decision before proceeding.           |
| `BLOCKED`      | A required table, column, constraint, or data condition is missing or conflicting.       |
| `NOT_VERIFIED` | Nothing was inspected: `DATABASE_URL` was absent or the database could not be reached.   |

Individual checks are `PASS`, `WARN`, `FAIL`, or `UNKNOWN`.

> **`NOT_VERIFIED` is never an implicit pass.** If production credentials are not available, the
> report says so explicitly. Readiness of a local or test database says nothing about production;
> do not report production as verified unless the report shows the production target as
> `inspected`.

### What is checked

Auth schema (`auth_schema`):

- `users`, `roles`, `permissions`, `user_roles`, `role_permissions`, `login_codes` exist,
- the columns the application queries exist on each of them,
- `users.email` is unique and `users.status` can carry the `Pending` invite state,
- the `superuser` role and the other internal roles exist,
- the `manage_users` / `manage_user_roles` permissions exist and are granted to at least one role,
- whether a row already uses `roman.petrlik@hotmail.com` (existence only — no other column is read),
- whether `bookings@romanairporttransfers.co.uk` exists and which role **names** are assigned to it
  (no status, no login codes, no other columns),
- whether the schema can support `POST /staff/invite`.

Customer schema (`customer_schema`):

- `customers`, `customer_bookings`, `import_batches`, `imported_bookings`, `imported_customers`
  exist with the columns the application reads and writes,
- required columns are `NOT NULL` and the expected defaults exist,
- `customers` has a primary key and the `deleted_at` soft-delete column,
- `customer_bookings.customer_id` has a foreign key to `customers`,
- which migrations from `src/database/migrations.ts` have been applied.

Customer import (`customer_import`):

- the partial unique index on `customers(email_normalized) WHERE deleted_at IS NULL` exists,
- `customers.email_normalized` — the importer's de-duplication key — exists,
- there are no duplicate active `email_normalized` values (which would block the import),
- stored e-mails are normalized consistently (`lower(btrim(email))`),
- `imported_bookings.dedupe_key` and `imported_customers.email` are unique, and
  `imported_bookings.import_batch_id` has a foreign key,
- how many active customers exist per `source` (a remaining `seed` population is a warning — see
  `npm run cleanup:demo`) and how many import batches are already on file.

## Suggested production sequence

1. Run `npm run audit:db -- --json` against production and store the report.
2. Resolve every `BLOCKED` item; review every `NEEDS_REVIEW` item.
3. Take and verify a database backup (`pg_dump`/snapshot).
4. Only then create `roman.petrlik@hotmail.com` through `/staff/invite`, and only then run the
   customer import. Neither is performed by this audit.
5. Re-run the audit afterwards to confirm the resulting state.

## Tests

`src/services/db-readiness-audit.test.ts` covers:

- the read-only guard rejects every mutating statement and never reaches the driver,
- connection targets are reported without credentials,
- a missing `DATABASE_URL` and an unreachable database both produce `NOT_VERIFIED`,
- missing tables/columns are reported as blockers instead of throwing (mock runner),
- a migrated test database is inspected end to end, and the user/customer row counts are unchanged
  afterwards,
- the rendered report contains no connection string and no unmasked audited address.
