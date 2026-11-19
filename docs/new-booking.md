# New Booking

`GET /bookings/new` (optionally `?customerId=<id>`, used by the customer **New booking** action) is a desktop-first dispatcher form. It requires the same `admin` role as `/customers`. All POSTs use the global CSRF protection; `POST /bookings/quote` returns JSON and `POST /bookings` saves. A saved booking opens at `GET /bookings/:id`.

## Blocks

1. **Booking reference** – the booking ID (`RM-` reference from the `new_booking_reference` sequence), creation time and the signed-in staff member are assigned by the server on save. Before saving the page shows "Assigned on save".
2. **Booking manager and passenger** – the manager is selected from active existing customers (business customers use their booker contact). Name, phone and email are prefilled and editable. With **Passenger is booking manager** ticked, the passenger name/phone are read-only and follow the manager fields; the server re-copies them on save. Unticking restores the passenger's own independently typed values.
3. **Journey details and map** – service date and a 24-hour `HH:mm` time in five-minute steps, interpreted in `Europe/London`. Pickup, drop-off and up to two optional Via stops (hidden until **Add Via stop**) can each be a managed Airport (Airport Fees record), a managed POI, or an address. Airport/POI stops store their internal RideMatrix ID and configured coordinates; addresses store the Google place ID, verified coordinates and structured postcode. An address without a verified place is kept but marked unverified, and the route is then unresolved. The route summary and map show the ordered route (pickup → via 1 → via 2 → drop-off) from Google Routes (`GOOGLE_MAPS_SERVER_API_KEY`): total miles, time on road, provider-reported tolls, and detected London ULEZ / Congestion Charge zone entry. Without a usable route the summary says **Unresolved** and no distance, duration or toll status is shown.
4. **Passengers and luggage** – Adults, Children, sports equipment, XL, L, CB/HB and BP counts (0–7, default 0), child-seat and booster flags, and a live cargo summary.
5. **Fare and itemized breakdown** – one row per charge with a status of **Applied**, **Configured £0.00**, **Not applicable** or **Unresolved**, its basis, and amount. **Total payable** appears last and only when no line is unresolved; otherwise it reads **Not confirmed**.

## Pricing (`src/services/booking-pricing.ts`)

Each line is separate and fees are never folded into the ride fare.

- **Ride fare** – standard Distance Slabs over the passenger route miles (progressive, start-inclusive slabs, open-ended final slab, prorated fractional miles, one final rounding). An enabled minimum-fare rule applies only when the pickup or drop-off is that exact managed Airport/POI ID: `ride fare = max(slabs fare, minimum)`. Via stops do not trigger minimums or fees. Additional distance slab sets are not used.
- **Location discount** – `resolveJourneyLocationDiscount`: an active operational-base radius rule for the endpoint's managed ID takes exclusive precedence (inside the radius only the radius discount, outside it no discount and no postcode fallback); otherwise postcode rules apply. One discount at most, applied to the ride fare only.
- **Airport pick-up fee / Airport drop-off fee** – from the exact selected Airport Fees record when it is the pickup or drop-off. A saved `0.00` is shown as **Configured £0.00**.
- **POI fees** – only fees configured for the exact selected POI ID. Automatic triggers apply when the POI is the pickup or drop-off; confirmation-triggered fees apply only when the dispatcher ticks them.
- **Unresolved charge types** – the application has no reliable rate source for these, so they are never estimated:
  - tolls reported by the route (no toll schedule);
  - ULEZ / Congestion Charge (London fee schedules are drafts only);
  - parking and extra waiting time when requested (no rate configuration);
  - daily/bank-holiday surcharges and fixed fares that match the journey (their booking basis is not defined);
  - dead mileage (assessed on the booking assignment page).
  If one of these applies, or the route or required configuration is missing, the price is **incomplete**.

## Saving

The server re-validates every field and recalculates the price. The save is rejected (409) when the result differs from the quote the dispatcher last saw. An incomplete price can only be saved when **Save with price unresolved** is ticked; the booking then has no total (`price_status = 'incomplete'`).

Migration `0033_new_booking_price_snapshots` adds booking-manager, passenger, service-time, cargo and creator columns to `customer_bookings`, plus `booking_journey_stops`, `booking_price_snapshots` and `booking_price_line_items`. The booking, its stops, the snapshot and every line item are written in one transaction. The snapshot stores the pricing inputs, route result, Fare Settings version and each line's basis and source rule/record IDs, so later settings edits do not change a saved booking. Database triggers reject updates and deletes on snapshots and line items. Existing bookings are not modified.
