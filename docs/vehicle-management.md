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
- Vehicle record save and document upload are separate actions. The create/edit form only saves the
  vehicle record; document uploads happen after save from the detail page.
- `POST /vehicles/:id/documents` – upload or replace a compliance document (PDF/JPEG/PNG, 10 MiB).
  Replaced documents are kept as history; only the latest document per type is listed or downloadable.
- `GET /vehicles/:id/record-documents` – list uploaded record documents for a vehicle, optionally filtered by `category`.
- `POST /vehicles/:id/record-documents/upload` – multi-file upload for one required category (e.g. `mec`, V5C pages 1+2).
- `GET /vehicles/record-documents/:documentId/view` – authorized inline stream for a stored record document.
- `GET /vehicles/record-documents/:documentId/download` – authorized attachment download for a stored record document.
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
  multipart parsing, then validate CSRF, extension, MIME type, and file signature. Upload
  batches that exceed their configured file or size limits are rejected without saving any files.
- Required-document groups include both DocuVault uploads and existing vehicle-document records,
  with legacy files retaining their existing view and download links.
- Document downloads use a sanitized filename, `X-Content-Type-Options: nosniff`, and only
  serve the stored PDF/JPEG/PNG content types (anything else falls back to `application/octet-stream`).

## DocuVault storage configuration

Record document files are stored on the VPS filesystem under `DOCUMENT_VAULT_ROOT` (default
`/opt/ridematrix/DocuVault`) with year-first layout:

```
DocuVault/{year}/Drivers/{slug__id}
DocuVault/{year}/Vehicles/{HC|PHV}/{slug__id}
DocuVault/{year}/Operators/{slug__id}
```

Required environment variables:

- `DOCUMENT_VAULT_ROOT`
- `DOCUMENT_MAX_FILE_SIZE_MB`
- `DOCUMENT_MAX_FILES_PER_CATEGORY`
- `DOCUMENT_ALLOWED_MIME`

VPS runtime user must have create/read access to `DOCUMENT_VAULT_ROOT` and child directories.
