# RideMatrix-WEB — Development Handover & Roadmap (as of 2026-09-18)

## 1) Project overview

RideMatrix-WEB is the server-rendered web application layer for RideMatrix operations.

- **Implemented:** Express + EJS web UI, customer/staff/vehicle pages, and server-side request handling in [`src/index.ts`](./src/index.ts) and [`src/views`](./src/views).
- **Implemented:** PostgreSQL-backed persistence for customer domain data and related operational tables via migrations in [`src/database/migrations.ts`](./src/database/migrations.ts).
- **Relationship to RideMatrix-API:** WEB calls API auth/session endpoints through `API_BASE_URL` (see [`src/services/api.ts`](./src/services/api.ts)).
- **Relationship to RideMatrix-VPS:** VPS owns runtime/infrastructure concerns (container runtime, deployment wiring, environment injection). This repository contains application code, not VPS provisioning.

## 2) Current production/runtime context

- **Implemented:** Runtime configuration is environment-driven (see [`.env.example`](./.env.example)).
- **Implemented:** Key variables include:
  - `API_BASE_URL` (external auth/session API endpoint)
  - `DATABASE_URL` (PostgreSQL connection string)
  - `GOOGLE_MAPS_ENABLED`, `GOOGLE_MAPS_SERVER_API_KEY`, `GOOGLE_MAPS_BROWSER_API_KEY`, `GOOGLE_MAPS_MAP_ID`
- **Implemented:** Database migrations run during app startup before `listen()` (fail-fast) in [`src/index.ts`](./src/index.ts) and [`src/database/connection.ts`](./src/database/connection.ts).
- **Implemented:** Explicit migration job exists via [`npm run db:migrate`](./package.json) and [`src/jobs/db-migrate.ts`](./src/jobs/db-migrate.ts).
- **Implemented:** Google Maps server/browser key separation is documented and enforced in code paths (see [`docs/maps.md`](./docs/maps.md), [`src/services/maps.ts`](./src/services/maps.ts), [`public/js/google-map-preview.js`](./public/js/google-map-preview.js)).
- **Known boundary:** WEB repository does **not** define VPS container orchestration files; Docker/runtime topology is managed in RideMatrix-VPS.

> Security note: never place real API keys, passwords, or production connection strings in repository docs or source.

## 3) Development history / completed work

### UI shell + responsive layout

- **Implemented:** Full-width shell pattern and consistent page container geometry (`rm-page-shell`) across header/status/main/footer.
  - [`public/css/app.css`](./public/css/app.css)
  - [`src/views/partials/header.ejs`](./src/views/partials/header.ejs)
  - [`src/views/partials/system-status-bar.ejs`](./src/views/partials/system-status-bar.ejs)
  - [`src/views/layouts/base.ejs`](./src/views/layouts/base.ejs)
- **Implemented:** Responsive/overflow regression coverage.
  - [`src/views/layout-geometry.browser.test.ts`](./src/views/layout-geometry.browser.test.ts)
  - [`src/views/context-actions.test.ts`](./src/views/context-actions.test.ts)
  - [`src/views/customers-pagination.browser.test.ts`](./src/views/customers-pagination.browser.test.ts)

### Customers: register/edit/list/detail/pagination + structured address

- **Implemented:** Customer list/detail/register/edit routes and templates.
  - [`src/routes/customers.ts`](./src/routes/customers.ts)
  - [`src/views/pages/customers/index.ejs`](./src/views/pages/customers/index.ejs)
  - [`src/views/pages/customers/detail.ejs`](./src/views/pages/customers/detail.ejs)
  - [`src/views/pages/customers/register.ejs`](./src/views/pages/customers/register.ejs)
  - [`src/views/pages/customers/edit.ejs`](./src/views/pages/customers/edit.ejs)
- **Implemented:** Pagination UI and route-state propagation.
  - [`src/views/partials/customers-pagination.ejs`](./src/views/partials/customers-pagination.ejs)
  - [`src/routes/customers.ts`](./src/routes/customers.ts)
- **Implemented:** Structured address fields + fallback address composition.
  - [`src/services/customer-addresses.ts`](./src/services/customer-addresses.ts)

### Google Places autocomplete migration (new component)

- **Implemented:** Browser autocomplete uses `PlaceAutocompleteElement` + `gmp-select`, not legacy `google.maps.places.Autocomplete`.
  - [`public/js/customer-address-autocomplete.js`](./public/js/customer-address-autocomplete.js)
  - [`src/services/customer-address-autocomplete.test.ts`](./src/services/customer-address-autocomplete.test.ts)
- **Implemented:** Existing server form contracts are preserved (hidden `address`, `latitude`, `longitude`, structured fields).
- **Implemented:** Manual entry fallback is preserved when suggestions fail or return insufficient structure.

### Google Maps key separation + runtime wiring

- **Implemented:** Browser key is exposed to client forms/map preview; server key remains server-side geocoding adapter input.
  - [`src/services/maps.ts`](./src/services/maps.ts)
  - [`src/services/google-maps.ts`](./src/services/google-maps.ts)
  - [`docs/maps.md`](./docs/maps.md)

### Persistence, migrations, import/readiness, authorization, CSRF, safety

- **Implemented:** PostgreSQL persistence and migration framework (including advisory lock).
  - [`src/database/migrations.ts`](./src/database/migrations.ts)
  - [`src/database/connection.ts`](./src/database/connection.ts)
  - [`docs/customer-persistence.md`](./docs/customer-persistence.md)
- **Implemented:** Cabcher import + readiness audit tooling.
  - [`src/routes/customers.ts`](./src/routes/customers.ts)
  - [`src/jobs/db-audit.ts`](./src/jobs/db-audit.ts)
  - [`docs/database-readiness-audit.md`](./docs/database-readiness-audit.md)
