# Customer lifecycle and retention

`Active` and `Suspended` are the only normal customer statuses. Inactivity is
derived from `last_booking_at` (or the account creation date when no ride is
known) and is recorded in `inactive_at`; it is not a third status.

The retention job is safe to run repeatedly:

```sh
npm run customers:retention
```

Schedule it externally (for example, daily from cron or a deployment
scheduler). It first marks non-deleted customers inactive, then anonymizes or
purges eligible aggregates in batches. Normal customer lists exclude inactive,
anonymized, and erasure-requested records.

Configuration:

* `CUSTOMER_INACTIVITY_MONTHS` (default `12`)
* `CUSTOMER_RETENTION_MONTHS` (default `24`)
* `CUSTOMER_PURGE_MODE` (`anonymize` by default, or explicitly `delete`)

The configured retention period is an operational default, not a legal
determination. Production values must be confirmed for the applicable
jurisdiction, licensing requirements, disputes, investigations, accounting
needs, and other documented obligations. A future `retention_hold_until`
prevents anonymization and deletion; `retention_hold_reason` records why.
Erasure requests are recorded in `erasure_requested_at` and do not override a
valid hold.

Anonymization removes names, contact details, addresses, notes, and
identifying booking fields while preserving permitted aggregate information.
Delete mode removes only eligible customer-linked records transactionally.
Existing legacy `Pending` rows are explicitly migrated to `Active` with a
review reason; legacy `Delete Pending` rows are migrated to `Suspended` with
an erasure timestamp and review reason, never silently deleted.

Imports create only `Active` customers. A new ride updates the latest booking
date and may clear inactivity, but never clears an erasure request or active
retention hold.
