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
`src/services/*.test.ts` against temporary SQLite files, including restart-like scenarios.
