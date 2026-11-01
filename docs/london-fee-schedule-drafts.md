# London LEZ and ULEZ draft fee schedules

The System Settings → Toll & Fees → London LEZ and London ULEZ fee-settings pages contain separate editable draft schedules. Both are permanently marked `draft_inactive`; the database rejects active status, the edit form only accepts rate amounts, and every save appends a new version. Version rows are append-only and record the actor and timestamp.

These drafts are not connected to route estimates, booking totals, invoices, notifications, or customer charges. They do not calculate fees, and the application provides no activation action. Do not connect them to pricing unless the effective dates and complete scheme rules have been independently verified and a separately reviewed change authorizes that behavior.

The schedules preserve GBP amounts, per-charging-day periods, category applicability, emissions thresholds, operating notes, provenance, source URLs where supplied, and explicit unknown/unverified effective dates and discount/exemption rules. The LEZ source URL remains unknown because it was not supplied. Enforcement penalties are not fee rates.

Migration `0022_london_fee_schedule_drafts` seeds version 1 for both schedules. Later edits create numbered snapshots in `london_fee_schedule_versions`; prior snapshots are never overwritten.
