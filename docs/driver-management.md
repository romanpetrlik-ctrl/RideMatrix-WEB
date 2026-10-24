# Driver management

Driver pages are served by `src/routes/drivers.ts` with profile and lifecycle data in
`src/services/drivers.ts`. Admins and users with the `manage_users` permission can view,
edit, and archive drivers.

## Legacy profiles

The `0018_driver_lifecycle_legacy_profiles` migration makes profile fields nullable for
legacy rows, derives a short label from existing names or a masked email local-part, and
marks incomplete profiles for manual review. Missing profile rows are backfilled as
`pending_review` records without inventing first or last names. The directory display
fallback order is full name, short name, masked email local-part, then `Unnamed driver`;
the account id is shown only as secondary metadata.

Edit saves validate and normalize first and last names, regenerate the short name, and
backfill the profile with an upsert. A profile remains `pending_review` until it has
complete names and a current active licence from an active licensing authority. It then
transitions to `active`.

## Lifecycle and archive

Driver lifecycle states are `pending_review`, `active`, `rejected`, `suspended`, and
`archived`. Transitions are validated by the service. Rejected, suspended, and archived
transitions require a reason; blocked attempts and successful transitions are recorded in
`driver_lifecycle_audit`.

Archive is available from both the directory and detail pages. It uses a confirmation
dialog with a required reason, saves that reason in the audit log, and never hard-deletes a
driver. Archived records are hidden from the default directory and vehicle assignment
candidates; archived drivers remain visible through the archived status filter.
