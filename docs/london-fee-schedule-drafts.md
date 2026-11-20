# Toll and road-charge fee schedules

System Settings → Toll & Fees has a fee-settings page for London LEZ, London ULEZ, the London Congestion Charge (CC), Dartford Crossing and the shared Blackwall/Silvertown tunnel scheme. Every save appends a new version row to `london_fee_schedule_versions`. Rows are append-only (triggers reject UPDATE/DELETE) and record the actor and timestamp.

Migration `0035_road_charge_schedule_activation` appends structured, calculation-ready inactive versions (`format: road-charge-schedule-v1`) for LEZ, ULEZ and tunnels on top of their legacy v1 drafts. It also seeds CC as v1, and migration `0036_congestion_charge_default_21_inactive_version` adds the inactive £21 CC version. Migration `0037_activate_default_tunnel_schedule` appends an **active** tunnel version for New Booking quotes only when the latest tunnel version is still the untouched v2 default seed. It records the owner-authorized system migration as the actor; it does not overwrite or activate a customized or previously disabled schedule. LEZ, ULEZ and CC remain inactive. Legacy drafts and Dartford are not modified, and Dartford stays `draft_inactive` with no activation action.

## Activation (LEZ, ULEZ, CC and Blackwall/Silvertown)

A structured schedule is used by New Booking quotes only when its latest version is `active`. The tunnel schedule's default version is activated by migration `0037`; other eligible schedules are enabled from their fee-settings page (`POST <fee-settings path>/activation`, System Settings authorization + CSRF). Enabling requires:

- a known effective-from date (and a valid effective-until, if set);
- every source is an https TfL (`tfl.gov.uk`) or GOV.UK (`gov.uk`) URL, plus a research date;
- every required rate present as an exact GBP amount. £0.00 is only allowed where the rule is a verified zero rate (`allowZero`), such as a registered CC cleaner vehicle;
- charging hours and, where bank holidays matter, a recorded bank-holiday calendar covering the service dates;
- no data-level `calculationBlockers` and no code-level blocker (`codeCalculationBlockers`, for unverified route geometry);
- an admin-entered verification date (not in the future) and confirmation that every cited source was opened and matches.

Each enable or disable appends a version with the actor and verification record. Any rate or date edit appends an **inactive** version, so an edited schedule must be re-verified and re-enabled. Disabling clears the verification. The database `payload_check` constraint rejects active rows without verification, with blockers, or for Dartford.

## Current status (research checked 2026-11-19)

| Scheme | Status after deploy | Can be enabled? | Blocker |
| --- | --- | --- | --- |
| LEZ | inactive | Yes | – |
| ULEZ | inactive | No | `src/services/london-ulez-boundary.ts` has no source, licence or verification. Route exposure cannot be trusted. |
| Congestion Charge | inactive | No | Geometry is owner-confirmed (polygon in `src/reference-data/toll-fees/london-congestion-charge/boundary.geojson`, verified 2026-11-19; source URL and licence not provided). Not an activation blocker by itself. The schedule still has no verification record, and the admin must open and confirm each cited TfL source before enabling. The £21 rate is the approved conservative default, not a rate stated by a cited page as the standard charge. Bank-holiday calendar covers service dates to 2027-12-24. Migration `0036_congestion_charge_default_21_inactive_version` appends an inactive £21 version (£18 is not used). |
| Blackwall/Silvertown | active on deployment if latest version is the untouched v2 default seed | Yes; automatically by migration `0037` | North/south portal coordinates are supplied and confirmed by the project owner in `src/services/booking-routing.ts`; crossings require a route to pass both portals in sequence. Migration records source confirmation and owner authorization without attributing it to a named person. Auto Pay weekday bank-holiday peak treatment is not stated by TfL, so Auto Pay crossings on those dates stay unresolved. |
| Dartford Crossing | draft_inactive | No (out of scope) | – |

