import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Buffer } from "node:buffer";
import { initializeDatabase, query } from "./connection";
import { TestDatabaseContext, createTestDatabaseContext, safeCleanupTestDatabase } from "./test-helper";
import { getFinancialBookingTotals } from "../services/customers";
import {
  MissingAuthRoleError,
  bootstrapRealInstallerSuperuser,
  completeInitialSetup,
  ensureRequiredTestRolesExist,
  saveOperatorAddress,
  saveOperatorLicence,
  saveOperatorLicenceDocument,
  saveOperatorProfile
} from "../services/system-setup";

let dbContext: TestDatabaseContext;
let previousSeedDemoData: string | undefined;

const installerActor = {
  userId: "11111111-1111-1111-1111-111111111111",
  email: "installer@ridematrix.uk",
  roles: ["admin", "superuser"]
};

async function insertRole(id: number, key: string): Promise<void> {
  await query(
    `INSERT INTO roles (id, key, description) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [id, key, key]
  );
}

async function insertRequiredRoleCatalogue(): Promise<void> {
  await insertRole(1, "admin");
  await insertRole(2, "driver");
  await insertRole(10, "superuser");
  await insertRole(11, "staff");
  await insertRole(12, "customer");
  await insertRole(13, "corporate");
  await insertRole(14, "partner");
  await insertRole(15, "tour_operator");
  await insertRole(16, "affiliate");
  await insertRole(17, "tech_support");
}

async function insertInstallerUser(): Promise<void> {
  await query(
    `INSERT INTO users (id, email, status) VALUES ($1, $2, 'Active')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [installerActor.userId, installerActor.email]
  );
}

async function insertLegacyPrivilegedTestUsers(): Promise<void> {
  await query(
    `INSERT INTO users (id, email, status) VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test.superuser@ridematrix.uk', 'Active'),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'test.admin@ridematrix.uk', 'Active')
     ON CONFLICT (id) DO NOTHING`
  );
  const superuserRole = await query<{ id: number }>(`SELECT id FROM roles WHERE key = 'superuser' LIMIT 1`);
  const adminRole = await query<{ id: number }>(`SELECT id FROM roles WHERE key = 'admin' LIMIT 1`);
  await query(
    `INSERT INTO user_roles (user_id, role_id) VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', $1),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', $2)
     ON CONFLICT DO NOTHING`,
    [superuserRole.rows[0].id, adminRole.rows[0].id]
  );
}

async function insertAuthority(): Promise<string> {
  const authorityId = "authority-setup-test";
  const now = new Date().toISOString();
  await query(
    `INSERT INTO licensing_authorities (id, name, authority_type, active, preference_order, created_at, updated_at)
     VALUES ($1, 'RideMatrix City Council', 'pho', TRUE, 1, $2, $2)
     ON CONFLICT (id) DO NOTHING`,
    [authorityId, now]
  );
  return authorityId;
}

