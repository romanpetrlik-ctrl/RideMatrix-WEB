# London Congestion Charge reference boundary

The canonical, read-only GeoJSON is
`src/reference-data/toll-fees/london-congestion-charge/boundary.geojson`. It
retains the two supplied Polygon features, their IDs, source properties, and
coordinates without simplification or transformation.

The supplied filename contains `2027`, but no effective date is stated or
inferred from that filename. The source URL, archive, licence, and verification
date were not provided; the application marks them as not provided or
unverified. The dataset is versioned in the repository and served only through
the authenticated System Settings reference-data route. It is not downloaded
at runtime.

This reference dataset is separate from London Congestion Charge fee settings.
No fee schedule is configured, and the boundary does not calculate fees or
charge customers. The page does not require a map to display or load the data.

`npm run build` packages the canonical file at
`dist/reference-data/toll-fees/london-congestion-charge/boundary.geojson`.
