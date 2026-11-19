# New Booking

`GET /bookings/new` (optionally `?customerId=<id>`, used by the customer **New booking** action) is a desktop-first dispatcher form. It requires the same `admin` role as `/customers`. All POSTs use the global CSRF protection; `POST /bookings/quote` returns JSON and `POST /bookings` saves. A saved booking opens at `GET /bookings/:id`.

## Blocks

1. **Booking reference** – the booking ID (`RM-` reference from the `new_booking_reference` sequence), creation time and the signed-in staff member are assigned by the server on save. Before saving the page shows "Assigned on save".
2. **Booking manager and passenger** – the manager is selected from active existing customers (business customers use their booker contact). Name, phone and email are prefilled and editable. With **Passenger is booking manager** ticked, the passenger name/phone are read-only and follow the manager fields; the server re-copies them on save. Unticking restores the passenger's own independently typed values.
3. **Journey details and map** – service date and a 24-hour `HH:mm` time in five-minute steps, interpreted in `Europe/London`. Pickup, drop-off and up to two optional Via stops (hidden until **Add Via stop**) can each be a managed Airport (Airport Fees record), a managed POI, or an address. Every address stop requires a **House name / number**; Google fills it when available, otherwise the dispatcher enters it. The value is included in the saved stop label. Airport/POI stops store their internal RideMatrix ID and configured coordinates; addresses store the Google place ID, verified coordinates and structured postcode. An address without a verified place is kept but marked unverified, and the route is then unresolved. The route summary and map show the ordered route (pickup → via 1 → via 2 → drop-off) from Google Routes (`GOOGLE_MAPS_SERVER_API_KEY`): total miles, time on road, provider-reported tolls, detected London LEZ / ULEZ / Congestion Charge zone exposure (route polygon intersection), and identified Blackwall/Silvertown tunnel crossings. Without a usable route the summary says **Unresolved** and no distance, duration or toll status is shown.
- **Passengers and luggage** – Adults, Children, Sports items, XL bags, L bags, Cabin bags and Backpacks counts (0–7, default 0), child-seat and booster flags, and a live cargo summary. The summary lists only non-zero bag types (e.g. "4 bags (L 2, Cabin 2)") and omits the bag part when there are none; zero stays selectable in the form.
5. **Fare and itemized breakdown** – one row per charge with a status of **Applied**, **Configured £0.00**, **Not applicable** or **Unresolved**, its basis, and amount. **Total payable** appears last and only when no line is unresolved; otherwise it reads **Not confirmed**.

## Pricing (`src/services/booking-pricing.ts`)

Each line is separate and fees are never folded into the ride fare.

- **Ride fare** – standard Distance Slabs over the passenger route miles (progressive, start-inclusive slabs, open-ended final slab, prorated fractional miles, one final rounding). An enabled minimum-fare rule applies only when the pickup or drop-off is that exact managed Airport/POI ID: `ride fare = max(slabs fare, minimum)`. Via stops do not trigger minimums or fees. Additional distance slab sets are not used.
- **Location discount** – `resolveJourneyLocationDiscount`: an active operational-base radius rule for the endpoint's managed ID takes exclusive precedence (inside the radius only the radius discount, outside it no discount and no postcode fallback); otherwise postcode rules apply. One discount at most, applied to the ride fare only.
- **Airport pick-up fee / Airport drop-off fee** – from the exact selected Airport Fees record when it is the pickup or drop-off. A saved `0.00` is shown as **Configured £0.00**.
- **POI fees** – only fees configured for the exact selected POI ID. Automatic triggers apply when the POI is the pickup or drop-off; confirmation-triggered fees apply only when the dispatcher ticks them.
- **Road charges (LEZ, ULEZ, Congestion Charge, Blackwall/Silvertown)** – priced only from an **active** schedule (see `docs/london-fee-schedule-drafts.md`), using the service date/time in `Europe/London` and the route geometry. Dispatchers never enter these per booking. Quotes use the central standard passenger car default profile (ULEZ-compliant, so an explicit ULEZ £0.00 line; not charged by LEZ; CC £21; tunnel car rate without Auto Pay). Each fee is its own line: LEZ, ULEZ, Congestion Charge, and one line per tunnel crossing. A line stays unresolved while its schedule is inactive, its geometry is unverified, or a required vehicle fact is missing. No schedule is active yet, so zone exposure, tunnel crossings and CC remain unresolved, and the quote is `incomplete` with no total. Vehicle emissions are not persisted, so vehicle assignment cannot yet recalculate or version a quote; see `docs/london-fee-schedule-drafts.md`.
- **Unresolved charge types** – the application has no reliable rate source for these, so they are never estimated:
  - tolls reported by the route that are not an identified tunnel crossing (no toll schedule; Dartford is not priced);
  - daily/bank-holiday surcharges and fixed fares that match the journey (their booking basis is not defined);
  - dead mileage (assessed on the booking assignment page).
  If one of these applies, or the route or required configuration is missing, the price is **incomplete**.

## Saving

The server re-validates every field and recalculates the price. The save is rejected (409) when the result differs from the quote the dispatcher last saw. An incomplete price can only be saved when **Save with price unresolved** is ticked; the booking then has no total (`price_status = 'incomplete'`).

Migration `0033_new_booking_price_snapshots` adds booking-manager, passenger, service-time, cargo and creator columns to `customer_bookings`, plus `booking_journey_stops`, `booking_price_snapshots` and `booking_price_line_items`. The booking, its stops, the snapshot and every line item are written in one transaction. The snapshot stores the pricing inputs, route result, Fare Settings version and each line's basis and source rule/record IDs, so later settings edits do not change a saved booking. Database triggers reject updates and deletes on snapshots and line items. Existing bookings are not modified.

## Customer quote preview (`src/services/customer-quote.ts`)

The booking detail page (`GET /bookings/:id`, `admin` only) shows **6. Customer quote preview** below the dispatcher breakdown. It is built only from the saved price snapshot — never recalculated from current settings — so later Fare Settings, Airport Fee or POI fee edits do not change it.

- Shows each payable line separately: ride fare, location discount (negative, own line), airport pick-up/drop-off fees, POI fees ("Location fee — …"), tolls, road/zone charges and time-based surcharges, followed by **Total payable**.
- Omits not-applicable lines; shows a configured £0.00 for the ride fare, airport and POI fees. Dead mileage and fixed-fare lines are never shown.
- Never shows line statuses, calculation basis, rule names or IDs, source records or Fare Settings versions.
- **Total payable** is shown only when the snapshot is complete, no line is unresolved and the saved total equals the sum of the displayed lines. Otherwise the preview is marked **Quote not yet confirmed**, shows no total and must not be sent.

This is a preview only. RideMatrix has no active customer quote delivery channel (no email or WhatsApp sending), so nothing is sent to customers.
