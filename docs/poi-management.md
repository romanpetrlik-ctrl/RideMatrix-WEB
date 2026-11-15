# POI management

System Settings provides separate `/settings/pois` and `/settings/poi-fees` pages. Both are restricted to the existing `superuser` role.

Each POI receives an immutable RideMatrix ID. Operators configure its customer-facing display name and category independently from its selected Google Places location; the saved Place ID and coordinates are the operational navigation point. Operator notes are optional. Creating a POI does not create a fee.

POI Fees are optional records linked to an active POI by its RideMatrix ID. Each record specifies an action or service, GBP amount, explicit fee basis, and whether it applies on POI/action selection or only after explicit optional-service confirmation. Multiple fee records may link to one POI. The fee form supports optional notes or source information.

POI and POI Fee changes are retained in append-only audit tables. A POI with active fees cannot be deleted until those fees are deleted. No sample POIs or fees are seeded.

POI Fee configuration is not applied to booking prices, fare calculations, booking totals, customer charges, or payment processing. Airports and Airport Fees remain separately managed and are not migrated into the POI model.

## Manual verification

1. Sign in with a `superuser` role and open `/settings`; follow the POIs and POI Fees destinations.
2. Create and edit a POI, choose a Google Places result, and confirm the configured display name, RideMatrix ID, location label, and notes appear independently on the saved list.
3. Add two fee records for the same POI, using different actions or fee bases; try both trigger choices and confirm the fee list displays the linked POI name and ID.
4. Confirm a POI without fees can be deleted, while a POI with active fees reports that the fees must be removed first.
5. Open `/settings/toll-fees/airport-fees` and verify the existing Airport Fees records and controls remain separate; check that no POI Fee is added to booking prices.
