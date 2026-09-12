# Multi-licensing authorities

Licensing authority is a first-class attribute of an assigned booking. An
operator, driver, and vehicle may each hold multiple historical license
records, but an assignment is valid only when all three have a non-revoked,
active record covering the booking service time. The authority intersection is
resolved by `resolveCompatibleLicensingAuthorities`; assignments choose the
lowest configured `preference_order`, then name and stable id.

Authorities and license records are configuration data, not dispatch constants.
The operator, vehicle, and driver relationship tables preserve validity history.
Revoking or expiring a record prevents future assignments but never rewrites the
authority stored on a completed or historical booking. Existing assigned
bookings can be marked for review with `flagBookingForLicensingReview`.

Imported bookings remain `unassigned` with a null authority until reliable
operator, driver, and vehicle data is assigned through the same compatibility
service. Import free text must not be used to guess an authority. Legacy rows
are intentionally unresolved and can be reported with:

```sql
SELECT id, reference, service_date
FROM customer_bookings
WHERE licensing_authority_id IS NULL;
```

Administrators should create authorities (for example, BCP Council and Dorset
Council), then add dated operator, vehicle, and driver license records. The
booking's stored authority is historical data and is displayed independently
from current license configuration.
