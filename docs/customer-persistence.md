# Customer persistence

Customer data is stored in an embedded SQLite database (`better-sqlite3`). SQLite was
chosen because the web layer is a small self-hosted Express/TypeScript application with
no existing database driver, connection string or hosted service, so no additional
infrastructure has to be provisioned or operated.

## Configuration

| Variable        | Default                  | Description                                                                                            |
| --------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_FILE` | `data/ridematrix.sqlite` | SQLite database file. Relative paths resolve from the project root. Use `:memory:` for throwaway runs.   |

The directory is created automatically on startup. `src/index.ts` opens the database
eagerly, so an invalid configuration fails immediately with a descriptive error instead
of failing on the first customer request.

Deployments must keep the directory holding `DATABASE_FILE` on persistent storage (for
example a mounted volume). The database file and its `-wal`/`-shm` companions are ignored
by git.

## Schema and migrations

Migrations live in `src/database/migrations.ts` and are applied by a small runner that
records applied migration ids in `schema_migrations`. They are written as TypeScript
modules so that `tsc` ships them to `dist/` without an extra copy step.

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

The legacy `.sql` files under `src/database/migrations/` were written in PostgreSQL syntax
(`ADD COLUMN IF NOT EXISTS`), were never executed by the application and have been
replaced by the migrations above.

## Seed data

The original 18 demo customers (and their bookings) are inserted once on a fresh database.
A marker row in `bootstrap_state` makes the seed idempotent: restarts never duplicate
records and never resurrect customers that an administrator has deleted.

They are **not** real customers — every seeded row is written with `source = 'seed'`
(see `src/database/seed.ts`). No other code path is allowed to write that value:
manual registrations use `source = 'manual'`, Cabcher imports use `source = 'import'`,
and booking-driven auto-creation (`src/services/customer-auto-creation.ts`) uses
`source = 'booking'`. This makes the demo records unambiguously identifiable by origin
rather than by id, name or email, and future real records can never accidentally receive
the demo marker because it is only ever written by `seedCustomers`.

### Disabling demo seeding

| Variable            | Default                                   | Description                                                                 |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `SEED_DEMO_DATA`      | enabled, except disabled when `NODE_ENV=production` | Set to `false` to skip inserting demo customers on a fresh database. Set to `true` to force seeding even when `NODE_ENV=production` (e.g. a staging environment). |

Demo seeding never runs as part of normal request handling, only once on the first
database open per process, and startup never deletes customer records — schema
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
  statement. Non-demo customers and bookings are never touched.
- **Atomic.** Related demo bookings are archived into `archived_bookings`
  (`reason = 'demo_seed_cleanup'`) and removed, then the demo customer rows are deleted,
  all inside a single `better-sqlite3` transaction. If any step fails, nothing is
  committed.
- **Idempotent.** Once no demo records remain, subsequent confirmed runs are a safe
  no-op (`alreadyClean: true`) and never require an override.
- **Best-effort backup.** Before a confirmed run with demo customers present, the CLI
  copies the SQLite database file to `<file>.pre-demo-cleanup-<timestamp>.bak`. This is a
  practical safeguard for the embedded SQLite file, not a verified/tested restore — an
  operator must copy that file to durable/offsite storage and confirm it opens correctly
  before relying on it. Skipped automatically for `:memory:` databases.

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

1. Configure persistent storage for `DATABASE_FILE` (a mounted volume that survives
   restarts and deployments), and set `NODE_ENV=production`.
2. Deploy the application so that `initializeDatabase()` runs the pending schema
   migrations. This step never seeds or deletes customer data by itself.
3. Confirm `SEED_DEMO_DATA` is not set to `true` (the production default already skips
   seeding).
4. Take a database backup — snapshot the volume/host, or copy the SQLite file — and
   verify it can be restored (opened) before proceeding.
5. Run the dry-run cleanup (`npm run cleanup:demo`) and inspect the exact candidate list:
   it must show 18 records matching `EXPECTED_DEMO_CUSTOMER_IDS`, and the non-demo
   customer count for a fresh production database.
6. Run the confirmed cleanup with the required safety flags
   (`ALLOW_DEMO_CLEANUP=true npm run cleanup:demo -- --confirm`).
7. Restart the application and confirm the demo records remain absent
   (`npm run cleanup:demo` should now report `demoCustomerCount: 0`).
8. Only after cleanup succeeds, import real customers/bookings (Cabcher import or manual
   registration).
9. Keep `SEED_DEMO_DATA` disabled and `ALLOW_DEMO_CLEANUP` unset/`false` in production
   after rollout, so neither seeding nor cleanup can run unintentionally.

## Delete and suspend semantics

- **Suspend** toggles `status` between `Suspended` and `Active` and is persisted.
- **Delete** is a soft delete: `deleted_at` is set, the profile disappears from the list,
  detail and search, but booking history is retained for legal and compliance purposes.

## Import durability and deduplication

Import batches, imported bookings and derived customer aggregates are stored in the
database and survive a restart. Each imported booking carries a unique `dedupe_key`
(email, service date/time, pickup, dropoff, source reference), so re-uploading the same
export rejects the duplicate rows instead of creating new bookings. Derived customers are
matched by normalized email: an existing customer record with the same email is reused
rather than duplicated, and manually curated records are only enriched (missing phone,
last booking date) and never overwritten.

## Tests

```bash
npm run typecheck
npm run build
npm test
```

`npm test` type-checks the test files and runs the `node:test` suites in
`src/services/*.test.ts` and `src/database/*.test.ts` against temporary SQLite files,
including restart-like scenarios, the demo cleanup dry-run/confirm/rollback/idempotency
behaviour (`src/services/demo-cleanup.test.ts`,
`src/services/demo-cleanup-execute.test.ts`) and `SEED_DEMO_DATA` gating
(`src/database/seed-config.test.ts`).
