# System setup wizard

The setup wizard is available at `/setup` to an authenticated setup administrator. Before bootstrap, `INITIAL_SETUP_ALLOWED_EMAILS` may authorize the installer account; after bootstrap, access is limited to the bootstrap installer administrator or a superuser.

## Manual verification on a fresh test database

Use an isolated PostgreSQL database and set `TEST_DATABASE_URL` to that database. Do not point setup tests or manual verification at production. With `TEST_DATABASE_URL` configured, run `npx tsx --test --test-concurrency=1 src/routes/setup-journey.integration.test.ts src/routes/setup-names.integration.test.ts` to verify the persisted wizard journey and bootstrap authorization.

For browser verification, start the application against a newly migrated test database, provision the auth roles required by the setup and system test accounts, and sign in with an authorized installer. Set `INITIAL_SETUP_ALLOWED_EMAILS` to that installer email before bootstrap and configure `GOOGLE_MAPS_ENABLED=true`, `GOOGLE_MAPS_BROWSER_API_KEY`, `GOOGLE_MAPS_SERVER_API_KEY`, and Places API access for both keys. In the registered address step, enter the structured fields without a formatted-address field, save, revisit the step, and confirm the values are prefilled and the composed address is stored. In the operational address step, confirm autocomplete suggestions are UK-restricted, select a UK Place, and verify its structured address, Place ID, and server-verified coordinates are saved. Also try a non-UK Place ID in a request and confirm the server rejects it even if the submitted country says `GB`. If Places cannot be used, enter the structured operational address manually and confirm the address saves without coordinates or a Place ID and dead-mileage radius remains unavailable. Then enter the PHO licence number, authority, and validity dates; upload a PDF, PNG, or JPEG licence document no larger than 10 MB; then review and confirm. Verify the operator, both addresses, licence, document, setup-step rows, and audit history are saved.

Submit an incomplete operator profile, an operational address with missing required structured fields, invalid licence dates, and an unsupported or oversized upload during this test. Each should remain on its step with an explanatory error, retain submitted values, and save no invalid record. Revisit saved earlier steps before completion to confirm their values are prefilled.

## Safely viewing a completed setup

Use an already-authorized setup administrator and make GET requests only to `/setup`, `/setup/completed`, or another setup step. `/setup` and incomplete-step URLs redirect to the completed page when setup is locked. Do not submit a form, call a state-changing setup endpoint, clear setup tables, or run a reset/reseed operation. Viewing the completed page does not alter setup records or audit history.

## PHO licence status after completion

Completing the setup wizard sets the PHO `operator_licences` row to `active` in the same transaction and writes an `operator_licence_activated` audit event. Booking assignment only offers drivers and vehicles while a PHO licence is `active`, its authority is active, its dates cover the service date, and it has a latest document. A licence left in `draft` (for example, one saved before its document was uploaded) gives an empty assignment page with an explanatory message.

## Editing the operator and licence after setup

After completion, admins with System settings access can edit the operator profile, both addresses, and the PHO licence at `/settings/operator` (the "Operator & licence" button in System settings). These edits use the same validation as the wizard and bypass only the wizard lock. The licence stays `active` only while its authority is active and its latest document has stored content (`content IS NOT NULL`, the same rule booking assignment uses); otherwise it is set to `draft` and the page shows the reason. Each licence status change is recorded in `operator_licence_history`, and each save is recorded in the system setup audit events. Every save also appends a full snapshot (operator, addresses, PHO licences) to the append-only `operator_configuration_history` table with the change type and actor. The operator's `trial` status is not changed by these edits.
