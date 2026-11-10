# Fare Settings

System Settings → Fare Settings contains editable daily fare-surcharge settings and explicit bank-holiday surcharge periods. Fixed fares, distance slabs, and extras are clearly marked placeholders and have no fare rules configured. Access remains limited to the existing System Settings role.

Daily windows repeat each day and use operator-entered times and percentage. A start later than the end represents a window crossing midnight; the interval is start-inclusive and end-exclusive. Both surcharge types use `Europe/London` and are associated with the scheduled service/pick-up time, not booking creation time. Bank-holiday periods use explicit local dates and times, may span multiple days, and cannot overlap. No calendar or holiday-name inference is performed.

When an enabled bank-holiday period applies, its surcharge takes precedence over the recurring daily surcharge; the two are not combined. This precedence, time basis, time zone, and interval convention are stored in the configuration snapshots for future pricing integration.

Migration `0026_fare_settings` creates a disabled configuration with no assumed percentages or times. Saves update the current configuration and append actor-attributed snapshots to `fare_settings_history`; the history table rejects updates and deletes. These forms are configuration only: they do not calculate fares, modify booking totals, or alter Toll & Fees behavior.

## Manual verification

1. As a superuser, open **System Settings → Fare Settings** and confirm all five categories are listed. Open Fixed fares, Distance slabs, and Extras and confirm each is a future-configuration placeholder.
2. Open **Fare surcharge settings**, enable it, enter an operator-selected percentage and a window such as `23:00`–`06:00`, and save. Confirm the saved values and configuration-history version appear. Disable the rule and save; verify its saved values remain visible while the rule is disabled.
3. Open **Bank holiday fare settings**, enable the setting, and add two explicit periods. For example, enter 24 December 2026 18:00–27 December 2026 06:00 and 31 December 2026 18:00–2 January 2027 06:00 with operator-selected labels and percentages. Save, edit one period, remove the other, and save again.
4. Try an invalid calendar date, an end before its start, and overlapping periods; each should be rejected with a visible error. Confirm the page explains bank-holiday precedence over the recurring surcharge.
5. Confirm no fare calculation or booking-total behavior is present or changed.
