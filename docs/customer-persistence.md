# Customer persistence

Customer data is stored in the existing production PostgreSQL database (`ridematrix`)
alongside the existing authentication tables (`users`, `roles`, `permissions`, `user_roles`,
`role_permissions`, `login_codes`).

## Configuration

| Variable       | Default | Description                                                                                          |
| -------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | none    | PostgreSQL connection string (e.g. `******postgres:5432/ridematrix`). Required.     |

`src/index.ts` initializes the database eagerly on startup, executing pending customer
migrations without disturbing the existing auth schema. If `DATABASE_URL` is missing or
the database cannot be reached, the application fails immediately on startup with a
clear, descriptive error instead of failing silently or falling back to SQLite.

## Schema and migrations

Migrations live in `src/database/migrations.ts` and are applied by an automated runner that
records applied migration ids in `schema_migrations`.

Tables:

- `customers` — master customer records: identity (`title`, `given_name`, `surname`),
  contact details (`email`, `email_normalized`, `phone`, `preferred_contact`), legacy
  `company` and `address` columns, structured address columns (`house_name_number`,
  `address_line1..3`, `city_town`, `county`, `state`, `postcode`), `notes`, `status`,
  `source`, `created_at`, `updated_at`, `last_login_at`, `last_booking_at`, `deleted_at`.
- `customer_bookings` — bookings that belong to a customer record.
- `import_batches`, `imported_bookings`, `imported_customers` — Cabcher import state.
- `archived_bookings` — retention snapshots for compliance.
- `id_sequences`, `bootstrap_state`, `schema_migrations` — internal bookkeeping.

Existing PostgreSQL auth tables (`users`, `roles`, `permissions`, `user_roles`,
`role_permissions`, `login_codes`) are fully preserved and never altered, renamed,
dropped, or truncated by customer migrations or cleanup routines.

## Seed data

The original 18 demo customers (and their bookings) are inserted once on a fresh database
if demo seeding is enabled. A marker row in `bootstrap_state` makes the seed idempotent:
restarts never duplicate records and never resurrect customers that an administrator has deleted.

They are **not** real customers — every seeded row is written with `source = 'seed'`
(see `src/database/seed.ts`). No other code path is allowed to write that value:
manual registrations use `source = 'manual'`, Cabcher imports use `source = 'import'`,
and booking-driven auto-creation (`src/services/customer-auto-creation.ts`) uses
`source = 'booking'`. This makes the demo records unambiguously identifiable by origin
rather than by id, name or email, and future real records can never accidentally receive
the demo marker because it is only ever written by `seedCustomers`.

### Disabling demo seeding

| Variable          | Default                                            | Description                                                                                                                           |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `SEED_DEMO_DATA`  | enabled, except disabled when `NODE_ENV=production` | Set to `false` in production to skip inserting demo customers on a fresh database. Set to `true` to force demo seeding if desired. |

Demo seeding never runs as part of normal request handling, only once on the first
database open per process, and startup never deletes customer data — schema
migrations and the (optional) demo seed are the only things that run automatically.

## Removing demo data before a production import

Before importing real customers, the 18 demo records (and any demo-only bookings) must
be removed. This is an explicit, auditable, one-time maintenance operation — it is never
triggered automatically by application startup or by any HTTP request.

### Tooling

- `src/services/demo-cleanup.ts` — the underlying service. `getDemoCleanupReport()` is a
  read-only report; `runDemoCleanup(options)` performs (or dry-runs) the cleanup.
- `src/jobs/demo-cleanup.ts` — the CLI entry point, run with `npm run cleanup:demo`.

### Safety controls

- **Dry run by default.** Without `--confirm` the script only prints the candidate list
  and counts; it never modifies data.
- **Explicit confirmation.** A destructive run requires both `--confirm` on the command
  line *and* `ALLOW_DEMO_CLEANUP=true` in the environment. Either one alone is refused.
