import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { initializeDatabase, query } from "./connection";
import { TestDatabaseContext, createTestDatabaseContext, safeCleanupTestDatabase } from "./test-helper";

let dbContext: TestDatabaseContext;
let previousSeedDemoData: string | undefined;

type NamedRow = { name: string };

async function tableColumns(tableName: string): Promise<string[]> {
  const result = await query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName]
  );
  return result.rows.map((row) => row.column_name);
}

async function primaryKeyColumns(tableName: string): Promise<string[]> {
  const result = await query<{ column_name: string }>(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = current_schema()
        AND tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
    [tableName]
  );
  return result.rows.map((row) => row.column_name);
}

async function insertOperator(id = `operator-${randomUUID()}`): Promise<string> {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO operators (
      id, legal_name, trading_name, license_holder_name, status,
      created_by_user_id, created_by_user_email, updated_by_user_id, updated_by_user_email,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, 'setup_required', $5, $6, $5, $6, $7, $7)`,
    [id, "RideMatrix Operator Ltd", "RideMatrix", "RideMatrix Operator Ltd", "user-1", "ops@example.com", now]
  );
  return id;
}

async function insertLicensingAuthority(id = `authority-${randomUUID()}`): Promise<string> {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO licensing_authorities (id, name, authority_type, active, preference_order, created_at, updated_at)
     VALUES ($1, $2, 'pho', TRUE, 0, $3, $3)`,
    [id, `Authority ${id}`, now]
  );
  return id;
}

async function insertOperatorLicence(operatorId: string, licensingAuthorityId?: string | null): Promise<string> {
  const id = `operator-licence-${randomUUID()}`;
  const now = new Date().toISOString();
  await query(
    `INSERT INTO operator_licences (
      id, operator_id, licence_type, licence_number, licensing_authority_id,
      valid_from, valid_to, status,
      created_by_user_id, created_by_user_email, updated_by_user_id, updated_by_user_email,
      created_at, updated_at
    ) VALUES ($1, $2, 'pho', $3, $4, '2026-01-01', '2027-01-01', 'active', $5, $6, $5, $6, $7, $7)`,
    [id, operatorId, `PHO-${id}`, licensingAuthorityId ?? null, "user-1", "ops@example.com", now]
  );
  return id;
}

before(async () => {
  previousSeedDemoData = process.env.SEED_DEMO_DATA;
  process.env.SEED_DEMO_DATA = "false";
  dbContext = await createTestDatabaseContext("test_operator_setup_foundation");
  await dbContext.createAuthTables();
  await initializeDatabase();
});

after(async () => {
  if (previousSeedDemoData === undefined) {
    delete process.env.SEED_DEMO_DATA;
  } else {
    process.env.SEED_DEMO_DATA = previousSeedDemoData;
  }
  await safeCleanupTestDatabase(dbContext);
});

