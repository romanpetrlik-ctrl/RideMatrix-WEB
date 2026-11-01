# London ULEZ reference boundary

The canonical, read-only GeoJSON is
`src/reference-data/toll-fees/london-ulez/boundary.geojson`. It is the supplied
`London_ULEZ_Boundary.geojson` export, retained without rewriting its 22
features, IDs, properties, or coordinates. The export contains 21 `Polygon`
features and one `MultiPolygon` feature.

The source properties retain `DATASET=Low Emission Zone` and
`DATE_CREAT=20071113`. The source label is not rewritten: the ULEZ is a
distinct RideMatrix scheme, and its feature geometries match the existing LEZ
reference data. This copy remains separate so each scheme retains its own
source feature identifiers and metadata. `DATE_CREAT` is displayed only as
source metadata; it is not an effective-from date.

The supplied export does not provide a source URL, source archive, licence,
effective date, or verification date. Those fields are explicitly shown as
not provided or unverified. The packaged data is served only through the
authenticated System Settings reference-data route; it is not fetched
externally. ULEZ fee settings remain unconfigured and do not calculate or
charge fees.

`npm run build` packages the canonical GeoJSON at
`dist/reference-data/toll-fees/london-ulez/boundary.geojson`.