async function insertCustomer(customerId: string): Promise<void> {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO customers
      (id, given_name, surname, preferred_contact, status, source, created_at, updated_at)
     VALUES ($1, 'Test', 'Customer', 'Email', 'Active', 'manual', $2, $2)
     ON CONFLICT (id) DO NOTHING`,
    [customerId, now]
  );
}

before(async () => {
  previousSeedDemoData = process.env.SEED_DEMO_DATA;
  process.env.SEED_DEMO_DATA = "false";
  dbContext = await createTestDatabaseContext("test_initial_setup_phase");
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

test("bootstrap requires the authenticated installer email and remains auditable", async () => {
  await insertRequiredRoleCatalogue();
  await insertInstallerUser();

  await assert.rejects(
    () =>
      bootstrapRealInstallerSuperuser({
        actor: installerActor,
        installerEmail: "someone.else@ridematrix.uk"
      }),
    /must match the currently authenticated account/
  );

  await bootstrapRealInstallerSuperuser({
    actor: installerActor,
    installerEmail: installerActor.email
  });

  const assignments = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
        AND r.key = 'superuser'`,
    [installerActor.userId]
  );
  assert.equal(assignments.rows[0].count, 1);

  const audits = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM system_setup_audit_events
      WHERE event_name = 'bootstrap_superuser_completed'`
  );
  assert.equal(audits.rows[0].count, 1);
});

test("full setup completion provisions selected production test accounts and deactivates legacy privileged test users", async () => {
  const authorityId = await insertAuthority();
  await insertLegacyPrivilegedTestUsers();

  await saveOperatorProfile(installerActor, {
    legalName: "RideMatrix Operator Ltd",
    tradingName: "RideMatrix",
    licenceHolderName: "RideMatrix Operator Ltd",
    status: "setup_required"
  });

  await saveOperatorAddress(installerActor, {
    addressType: "registered_pho",
    formattedAddress: "1 High Street, London, UK",
    houseNameNumber: "1",
    addressLine1: "High Street",
    addressLine2: null,
    addressLine3: null,
    cityTown: "London",
    county: "Greater London",
    state: null,
    postcode: "SW1A 1AA",
    countryCode: "GB",
    countryName: "United Kingdom",
    latitude: 51.501,
    longitude: -0.141,
    providerName: "manual",
    providerPlaceId: null
  });

  await saveOperatorAddress(installerActor, {
    addressType: "operational",
    formattedAddress: "5 Fleet Street, London, UK",
    houseNameNumber: "5",
    addressLine1: "Fleet Street",
    addressLine2: null,
    addressLine3: null,
    cityTown: "London",
    county: "Greater London",
    state: null,
    postcode: "EC4Y 1AA",
    countryCode: "GB",
    countryName: "United Kingdom",
    latitude: 51.513,
    longitude: -0.106,
    providerName: "manual",
    providerPlaceId: null
  });

  await saveOperatorLicence(installerActor, {
    licenceNumber: "PHO-SETUP-001",
    licensingAuthorityId: authorityId,
    validFrom: "2026-01-01",
    validTo: "2027-01-01"
  });

  await saveOperatorLicenceDocument(installerActor, {
    originalname: "pho-licence.pdf",
    mimetype: "application/pdf",
    size: 4,
    buffer: Buffer.from("test")
  });

  await completeInitialSetup(installerActor);

  const setupState = await query<{ status: string; completed_by_user_id: string | null }>(
    `SELECT status, completed_by_user_id
       FROM system_setup_state
      WHERE setup_key = 'initial_system_setup'`
  );
  assert.equal(setupState.rows[0].status, "completed");
  assert.equal(setupState.rows[0].completed_by_user_id, installerActor.userId);

  const activeTestAccounts = await query<{ role_key: string }>(
    `SELECT role_key
       FROM system_test_accounts
      WHERE active = TRUE
      ORDER BY role_key`
  );
  assert.deepEqual(activeTestAccounts.rows.map((row) => row.role_key), [
    "affiliate",
    "corporate",
    "customer",
    "driver",
    "partner",
    "staff",
    "tech_support",
    "tour_operator"
  ]);

  const privilegedAssignments = await query<{ email: string }>(
    `SELECT u.email
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id
       JOIN roles r ON r.id = ur.role_id
      WHERE lower(u.email) IN ('test.superuser@ridematrix.uk', 'test.admin@ridematrix.uk')
        AND r.key IN ('superuser', 'admin')`
  );
  assert.deepEqual(privilegedAssignments.rows, []);

  const deactivatedRegistryRows = await query<{ role_key: string; active: boolean }>(
    `SELECT role_key, active
       FROM system_test_accounts
      WHERE email_normalized_snapshot IN ('test.superuser@ridematrix.uk', 'test.admin@ridematrix.uk')
      ORDER BY role_key`
  );
  assert.ok(deactivatedRegistryRows.rows.every((row) => row.active === false));
});

test("setup fails clearly when required test-account roles are missing", async () => {
  const isolatedContext = await createTestDatabaseContext("test_missing_role_setup");
  const previousDatabaseUrl = process.env.DATABASE_URL;

  try {
    await isolatedContext.createAuthTables();
    await initializeDatabase();

    await assert.rejects(() => ensureRequiredTestRolesExist(), (error: unknown) => {
      assert.ok(error instanceof MissingAuthRoleError);
      assert.ok(error.missingRoleKeys.includes("staff"));
      return true;
    });
  } finally {
    await safeCleanupTestDatabase(isolatedContext);
    if (previousDatabaseUrl) {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
});

test("test-booking policy blocks non-test zero fares and excludes test bookings from financial aggregates", async () => {
  await insertCustomer("cust-setup-test");
  const testAccountUserIdResult = await query<{ user_id: string }>(
    `SELECT user_id FROM system_test_accounts WHERE role_key = 'customer' AND active = TRUE LIMIT 1`
  );
  const testAccountUserId = testAccountUserIdResult.rows[0].user_id;

  const now = new Date().toISOString();
  await assert.rejects(
    () =>
      query(
        `INSERT INTO customer_bookings
          (id, customer_id, reference, service_date, pickup, dropoff, status, created_at, assignment_status, total_fare_amount, is_test_booking)
         VALUES ($1, $2, 'RM-NONTEST-0', $3, 'A', 'B', 'Scheduled', $3, 'assigned', 0, FALSE)`,
        ["booking-non-test-zero", "cust-setup-test", now]
      ),
    /Non-test bookings must have a positive fare amount/
  );

  await query(
    `INSERT INTO customer_bookings
      (id, customer_id, reference, service_date, pickup, dropoff, status, created_at, total_fare_amount, is_test_booking, test_account_user_id, test_reason)
     VALUES ($1, $2, 'RM-TEST-0', $3, 'A', 'B', 'Scheduled', $3, 0, TRUE, $4, 'pricing-verification')`,
    ["booking-test-zero", "cust-setup-test", now, testAccountUserId]
  );

  await query(
    `INSERT INTO customer_bookings
      (id, customer_id, reference, service_date, pickup, dropoff, status, created_at, total_fare_amount, is_test_booking)
     VALUES ($1, $2, 'RM-REAL-10', $3, 'A', 'B', 'Scheduled', $3, 10, FALSE)`,
    ["booking-real-fare", "cust-setup-test", now]
  );

  const totals = await getFinancialBookingTotals();
  assert.equal(totals.bookingCount >= 1, true);
  assert.equal(totals.fareAmountTotal >= 10, true);
});