- **Implemented:** Session-based authorization checks for protected routes.
  - [`src/services/api.ts`](./src/services/api.ts)
  - [`src/routes/customers.ts`](./src/routes/customers.ts)
- **Implemented:** CSRF protection middleware and multipart-safe validation path.
  - [`src/middleware/csrf.ts`](./src/middleware/csrf.ts)
  - [`docs/csrf-protection.md`](./docs/csrf-protection.md)

### Existing test/typecheck/build expectations

- **Implemented:** Unit tests, integration tests, typecheck, and build scripts are defined in [`package.json`](./package.json).
- **Implemented:** Test split and safety expectations are documented in [`docs/test-configuration.md`](./docs/test-configuration.md).

## 4) Current known state and limitations

- **Implemented:** Google Places autocomplete is technically working with the new component flow.
- **Known limitation:** Autocomplete localization/region behavior is intentionally **not finalized**.
- **Not yet implemented:** Complete Initial System Setup flow for operator/license holder.
- **Not yet implemented:** Confirmed persisted source of truth for:
  - operator primary profile,
  - PHO licence details,
  - registered PHO address,
  - operational address,
  - setup completion state.
- **Known behavior:** `House number / name` may be legitimately empty when Google does not provide it; future UX should support explicit confirmation to continue without it, rather than fabricating values.
- **Known diagnostic note:** An unrelated `favicon` 404 must not be treated as a Google Maps root cause.
- **Not yet implemented:** Operator setup database model/UI should not be assumed to exist.

## 5) Why Google Maps localization is paused

- **Decision context:** Hardcoding `gb`, a specific city, fixed coordinates, or fixed radius is not correct for a product installable in multiple countries (for example UK now, Germany later).
- **Planned source of truth:** Persisted operator installation profile, preferably the **operational** address; registered PHO address as explicit fallback only if product decisions confirm that behavior.

**Planned conceptual configuration (not implemented yet):**

1. Derive country code from operator operational address.
2. Apply country-level restriction via `includedRegionCodes`.
3. Apply `locationBias` from operator operational coordinates.
4. Keep deployment flexibility across UK, Germany, and future countries.
5. Do **not** use admin browser/IP geolocation as primary source.

## 6) Planned Initial System Setup roadmap

> This section is a **plan**, not implemented functionality.

- **Planned:** Setup viewport/flow in the existing RideMatrix-WEB visual language and shell.
- **Planned:** Capture operator/license-holder identity.
- **Planned:** Capture PHO licence number.
- **Planned:** Capture PHO licence valid-from / valid-to dates.
- **Planned:** Secure PHO licence document upload with metadata/audit traceability.
- **Planned:** Capture two distinct operator addresses:
  - `registered_pho`
  - `operational`
- **Planned:** Structured address fields per address, including country code/name and optional latitude/longitude.
- **Planned:** Setup completion state, completed-by identity, and completion timestamp.
- **Planned:** Authorization limited to superuser/system-control-level access.
- **Planned:** Review/confirmation step before final save.

**Product decision recorded:** Operator addresses are **not** licence-style validity records and should not use `valid_from`/`valid_to` by default. Licence validity dates belong to licence metadata/history. If address history is required later, use explicit archival/versioning design.

## 7) Proposed data-model direction (not yet implemented)

> Direction only; not current schema.

- **Planned:** `operators` table for operator identity and PHO licence metadata.
- **Planned:** `operator_addresses` table with first-version semantic types exactly:
  - `registered_pho`
  - `operational`
- **Planned:** Optional/separate `operator_license_documents` (or equivalent secure document metadata model).
- **Planned:** `system_setup` (or equivalent) for setup-state tracking.

**Pre-implementation check required:** Validate design against existing licensing schema and `operator_id` assumptions already present in current migrations/services.
- [`src/database/migrations.ts`](./src/database/migrations.ts)
- [`src/services/licensing.ts`](./src/services/licensing.ts)
- [`docs/licensing-authorities.md`](./docs/licensing-authorities.md)

## 8) Recommended implementation order

1. Keep README/handover documentation current.
2. Confirm existing database/licensing assumptions.
3. Finalize the data model.
4. Add migrations and tests.
5. Build the Initial System Setup viewport and route.
6. Add secure PHO licence upload handling.
7. Enter and verify the real operator installation data.
8. Return to Google Maps localization and connect autocomplete to the operational address.
9. Test at least a UK deployment and a German deployment.

## 9) Return checklist / next task

After Initial System Setup is implemented and real operator data exists, revisit:

- [ ] `includedRegionCodes` driven by persisted operator country.
- [ ] `locationBias` driven by persisted operational coordinates.
- [ ] Fallback behavior (operational -> registered PHO) if product-approved.
- [ ] Explicit user confirmation UX when house number/name is empty.
- [ ] Live map preview integration during address selection (if still incomplete in create/edit flows).
- [ ] UK deployment verification.
- [ ] Germany deployment verification.

## 10) Development commands and validation

Commands verified from [`package.json`](./package.json):

```bash
npm install
npm run typecheck
npm run build
npm test
npm run test:integration
npm run test:all
npm run db:migrate
npm run audit:db
npm run cleanup:demo
npm run customers:retention
npm run cleanup:inactive
```

Notes:
- `npm test` runs unit test discovery (`tsx src/test-run.ts --unit`) after test tsconfig type-check.
- Integration/all suites require appropriate test DB configuration (see [`docs/test-configuration.md`](./docs/test-configuration.md)).
- `npm run audit:db` is read-only readiness tooling.

---

## Scope of this handover update

This document intentionally updates project status/roadmap only. It does **not** introduce application behavior changes.
