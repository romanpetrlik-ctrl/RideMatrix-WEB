# Internal booking calendar

The calendar at `/calendar` shows existing booking records. Bookings are the only source of truth: the calendar copies no bookings, creates no separate calendar entries, and needs no external calendar account.

## Views

- `GET /calendar?view=month|week|day&date=YYYY-MM-DD` renders month, week, or day views.
- One responsive markup serves desktop and mobile. Below 700px the grid collapses to a single column, empty days are hidden, and the weekday header is hidden (`.booking-calendar-*` in `public/css/app.css`).
- Dates and times are interpreted in `Europe/London`, using the booking's `service_timezone` (falling back to `SERVICE_TIMEZONE`) and the existing local-to-UTC conversion (`serviceLocalToUtc` in `src/services/new-bookings.ts`).
- Archived bookings are excluded.

## Access rules (enforced server-side)

| Role | Scope | Events |
| --- | --- | --- |
| `admin`, `dispatcher` | all bookings | reference, time, route, status, live status, driver |
| `driver` | `driver_id = session.user.id` | reference, time, route, status, live status (no driver name) |
| anyone else | 403 | — |
| not signed in | redirect to `/access` | — |

The driver scope comes only from the server session. Query parameters such as `driverId` are ignored. Completed and cancelled bookings assigned to the driver remain visible, with their status.

## Click-through

- Dispatchers and admins open `/bookings/:id`. Dispatchers get the read-only detail view: customer and assignment links are hidden and a "Read-only view" notice is shown. All mutations remain admin-only (`requireAdmin`, `allowedRoles` defaults to `["admin"]`).
- Drivers open `/driver`, because the driver board has no per-booking anchor.

## Changes

Changes are made through the existing booking workflow. The calendar has no drag-and-drop. Status changes, cancellations, completions, unassignment (`driver_id` set to `NULL`), and reassignment all update the booking row, so the next calendar load reflects them.

## Customer calendar: not implemented

A customer calendar needs a verified customer identity and proof of booking ownership. The repository has neither: the only auth is the external API at `API_BASE_URL` (see `docs/customer-persistence.md`), and no customer login or ownership check exists for booking lists. Predictable IDs must never expose foreign bookings. Before this feature can be built, the repo needs:

1. A verified customer sign-in flow backed by the external auth API.
2. A mapping from authenticated customer identity to `customer_bookings` rows, enforced server-side.

## ICS subscription: later phase (design only)

Driver ICS subscription is a separate phase and is not part of this change. The design constraints are:

- No public URLs and no predictable or guessable tokens. Any subscription URL must carry a high-entropy, per-driver secret that is stored hashed, revocable, and rotatable.
- The feed is generated from the same scoped query (`listBookingCalendarEvents` with driver scope), so it inherits the same visibility rules.
- No direct OAuth synchronization with Microsoft or Google.

## Tests

- `src/services/booking-calendar.test.ts`: date ranges, grid construction, BST conversion, driver/all SQL scope.
- `src/routes/booking-calendar.test.ts`: auth and 403, dispatcher and driver scope from session, invalid dates, status change reflected, mobile CSS.
- `src/routes/bookings.test.ts`: dispatcher read-only detail; mutations return 403.

Run with `npm test`, or `npx tsx --test <file>` for a single file. Integration coverage for status, reassignment, and archive effects against PostgreSQL is not yet written.
