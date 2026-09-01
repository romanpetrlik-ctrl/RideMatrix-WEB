# Staff user administration (Create / Invite user)

Internal accounts live in the existing authentication tables owned by the auth service:
`users`, `roles`, `permissions`, `user_roles`, `role_permissions`, and `login_codes`. This
web layer only reads the role catalogue and inserts new internal accounts plus their role
assignments. It never creates, migrates, or alters those tables and never touches customer
tables or demo seed data.

## Routes

| Route               | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `GET /staff/invite` | Renders the "Create / Invite user" form.                          |
| `POST /staff/invite`| Validates the input and creates the account and role assignments. |

The action is linked from the `/staff` workspace as **Create / Invite user**, and the form's
cancel action returns to `/staff`. `/account` is unchanged and remains the signed-in user's
personal account page.

## Authorization

Authorization is resolved server-side from the session roles reported by the auth service and
the permissions those roles hold in `role_permissions` / `permissions`. Submitted form values
never influence the authorization decision.

- Access to the feature requires the `superuser` role, or the `manage_users` or
  `manage_user_roles` permission.
- Unauthenticated requests are redirected to `/access`, following the existing behaviour.
- Authenticated but unauthorized requests receive the shared `403` "Unavailable" page. There is
  no silent redirect to `/account`.

## Role delegation policy

Only internal roles are offered: `superuser`, `admin`, `staff`, `tech_support`, `dispatcher`,
and `driver` — and only the ones that actually exist in the current database. `customer` and
`partner` are deliberately excluded from this internal staff flow; those accounts are onboarded
through their own domain flows.

- Roles are rendered as a checkbox set and every selected role is persisted once in
  `user_roles`.
- Unknown roles, excluded roles, and roles the administrator may not delegate are rejected with
  a validation error; nothing is written.
- Delegating `superuser` additionally requires the administrator to hold the `superuser` role or
  the explicit `manage_user_roles` permission, plus an explicit confirmation checkbox in the UI.
  The permission-based path is what allows the first superuser to be bootstrapped.

## Invitation / access behaviour

No password or other credential is created, stored, or displayed. After the account is created,
the existing access-request (login-code) flow is triggered for the new address. If that
integration is unavailable, the form reports `Invitation pending: access link or login code
delivery is not configured`, and the account can still sign in through `/access`. No reusable
secret is ever rendered or logged.

Where the `users` table exposes a `status` column, new accounts are created with the `Pending`
status. The user row and all role rows are inserted in a single transaction, and duplicate-email
races are surfaced as a clean validation error via the existing unique email constraint.

## Onboarding `roman.petrlik@hotmail.com`

The future real superuser account is **not** created automatically and is not hard-coded
anywhere. It is created deliberately through `GET/POST /staff/invite` by an administrator who is
authorized to delegate `superuser`:

1. Open `/staff/invite`.
2. Enter `roman.petrlik@hotmail.com`.
3. Select the `System Control` (`superuser`) role and confirm the delegation warning.
4. Submit, then sign in with that address through the standard `/access` flow.

`bookings@romanairporttransfers.co.uk` remains completely unchanged by this feature. It is only
the temporary operational mailbox account and is never treated as the superuser.

## Known limitation

The repository has no CSRF token mechanism for its existing HTML forms, so this form follows the
same existing form-security conventions instead of introducing an incompatible one. Adding CSRF
protection consistently across all forms remains an open gap.
