# Maps foundation

Google Maps Platform is the production provider. Access is isolated behind
`src/services/maps.ts` and `src/services/google-maps.ts`; callers consume
`GeoPoint`, `GeocodedAddress`, and `MapView`, never Google response objects.
The browser preview helper accepts a browser key explicitly and only loads the
Google Maps JavaScript API when a configured page opts into it.

## Configuration

Required environment variables are `GOOGLE_MAPS_ENABLED`,
`GOOGLE_MAPS_SERVER_API_KEY`, `GOOGLE_MAPS_BROWSER_API_KEY`, and
`GOOGLE_MAPS_MAP_ID`. The server key is used only by the server-side Geocoding
API adapter; the browser key is separate and may be used by the JavaScript map
component. Keys are never hard-coded or rendered as server secrets.

Enable only Geocoding API and Maps JavaScript API. Restrict the server key to
those server-side APIs and restrict the browser key by allowed HTTP referrers.
Configure billing, quotas, alerts, and budgets in Google Cloud; Google Maps is
pay-as-you-go.

## Behaviour and storage

Geocoding is explicit and must be triggered by a future form action, job, or
administrator action; it never runs on page load or every keystroke. Normalized
addresses are cached in-process, successful results are reused, and no
uncontrolled retries occur. A future persistent cache should use the existing
database migration conventions.

The `customers` table stores nullable `latitude`, `longitude`, `geocoded_at`,
and `geocode_status` fields. Provider timeouts, rate limits, malformed responses, and no-result responses
are logged without exposing provider details and return `null`. Results are
classified as exact, partial, ambiguous, or no-result. UK postcode and full
formatted address data are retained where available; broad city/region results
are not treated as exact.

## Replacing the provider

Implement `MapProvider`, validate and normalize the provider response to the
internal types, then inject the adapter into `createMapService`. Future Places,
Address Validation, and Routes APIs can be added behind the same boundary.

Route planning, navigation, live tracking, address autocomplete, and booking
route overlays are intentionally out of scope for this foundation.
