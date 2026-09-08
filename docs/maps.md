# Maps foundation

Map and geocoding access is isolated behind `src/services/maps.ts`. Routes and
views consume `GeoPoint`, `GeocodedAddress`, and `MapView` data rather than
provider response objects. No external provider is selected in this
repository; the default implementation is a safe disabled provider.

## Configuration

Set these environment variables when a provider adapter is added:

- `MAP_PROVIDER`
- `MAP_API_KEY`
- `MAP_GEOCODING_ENABLED=true`
- `MAP_DEFAULT_LATITUDE` and `MAP_DEFAULT_LONGITUDE` (optional fallback)

Production API credentials must be supplied through environment variables and
must never be committed or rendered into browser HTML.

## Behaviour and storage

Geocoding is explicit and must be triggered by a future form action, job, or
administrator action; this foundation does not geocode on page load or every
keystroke. Customer coordinates and status metadata are nullable, so missing
or failed geocoding never prevents customer creation or editing.

The `customers` table stores nullable `latitude`, `longitude`, `geocoded_at`,
and `geocode_status` fields. Provider timeouts, rate limits, malformed
responses, and no-result responses are logged without exposing provider
details and return `null`.

## Replacing the provider

Implement `MapProvider`, validate and normalize the provider response to the
internal types, then inject the adapter into `createMapService`. Provider
selection remains behind the service and callers should only use its
provider-neutral methods.

Route planning, navigation, live tracking, address autocomplete, and booking
route overlays are intentionally out of scope for this foundation.
