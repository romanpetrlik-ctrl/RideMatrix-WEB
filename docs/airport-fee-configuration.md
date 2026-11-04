# Airport fee configuration

System Settings → Toll & Fees → Airport fees stores each airport's customer-facing name, independent Google Place selections and coordinates for pickup and drop-off, and GBP amounts. Google Places must be enabled with a browser API key for location selection. The database migration retains archived records and append-only create, update, and archive audit events.

These settings are configuration only. They are not used in fares, estimates, bookings, invoices, or customer charges; pricing integration will be added with the pricing work.

## Manual verification

1. As a superuser, open **System Settings → Toll & Fees → Airport fees**. Search and select different pickup and drop-off results, enter fees (including `0.00` for one operation), and save. Confirm the airport name and both labels and amounts appear in Saved airports.
2. Edit the record, change its name or fee, and save. Confirm the saved list contains one updated record rather than a duplicate.
3. Choose Delete, cancel the confirmation, and confirm the record remains. Choose Delete again and confirm; the record should disappear from the active list.
4. For Bournemouth Airport, select **Bournemouth Airport Car Park 1** as an operational location and use **Bournemouth Airport (BOH)** as the airport display name.