- **Identity/count verification.** The candidate set must be exactly the 18 expected seed
  ids (`EXPECTED_DEMO_CUSTOMER_IDS`, derived from `SEED_CUSTOMERS`). If the count or
  identity differs — for example a record was manually altered, or an unrelated row was
  ever marked `source = 'seed'` — the script refuses and requires `--allow-override` after
  a manual review of the printed candidate list.
- **Origin-scoped deletion.** Only rows with `source = 'seed'` are ever deleted, both when
  selecting candidates and in the final `DELETE ... WHERE ... AND source = 'seed'`
  statement. Non-demo customers, non-demo bookings, and auth tables are never touched.
- **Atomic.** Related demo bookings are archived into `archived_bookings`
  (`reason = 'demo_seed_cleanup'`) and removed, then the demo customer rows are deleted,
  all inside a single PostgreSQL transaction (`withTransaction`). If any step fails,
  nothing is committed.
- **Idempotent.** Once no demo records remain, subsequent confirmed runs are a safe
  no-op (`alreadyClean: true`) and never require an override.
- **PostgreSQL backup prerequisite.** Before running cleanup on a production PostgreSQL
  instance, the operator must take and verify a database backup (e.g., using `pg_dump` or
  a volume/storage snapshot) rather than relying on a local file copy.

### Commands

```bash
# 1. Dry run — inspect the exact candidate list, counts, and identity check.
npm run cleanup:demo

# 2. Confirmed cleanup (requires ALLOW_DEMO_CLEANUP=true in the environment).
ALLOW_DEMO_CLEANUP=true npm run cleanup:demo -- --confirm

# 3. Only if the dry run reports a mismatch that has been manually reviewed and
#    is expected:
ALLOW_DEMO_CLEANUP=true npm run cleanup:demo -- --confirm --allow-override
```

## Production rollout runbook

1. Ensure `DATABASE_URL` is set to the production PostgreSQL instance (`ridematrix`)
   and `NODE_ENV=production`.
2. Deploy the application so that `initializeDatabase()` applies pending customer migrations
   against PostgreSQL. Existing auth tables remain untouched.
3. Confirm `SEED_DEMO_DATA=false` is set (the production default automatically skips seeding).
4. Take a PostgreSQL database backup (e.g. `pg_dump` or managed database snapshot) and verify
   it can be restored before proceeding.
5. Run the dry-run cleanup (`npm run cleanup:demo`) and inspect the exact candidate list:
   it must show 18 records matching `EXPECTED_DEMO_CUSTOMER_IDS`.
6. Run the confirmed cleanup with the required safety flags
   (`ALLOW_DEMO_CLEANUP=true npm run cleanup:demo -- --confirm`).
7. Restart the application and confirm the demo records remain absent
   (`npm run cleanup:demo` should now report `demoCustomerCount: 0`).
8. Only after cleanup succeeds, import real customers/bookings (Cabcher import or manual
   registration).
9. Keep `SEED_DEMO_DATA` disabled and `ALLOW_DEMO_CLEANUP` unset/`false` in production
   after rollout, so neither seeding nor cleanup can run unintentionally.

## Delete and suspend semantics

- **Suspend** toggles `status` between `Suspended` and `Active` and is persisted in PostgreSQL.
- **Delete** is a soft delete: `deleted_at` is set, the profile disappears from the list,
  detail and search, but booking history is retained for legal and compliance purposes.

## Import durability and deduplication

Import batches, imported bookings and derived customer aggregates are stored in PostgreSQL
and survive restarts. Each imported booking carries a unique `dedupe_key`
(email, service date/time, pickup, dropoff, source reference), so re-uploading the same
export rejects duplicate rows instead of creating new bookings. Derived customers are
matched by normalized email: an existing customer record with the same email is reused
rather than duplicated, and manually curated records are only enriched (missing phone,
last booking date) and never overwritten.

## Tests

```bash
npm run typecheck
npm run build
npm test
```

`npm test` type-checks test files and executes `node:test` suites across `src/**/*.test.ts`.
