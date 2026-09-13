# Staff login audit events

The web layer records internal-user authentication outcomes in `staff_login_audit`.
It uses the stable event names `staff_login_succeeded` and `staff_login_failed`.

Each event stores `occurred_at`, `account_id` when available, the normalized
`login_identifier` when submitted or known, `success`, and request
`ip_address` and `user_agent` when available. Failed events additionally store
one category: `invalid_credentials`, `disabled_account`, `unauthorized`,
`blocked`, or `system_failure`. Passwords, hashes, cookies, tokens, and CSRF
values are never persisted.