Sources (verification via search snippets, 2026-11-19; the sandbox could not open these pages directly. The tunnel migration records this research and the owner's activation authorization; other eligible schedules still require an administrator to open and confirm every source before enabling):
- LEZ: [TfL LEZ lorries, vans, buses and coaches](https://tfl.gov.uk/modes/driving/low-emission-zone/lorries-vans-buses-and-coaches) and [make a payment](https://tfl.gov.uk/modes/driving/low-emission-zone/make-a-payment). Standards effective 2021-03-01.
- ULEZ: [TfL ULEZ where and when](https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/ulez-where-and-when), London-wide from 2023-08-29.
- CC: [TfL Congestion Charge](https://tfl.gov.uk/modes/driving/congestion-charge) and [changes](https://tfl.gov.uk/modes/driving/congestion-charge/congestion-charge-changes), effective 2026-01-02.
- Tunnels: [TfL paying Blackwall and Silvertown tunnel charges](https://tfl.gov.uk/modes/driving/silvertown-blackwall-tunnels-charge/paying-blackwall-and-silvertown-tunnel-charges) and the [charging statement effective September 2026](https://tfl.gov.uk/cdn/static/cms/documents/silvertown-tunnel-charging-statement-effective-september-2026.pdf), effective 2026-09-21.
- Bank holidays: [GOV.UK](https://www.gov.uk/bank-holidays).

## Booking price calculation (`src/services/road-charge-pricing.ts`)

- **Service time.** The journey window starts at the service date and time in `Europe/London`. It ends at that time plus the route duration plus a buffer of max(15 min, 25% of the duration). A window that straddles a charging-hours or band boundary is unresolved.
- **Zone exposure.** LEZ, ULEZ and CC use polygon/route intersection over the full ordered route path, including Via stops (`detectRoadChargeZones`).
- **Daily charges.** Each scheme is charged once per charging day touched in a quote.
- **Tunnels.** Crossings are detected when the route passes within 50 metres of both supplied portal coordinates, in order (`detectTunnelCrossings`); the portal order determines tunnel identity and direction. Each crossing is charged by vehicle class, Auto Pay status and time band.
- **Other tolls.** A Google `tollsReported` flag is never treated as a tunnel fee. Identified tunnel crossings are itemized separately and excluded from **Other tolls**. The provider does not name toll facilities, though, so a reported toll keeps **Other tolls** unresolved, and that quote has no confirmed total.
- **Default profile.** New Booking has no per-booking road-charge controls. Quotes use the central `DEFAULT_STANDARD_CAR_PROFILE` (`src/services/road-charge-schedules.ts`): a standard passenger car, treated as ULEZ-compliant (explicit £0.00 ULEZ line, an approved operating assumption), not charged by LEZ (TfL states cars are outside the LEZ), CC at the conservative £21 rate, and tunnels at the standard car rate without Auto Pay. This assumption must not be applied to a real vehicle with unknown emissions.
- **Vehicle changes.** Vehicle emissions, class and payment facts are not yet persisted on vehicles, and vehicle assignment is not wired into quoting. Until that exists, every quote uses the default profile. A vehicle whose emission compliance is unknown must produce an unresolved ULEZ line naming the missing fact, never the default £0.00.
- **Unresolved blockers.** A charge is unresolved while its schedule is inactive, its geometry is unverified, or a required fact is missing. The tunnel schedule is active after migration `0037` only when version 2 is still the untouched default seed; LEZ, ULEZ and CC remain inactive. Any unresolved line makes the quote `incomplete` with no total.
- **Line items.** Each charge is its own line (`road-charge` / `tunnel-charge`). Location discounts never reduce these lines.
- **Snapshot.** The schedule version, verification, rate, matching basis, route/tunnel evidence and vehicle inputs are stored in the immutable booking price snapshot.

London schedules preserve GBP amounts, per-charging-day periods, category applicability, emissions thresholds, operating notes, provenance, source URLs where supplied, and explicit unknown/unverified effective dates and discount/exemption rules. Enforcement penalties are not fee rates.

The Dartford schedule stores each vehicle class/payment-method rate as an exact GBP decimal string per crossing. The GOV.UK charges URL is retained; the effective and verification dates are unknown. Free overnight hours, axle counting notes, and supplied disability/resident discount notes are recorded, but eligibility is not resolved or applied.

The Blackwall/Silvertown schedule is shared by both tunnels, but each crossing must retain its actual tunnel identity (Blackwall or Silvertown). Rates are exact GBP decimal strings per crossing; weekday peak periods, weekend/off-peak Auto Pay behavior, and the Christmas Day exception are recorded. The TfL source URL and effective date (2026-09-21) are recorded; the source licence is unknown. Migration `0037` records source verification checked on 2026-11-19 and the owner-authorized activation. Bank-holiday peak behavior, small/large van thresholds, vehicle mapping, and discount/exemption eligibility remain unresolved and are not applied.

Migration `0022_london_fee_schedule_drafts` seeds version 1 for the London schedules. Migration `0023_crossing_fee_schedule_drafts` adds Dartford Crossing and Blackwall/Silvertown version 1 and expands the allowed scheme keys. Later edits create numbered snapshots in `london_fee_schedule_versions`; prior snapshots are never overwritten.

Each fee-settings page shows only the 3 most recent draft versions (newest first). When a scheme has more, **View all history** opens `<fee-settings path>/history` (for example `/settings/toll-fees/dartford-crossing/fee-settings/history`), which lists that scheme's versions newest first, 20 per page, with Previous/Next controls. Both views are limited and paginated in SQL; invalid `page` values show page 1 and out-of-range values show the last page. History pages require the same System Settings authorization as the fee-settings pages.
