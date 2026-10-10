# Vehicle management

Vehicle pages are served by `src/routes/vehicles.ts` with data access in `src/services/vehicles.ts`.

## Admin Dashboard entry points

| Dashboard action | Destination |
| --- | --- |
| Vehicles → Active vehicles | `/vehicles?status=active` (vehicle directory filtered to `active`) |
| Vehicles → All vehicles | `/vehicles` (full vehicle directory) |

The directory accepts `q` (registration, make, model, or class label search), `status`
(`active`, `inactive`, `maintenance`; unknown values are ignored), and `page`. Search,
status, and pagination links keep each other's values.

## Workflow

- `GET /vehicles/new`, `POST /vehicles/new` – create a vehicle; success redirects to its detail page.
- `GET /vehicles/:id` – detail page with vehicle information, compliance documents, the
  linked driver form, and recent assignment history.
- `GET|POST /vehicles/:id/edit` – edit; validation and duplicate-registration errors re-render the form (400).
- `POST /vehicles/:id/documents` – upload or replace a compliance document (PDF/JPEG/PNG, 10 MiB).
  Replaced documents are kept as history; only the latest document per type is listed or downloadable.
- `GET /vehicles/documents/:documentId` – authorized inline view or `?download=1` attachment.
- `POST /vehicles/:id/driver` – assign, change, or clear the active primary driver.
- `GET /vehicles/:id/driver-history` – full driver assignment history.

The relationship model is one active primary driver per vehicle; a driver may be linked to
multiple vehicles. Only accounts with the `driver` role can be assigned. Re-saving the
current driver does not add a history row. Auth `users.id` values are compared as text
(`u.id::text = a.driver_id`) so UUID-keyed auth tables are supported.

Driver personal profiles, right-to-work checks, and driver-licence records are not part of
vehicle management.

## Safeguards

- Every route requires an authenticated session; access is limited to `admin`, `superuser`,
  or roles with the `manage_users` permission (`canManageStaff`). Others receive 403.
- All responses are `no-store`.
- Mutations require a valid CSRF token and are rate limited (process-local plus the
  PostgreSQL-backed distributed counter). Document uploads authorize and rate limit before
  multipart parsing, then validate CSRF, extension, MIME type, and file signature.
- Document downloads use a sanitized filename, `X-Content-Type-Options: nosniff`, and only
  serve the stored PDF/JPEG/PNG content types (anything else falls back to `application/octet-stream`).
