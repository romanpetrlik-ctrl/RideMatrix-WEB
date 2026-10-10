# Staff directory (`/staff`)

`/staff` is a read-only list of internal user accounts, built directly on top of the
existing production PostgreSQL authentication tables (`users`, `roles`, `user_roles`,
`permissions`, `role_permissions`). It is intentionally separate from `/customers`
(customer profiles) and `/account` (the signed-in user's own personal account page).

## What counts as "staff"

A user is included in the staff list if they hold at least one role in
`STAFF_MANAGEMENT_ROLES` (`src/services/staff.ts`):

```
admin, superuser, staff, tech_support, driver
```

Users who are only assigned `customer` and/or `partner` roles are excluded. A user with
both a staff-qualifying role and a non-staff role (for example `staff` + `customer`)
still appears — the list shows **all** of their assigned roles, not just the
staff-qualifying one. Every user appears exactly once regardless of how many roles they
hold; the underlying query groups by the user's primary key and aggregates role names
into an array rather than joining out one row per role.

## Displayed fields

| Field       | Source                                                              |
| ----------- | -------------------------------------------------------------------|
| Email       | `users.email`                                                      |
| Status      | `users.status`                                                     |
| Roles       | `roles.key` via `user_roles`, one pill per assigned role; `superuser` is listed first as `SU · System Control` |
| Created     | `users.created_at`, formatted; shown as `—` if absent               |
| Last login  | Detected at runtime (see below); shown as `Never` if unavailable    |

**Last login** is not part of the schema the repository's own tests/migrations create
for the auth tables (`src/database/test-helper.ts`), and this repository does not own or
migrate that schema. Rather than assuming a column exists, `listStaffUsers` inspects
`information_schema.columns` once per process and looks for a column named
`last_login_at`, `last_login`, `last_sign_in_at`, or `last_signed_in_at` on `users`. If
none of those exist, the field is safely omitted (rendered as `Never`) instead of
inventing data. No password, token, login-code, or other sensitive column is ever
selected or rendered.

### Superuser indicator

Accounts holding the `superuser` role key show it first, as a badge reading
**`SU · System Control`** (`<abbr title="Superuser">SU</abbr>`), with a thicker border
and amber background (`.staff-role-badge--superuser`). The text marker carries the
meaning, so it does not depend on colour. This is display only and never changes role
assignments.

## Role source of truth for authorization

The Staff directory reads role assignments directly from `users` / `user_roles` /
`roles.key`. Route authorization never uses that display: every protected route asks
the external auth service for the current session (`GET /auth/session`,
`getSessionAccount()` in `src/services/api.ts`) and checks `session.user.roles`.

- **Source of truth:** the auth service owns the `user_roles` assignments and returns
  their `roles.key` values in the session. The web app treats the session role list
  as authoritative and does not add roles from its own database read.
- **Contract:** `session.user.roles` must be an array of exact role keys (for example
  `superuser`). Display labels (`System Control`), case variants (`SUPERUSER`), padded
  values, or role objects do not match and are denied.
- `/settings` and `/vps` require `superuser`; `/tech-support` requires `tech_support`
  (`workspaceModules` in `src/routes/role-sections.ts`). A denied request returns the
  `403` page with the missing role named; a granted request says which session role
  granted access.

### `/settings` access investigation (production)

The reported page for `bookings@romanairporttransfers.co.uk`, showing **System
settings** and "This module is available to your authorized internal account", is the
page that renders only **after** `canAccessWorkspace(roles, "system-settings")`
succeeds. A denied request renders the `403` "Unable to continue" page instead. So the
session did include `superuser`, and the Staff directory and auth session agreed.
`/settings` is still a placeholder with no settings, and the old wording did not say
whether access had been granted, so it looked like a denial. The page now says
"Access granted" with the granting role and states that no system settings are
configurable yet. The authorization check is unchanged.

## Authorization

`GET /staff` is protected by `canManageStaff()` (`src/services/staff.ts`):

1. Users with the `admin` or `superuser` auth role are always authorized.
2. Otherwise, the check queries `role_permissions` / `permissions` for a `manage_users`
   grant on any of the user's roles, so a permission-based grant (without `admin`/
   `superuser`) is also honored when the repository's permission model supports it.
3. If the permission tables cannot be queried (for example if a deployment does not have
   them yet), the check safely returns `false` rather than throwing or defaulting to
   authorized.

Behavior matches the existing `/customers` authorization pattern
(`requireAdminSession` in `src/routes/customers.ts`):

- Unauthenticated requests redirect to `/access`.
- Authenticated but unauthorized requests receive the existing `403`
  `pages/unavailable` response — they are never silently redirected to `/account`.

## Navigation

- The Admin Dashboard's "Operational shortcuts" menu (`src/routes/dashboard.ts`) has a
  "Staff" row linking to `/staff`, alongside the existing "Customers" row.
- Selecting the `staff` workspace role from `/choose-role` (or auto-selecting it as a
  user's only role) now opens `/staff` instead of `/account`
  (`getWorkspaceRedirectHref` in `src/routes/account.ts`), mirroring how `admin`
  already opens `/dashboard`. If the signed-in user's `staff` auth role does not also
  satisfy `canManageStaff()`, they receive the same `403` response as any other
  unauthorized user — holding the `staff` role by itself does not grant staff
  management access.
- The generic role-workspace placeholder previously registered at `/staff` in
  `src/routes/role-sections.ts` has been removed; that path is now served exclusively
  by the real staff list.

## Known limitations / placeholders

- Read-only for this change: no create/edit/suspend/remove actions are implemented.
  The Admin Dashboard's "Management → Staff" tile description ("Add, edit, suspend, or
  remove staff records") is pre-existing prototype copy that is not currently rendered
  as a clickable element (`dashboardSections` is not wired into `dashboard.ejs`); it is
  unrelated to this change and left as-is.
- No sorting/filtering/pagination beyond a fixed alphabetical-by-email order, consistent
  with keeping the first implementation simple; `/customers` pagination/search patterns
  can be layered on later if the list grows large enough to need them.
- If a parallel workspace-navigation redesign changes how `/choose-role` or the
  dashboard tiles are rendered, the `/staff` route, its authorization check, and the
  `getWorkspaceRedirectHref` mapping are independent of the rendering markup and should
  merge cleanly; only the navigation entry points may need to be re-wired to the new
  markup.

## Tests

`src/services/staff.test.ts` and `src/routes/staff.test.ts` cover: authorized access,
unauthenticated redirect, forbidden access for a user without `manage_users`
authorization, inclusion of internal users, exclusion of customer/partner-only users,
a single row per user with all assigned roles shown, the empty state, and safe handling
of the optional last-login column (both when absent and when present).

```bash
npm run typecheck
npm run build
npm test
```
