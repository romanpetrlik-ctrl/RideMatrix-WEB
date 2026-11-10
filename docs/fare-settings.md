# Fare Settings

System Settings → Fare Settings contains an editable shared base distance-rate table, daily fare-surcharge settings, and explicit bank-holiday surcharge periods. Fixed fares and extras remain future-configuration placeholders. Access remains limited to the existing System Settings role.

Distance slabs are progressive GBP-per-mile bands shared by all vehicle categories. The first slab starts at 0 miles; bands are contiguous and start-inclusive/end-exclusive, and the final slab is open-ended. A journey charges each portion at the rate for that band. Distances and rates are parsed as decimal strings and calculated with integer arithmetic; only the final amount is rounded to the nearest penny, with exact half-pennies rounded up. The live test-distance display is an unsaved settings preview only, not a booking quote. No rates are seeded, and no booking-price calculation or vehicle-category uplift is connected.

Daily windows repeat each day and use operator-entered times and percentage. A start later than the end represents a window crossing midnight; the interval is start-inclusive and end-exclusive. Both surcharge types use `Europe/London` and are associated with the scheduled service/pick-up time, not booking creation time. Bank-holiday periods use explicit local dates and times, may span multiple days, and cannot overlap. No calendar or holiday-name inference is performed.

When an enabled bank-holiday period applies, its surcharge takes precedence over the recurring daily surcharge; the two are not combined. This precedence, time basis, time zone, and interval convention are stored in the configuration snapshots for future pricing integration.

Migration `0026_fare_settings` creates a disabled configuration with no assumed percentages or times. Migration `0027_fare_settings_distance_slabs` adds an empty slab list to existing current configuration only; it does not add example rates or rewrite history. Saves update the current configuration and append actor-attributed snapshots to `fare_settings_history`; the history table rejects updates and deletes. These forms are configuration only: the distance settings preview does not calculate booking fares, modify booking totals, or alter Toll & Fees behavior.

## Manual verification

1. As a superuser, open **System Settings → Fare Settings** and confirm all five categories are listed. Open Fixed fares and Extras and confirm each remains a future-configuration placeholder.
2. Open **Fare surcharge settings**, enable it, enter an operator-selected percentage and a window such as `23:00`–`06:00`, and save. Confirm the saved values and configuration-history version appear. Disable the rule and save; verify its saved values remain visible while the rule is disabled.
3. Open **Bank holiday fare settings**, enable the setting, and add two explicit periods. For example, enter 24 December 2026 18:00–27 December 2026 06:00 and 31 December 2026 18:00–2 January 2027 06:00 with operator-selected labels and percentages. Save, edit one period, remove the other, and save again.
4. Try an invalid calendar date, an end before its start, and overlapping periods; each should be rejected with a visible error. Confirm the page explains bank-holiday precedence over the recurring surcharge.
5. On **Distance slabs**, enter `0`–`10` at `3.00` and `10`–open-ended at `2.70`; set the test distance to `12` and `12.4` and confirm previews of `£35.40` and `£36.48`. Edit a rate without saving and verify the preview updates immediately. Add, remove, and save slabs, then confirm saved rows and configuration history.
6. Try a non-zero first start, a gap, an overlap, a missing final end, an interior open end, a negative/malformed value, and an empty rate; each should be rejected with a field-level error. Confirm the last slab is marked open-ended.
7. Confirm no fare calculation or booking-total behavior is present or changed.
