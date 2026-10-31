# London LEZ reference boundary

The canonical, read-only GeoJSON is
`src/reference-data/toll-fees/london-lez/boundary.geojson`. Its source archive
is retained at
`docs/reference-data/london-lez/LEZ_Boundary_20211026_Shape_Files.zip` for
provenance. The GeoJSON is the supplied cleaned 22-feature boundary; the
source shapefile records use EPSG:27700 and the displayed GeoJSON coordinates
are WGS 84 longitude/latitude.

The source archive/version date is **2021-10-26** (the supplied archive
filename). The source features retain `DATE_CREAT=20071113` (**2007-11-13**).
The geometry was verified as current on **2026-10-31**; this verification date
does not replace either source date. The archive's ArcGIS metadata separately
records a creation date of 2021-06-08 and sync/modified date of 2021-10-25.

Source: [TfL boundaries directory](https://roads.data.tfl.gov.uk/#!boundaries%2F).
Terms: [TfL Transport Data Service terms](https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service).
Required attribution: **Powered by TfL Open Data**.

The runtime GeoJSON is packaged by `npm run build` into
`dist/reference-data/toll-fees/london-lez/boundary.geojson` and served only
through the authenticated System Settings route. It is not downloaded from
TfL at runtime and is not stored in a user-upload directory.

Future boundary updates must be reviewed and delivered as a repository patch
that updates the canonical GeoJSON, source archive, and version metadata
together. Deploy the reviewed change to each VPS through the normal pull and
rebuild process. GitHub is the sole source of truth; do not maintain a
separate VPS copy or add an independent remote updater.
