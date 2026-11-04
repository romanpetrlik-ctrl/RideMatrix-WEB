# Inactive toll and fee schedule drafts

The System Settings → Toll & Fees fee-settings pages contain separate editable draft schedules for London LEZ, London ULEZ, Dartford Crossing, and the shared Blackwall/Silvertown tunnel scheme. All are permanently marked `draft_inactive`; the database rejects active status, the edit forms only accept rate amounts, and every save appends a new version. Version rows are append-only and record the actor and timestamp.

These drafts are not connected to route estimates, booking totals, invoices, notifications, or customer charges. They do not calculate fees, and the application provides no activation action. Do not connect them to pricing unless the effective dates and complete scheme rules have been independently verified and a separately reviewed change authorizes that behavior.

London schedules preserve GBP amounts, per-charging-day periods, category applicability, emissions thresholds, operating notes, provenance, source URLs where supplied, and explicit unknown/unverified effective dates and discount/exemption rules. Enforcement penalties are not fee rates.

The Dartford schedule stores each vehicle class/payment-method rate as an exact GBP decimal string per crossing. The GOV.UK charges URL is retained; the effective and verification dates are unknown. Free overnight hours, axle counting notes, and supplied disability/resident discount notes are recorded, but eligibility is not resolved or applied.

The Blackwall/Silvertown schedule is shared by both tunnels, but each crossing must retain its actual tunnel identity (Blackwall or Silvertown). Rates are exact GBP decimal strings per crossing; weekday peak periods, weekend/off-peak Auto Pay behavior, and the Christmas Day exception are recorded. The source URL, licence, verification date, and effective date are unknown. Bank-holiday peak behavior, small/large van thresholds, vehicle mapping, and discount/exemption eligibility remain unresolved and are not applied.

Migration `0022_london_fee_schedule_drafts` seeds version 1 for the London schedules. Migration `0023_crossing_fee_schedule_drafts` adds Dartford Crossing and Blackwall/Silvertown version 1 and expands the allowed scheme keys. Later edits create numbered snapshots in `london_fee_schedule_versions`; prior snapshots are never overwritten.
