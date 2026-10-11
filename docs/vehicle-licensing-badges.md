# Vehicle licences and booking assignment

Vehicle licences remain in `vehicle_licensing_authorities`, preserving the existing many-licences/many-authorities model. Each record distinguishes Hackney Carriage from Private Hire and may carry its own Vehicle licence badge. Neither field is the vehicle class, licensing authority, licence reference, or driver badge. Legacy vehicle licences without a type or badge remain readable but are not eligible for assignment.

Vehicle managers create and edit licence types and badges on the vehicle detail page. A blank badge on edit preserves its existing value; the explicit clear control removes it. Licence validity is determined by `valid_from` and `valid_until`. Licence documents are stored in the existing private PostgreSQL `BYTEA` mechanism; replacements retain prior versions, and current records are marked with `is_latest`.

## Booking assignment

The customer booking-management page now links operational bookings to an admin-only assignment form. Assignment routes accept only `customer_bookings` IDs and verify the booking belongs to the customer in the URL. Imported rows from `imported_bookings` are labelled read-only and are not assignable.

The server resolves the configured operator through the completed `initial_system_setup` row in `system_setup_state`. It uses only that operator's `operator_licences` records; the disconnected legacy `operator_licensing_authorities` table is not read or synchronized. An operator licence qualifies only when it is a documented PHO licence with an active status and an active authority on the booking's stored service date. Its latest private-storage document must be present.

**Existing operator-licence status limitation:** setup currently saves PHO licences with `status = 'draft'` and locks the initial setup after completion; there is no application workflow to verify a stored document and transition that licence to `active` (`saveOperatorLicence` in `src/services/system-setup.ts`). Because draft licences must not qualify, assignment will remain unavailable for that setup operator until an authorized status-activation workflow or existing external operation marks the verified licence active. This change does not silently activate licences or invent a compliance attestation; where/how an administrator verifies and activates it remains a product decision.

The administrator explicitly selects the driver, vehicle, Hackney Carriage or Private Hire context, and one exact common licensing authority. The server checks the selected authority against an active, date-valid operator licence, driver licence and vehicle licence. Licence end dates are exclusive, matching the existing validity checks. The vehicle must also be operationally active, and its selected licence must match both the chosen authority and explicit type. No authority is chosen automatically when more than one is common.

The authenticated session supplies the audit actor; the persisted booking row supplies the service date; the setup supplies the operator. Client-supplied overrides for these values or for the badge are ignored. Validation and the booking snapshot/audit write run transactionally. The exact matching vehicle licence supplies the saved badge. A missing badge remains `NULL` and is displayed as “Missing vehicle licence badge”; it is never fabricated.

Reassignment updates only the current booking snapshot and appends a new audit record. Editing vehicle licence data does not rewrite existing booking snapshots or audit records. Unassignment clears the current vehicle, authority, type and badge while retaining assignment audit history.

CSV/imported history remains read-only, as required for historical records. If future bookings are later imported for dispatch, an explicit product and data-flow decision about operational import or promotion is still required; copying history rows into operational bookings is out of scope.

This implements the confirmed follow-up to [PR #131](https://github.com/romanpetrlik-ctrl/RideMatrix-WEB/pull/131) and [the previous assignment task](https://github.com/romanpetrlik-ctrl/RideMatrix-WEB/tasks/a230fd1c-6bf7-49f8-b78c-924910b1fab0), replacing the blocker documented in [PR #133](https://github.com/romanpetrlik-ctrl/RideMatrix-WEB/pull/133). It does not claim legal certification or alter production data/schema.