test("operator setup foundation migration creates approved tables, columns, and primary keys", async () => {
  const expectedTables = [
    "operators",
    "operator_addresses",
    "operator_licences",
    "operator_licence_documents",
    "operator_licence_history",
    "system_setup_state"
  ];

  const tableResult = await query<NamedRow>(
    `SELECT table_name AS name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [expectedTables]
  );

  assert.deepEqual(tableResult.rows.map((row) => row.name), [...expectedTables].sort());

  const requiredColumns: Record<string, string[]> = {
    operators: [
      "id",
      "legal_name",
      "trading_name",
      "license_holder_name",
      "status",
      "created_by_user_id",
      "created_by_user_email",
      "updated_by_user_id",
      "updated_by_user_email",
      "created_at",
      "updated_at"
    ],
    operator_addresses: [
      "id",
      "operator_id",
      "address_type",
      "formatted_address",
      "house_name_number",
      "address_line1",
      "address_line2",
      "address_line3",
      "city_town",
      "county",
      "state",
      "postcode",
      "country_code",
      "country_name",
      "latitude",
      "longitude",
      "provider_name",
      "provider_place_id",
      "created_at",
      "updated_at"
    ],
    operator_licences: [
      "id",
      "operator_id",
      "licence_type",
      "licence_number",
      "licensing_authority_id",
      "valid_from",
      "valid_to",
      "status",
      "created_by_user_id",
      "created_by_user_email",
      "updated_by_user_id",
      "updated_by_user_email",
      "created_at",
      "updated_at"
    ],
    operator_licence_documents: [
      "id",
      "licence_id",
      "original_filename",
      "mime_type",
      "byte_size",
      "checksum",
      "storage_key",
      "content",
      "is_latest",
      "superseded_at",
      "uploaded_by_user_id",
      "uploaded_by_user_email",
      "uploaded_at"
    ],
    operator_licence_history: [
      "id",
      "licence_id",
      "event_type",
      "actor_user_id",
      "actor_user_email",
      "previous_status",
      "next_status",
      "summary",
      "metadata",
      "occurred_at"
    ],
    system_setup_state: [
      "id",
      "operator_id",
      "setup_key",
      "status",
      "started_at",
      "started_by_user_id",
      "started_by_user_email",
      "completed_at",
      "completed_by_user_id",
      "completed_by_user_email",
      "last_edited_at",
      "last_edited_by_user_id",
      "last_edited_by_user_email"
    ]
  };

  for (const [tableName, expected] of Object.entries(requiredColumns)) {
    const columns = await tableColumns(tableName);
    for (const column of expected) {
      assert.ok(columns.includes(column), `${tableName} should include ${column}`);
    }
    assert.deepEqual(await primaryKeyColumns(tableName), ["id"]);
  }
});

test("operator setup foundation migration remains idempotent through repeated initialization", async () => {
  await initializeDatabase();

  const migrationResult = await query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM schema_migrations WHERE id = $1",
    ["0008_operator_setup_foundation"]
  );

  assert.equal(Number(migrationResult.rows[0].count), 1);
});

test("operator addresses enforce approved address constraints without validity columns", async () => {
  const operatorId = await insertOperator();
  const now = new Date().toISOString();

  await query(
    `INSERT INTO operator_addresses (
      id, operator_id, address_type, formatted_address, house_name_number,
      address_line1, city_town, postcode, country_code, country_name,
      latitude, longitude, provider_name, provider_place_id, created_at, updated_at
    ) VALUES ($1, $2, 'registered_pho', $3, $4, $5, $6, $7, 'GB', 'United Kingdom', 51.5034, -0.1276, 'google', 'place-1', $8, $8)`,
    [`operator-address-${randomUUID()}`, operatorId, "10 Downing Street, London SW1A 2AA, UK", "10", "Downing Street", "London", "SW1A 2AA", now]
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_addresses (id, operator_id, address_type, created_at, updated_at)
       VALUES ($1, $2, 'postal', $3, $3)`,
      [`operator-address-${randomUUID()}`, operatorId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_addresses (id, operator_id, address_type, created_at, updated_at)
       VALUES ($1, $2, 'registered_pho', $3, $3)`,
      [`operator-address-${randomUUID()}`, operatorId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23505"
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_addresses (id, operator_id, address_type, country_code, created_at, updated_at)
       VALUES ($1, $2, 'operational', 'gbr', $3, $3)`,
      [`operator-address-${randomUUID()}`, operatorId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_addresses (id, operator_id, address_type, latitude, created_at, updated_at)
       VALUES ($1, $2, 'operational', 91, $3, $3)`,
      [`operator-address-${randomUUID()}`, operatorId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );

  const columns = await tableColumns("operator_addresses");
  assert.ok(!columns.includes("valid_from"));
  assert.ok(!columns.includes("valid_to"));
});

test("operator licences enforce approved type, status, and validity constraints", async () => {
  const operatorId = await insertOperator();
  const licensingAuthorityId = await insertLicensingAuthority();
  const now = new Date().toISOString();

  await query(
    `INSERT INTO operator_licences (
      id, operator_id, licence_type, licence_number, licensing_authority_id,
      valid_from, valid_to, status, created_by_user_id, created_by_user_email,
      updated_by_user_id, updated_by_user_email, created_at, updated_at
    ) VALUES ($1, $2, 'pho', 'PHO-12345', $3, '2026-01-01', '2027-01-01', 'active', 'user-1', 'ops@example.com', 'user-1', 'ops@example.com', $4, $4)`,
    [`operator-licence-${randomUUID()}`, operatorId, licensingAuthorityId, now]
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_licences (
        id, operator_id, licence_type, licence_number, valid_from, status, created_at, updated_at
      ) VALUES ($1, $2, 'hackney', 'BAD-TYPE', '2026-01-01', 'draft', $3, $3)`,
      [`operator-licence-${randomUUID()}`, operatorId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_licences (
        id, operator_id, licence_type, licence_number, valid_from, status, created_at, updated_at
      ) VALUES ($1, $2, 'pho', 'BAD-STATUS', '2026-01-01', 'pending', $3, $3)`,
      [`operator-licence-${randomUUID()}`, operatorId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_licences (
        id, operator_id, licence_type, licence_number, valid_from, valid_to, status, created_at, updated_at
      ) VALUES ($1, $2, 'pho', 'BAD-DATES', '2027-01-01', '2026-01-01', 'draft', $3, $3)`,
      [`operator-licence-${randomUUID()}`, operatorId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_licences (
        id, operator_id, licence_type, licence_number, valid_from, status, created_at, updated_at
      ) VALUES ($1, $2, 'pho', 'BAD-FORMAT', 'not-a-date', 'draft', $3, $3)`,
      [`operator-licence-${randomUUID()}`, operatorId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "22007"
  );
});

test("operator licence documents and history enforce document storage, latest uniqueness, and history constraints", async () => {
  const operatorId = await insertOperator();
  const licenceId = await insertOperatorLicence(operatorId);
  const now = new Date().toISOString();

  await query(
    `INSERT INTO operator_licence_documents (
      id, licence_id, original_filename, mime_type, byte_size, checksum,
      storage_key, content, is_latest, uploaded_by_user_id, uploaded_by_user_email, uploaded_at
    ) VALUES ($1, $2, 'pho-licence.pdf', 'application/pdf', 128, 'sha256:a', 'docs/pho-licence.pdf', NULL, TRUE, 'user-1', 'ops@example.com', $3)`,
    [`operator-licence-document-${randomUUID()}`, licenceId, now]
  );

  await query(
    `INSERT INTO operator_licence_documents (
      id, licence_id, original_filename, mime_type, byte_size, checksum,
      storage_key, content, is_latest, superseded_at, uploaded_by_user_id, uploaded_by_user_email, uploaded_at
    ) VALUES ($1, $2, 'pho-licence-old.pdf', 'application/pdf', 64, 'sha256:b', NULL, $3::bytea, FALSE, $4, 'user-1', 'ops@example.com', $4)`,
    [`operator-licence-document-${randomUUID()}`, licenceId, Buffer.from("legacy"), now]
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_licence_documents (
        id, licence_id, original_filename, mime_type, byte_size, checksum,
        is_latest, uploaded_at
      ) VALUES ($1, $2, 'missing-storage.pdf', 'application/pdf', 42, 'sha256:c', TRUE, $3)`,
      [`operator-licence-document-${randomUUID()}`, licenceId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_licence_documents (
        id, licence_id, original_filename, mime_type, byte_size, checksum,
        storage_key, is_latest, uploaded_at
      ) VALUES ($1, $2, 'empty.pdf', 'application/pdf', 0, 'sha256:zero', 'docs/empty.pdf', FALSE, $3)`,
      [`operator-licence-document-${randomUUID()}`, licenceId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_licence_documents (
        id, licence_id, original_filename, mime_type, byte_size, checksum,
        storage_key, is_latest, uploaded_at
      ) VALUES ($1, $2, 'duplicate-latest.pdf', 'application/pdf', 12, 'sha256:d', 'docs/duplicate.pdf', TRUE, $3)`,
      [`operator-licence-document-${randomUUID()}`, licenceId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23505"
  );

  await query(
    `INSERT INTO operator_licence_history (
      id, licence_id, event_type, actor_user_id, actor_user_email,
      previous_status, next_status, summary, metadata, occurred_at
    ) VALUES ($1, $2, 'document_uploaded', 'user-1', 'ops@example.com', 'draft', 'active', 'Uploaded PHO licence', $3::jsonb, $4)`,
    [`operator-licence-history-${randomUUID()}`, licenceId, JSON.stringify({ documentVersion: 1 }), now]
  );

  await assert.rejects(
    () => query(
      `INSERT INTO operator_licence_history (
        id, licence_id, event_type, summary, occurred_at
      ) VALUES ($1, $2, 'deleted', 'Invalid event', $3)`,
      [`operator-licence-history-${randomUUID()}`, licenceId, now]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );
});

test("system setup state enforces unique initial setup key and leaves legacy operator_id columns without new foreign keys", async () => {
  const operatorId = await insertOperator();
  const now = new Date().toISOString();
  const setupId = `system-setup-${randomUUID()}`;

  await query(
    `INSERT INTO system_setup_state (
      id, operator_id, setup_key, status,
      started_at, started_by_user_id, started_by_user_email,
      last_edited_at, last_edited_by_user_id, last_edited_by_user_email
    ) VALUES ($1, $2, 'initial_system_setup', 'in_progress', $3, 'user-1', 'ops@example.com', $3, 'user-1', 'ops@example.com')`,
    [setupId, operatorId, now]
  );

  await assert.rejects(
    () => query(
      `INSERT INTO system_setup_state (id, operator_id, setup_key, status)
       VALUES ($1, $2, 'initial_system_setup', 'incomplete')`,
      [`system-setup-${randomUUID()}`, operatorId]
    ),
    (error: unknown) => (error as { code?: string }).code === "23505"
  );

  await assert.rejects(
    () => query(
      `INSERT INTO system_setup_state (id, operator_id, setup_key, status)
       VALUES ($1, $2, 'secondary_setup', 'incomplete')`,
      [`system-setup-${randomUUID()}`, operatorId]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );

  await assert.rejects(
    () => query(
      `UPDATE system_setup_state
          SET status = 'pending'
        WHERE id = $1`,
      [setupId]
    ),
    (error: unknown) => (error as { code?: string }).code === "23514"
  );

  const legacyOperatorForeignKeys = await query<{ table_name: string; column_name: string }>(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = current_schema()
        AND tc.constraint_type = 'FOREIGN KEY'
        AND (
          (tc.table_name = 'customer_bookings' AND kcu.column_name = 'operator_id') OR
          (tc.table_name = 'booking_assignment_audit' AND kcu.column_name = 'operator_id') OR
          (tc.table_name = 'operator_licensing_authorities' AND kcu.column_name = 'operator_id')
        )`
  );

  assert.deepEqual(legacyOperatorForeignKeys.rows, []);

  const existingTables = await query<NamedRow>(
    `SELECT table_name AS name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [[
      "users",
      "roles",
      "permissions",
      "customers",
      "customer_bookings",
      "licensing_authorities",
      "operator_licensing_authorities",
      "booking_assignment_audit"
    ]]
  );

  assert.deepEqual(existingTables.rows.map((row) => row.name), [
    "booking_assignment_audit",
    "customer_bookings",
    "customers",
    "licensing_authorities",
    "operator_licensing_authorities",
    "permissions",
    "roles",
    "users"
  ]);

  const authRows = await dbContext.countAuthRows();
  assert.deepEqual(authRows, { users: 2, roles: 2, permissions: 2 });
});
