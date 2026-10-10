import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, initializeDatabase, query  } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext, safeCleanupTestDatabase } from "../database/test-helper";
import {
  STAFF_MANAGEMENT_ROLES,
  canManageStaff,
  getStaffUser,
  hasManageUsersPermission,
  isValidStaffAccountId,
  listStaffLoginAuditEvents,
  listStaffUsers,
  resetStaffSchemaCacheForTests
} from "./staff";

let dbContext: TestDatabaseContext;

const ROLE_IDS = {
  admin: 1,
  driver: 2,
  staff: 3,
  tech_support: 4,
  superuser: 6,
  customer: 7,
  partner: 8
};

const PERMISSION_IDS = {
  view_dashboard: 1,
  manage_users: 2
};

before(async () => {
  dbContext = await createTestDatabaseContext("test_staff");
  // Set up existing auth tables first to simulate a pre-existing production database.
  await dbContext.createAuthTables();
  await initializeDatabase();
  resetStaffSchemaCacheForTests();

  // createAuthTables only seeds "admin" and "driver" roles plus two demo users
  // with no role assignments. Extend the schema with the remaining internal
  // roles and role_permissions used by production, plus fixtures covering
  // every classification case this feature must handle correctly.
  await query(
    `INSERT INTO roles (id, key, description) VALUES
      ($1, 'staff', 'Staff'),
      ($2, 'tech_support', 'Technical Support'),
      ($3, 'superuser', 'Superuser'),
      ($4, 'customer', 'Customer'),
      ($5, 'partner', 'Partner')
     ON CONFLICT (id) DO NOTHING`,
    [
      ROLE_IDS.staff,
      ROLE_IDS.tech_support,
      ROLE_IDS.superuser,
      ROLE_IDS.customer,
      ROLE_IDS.partner
    ]
  );

  // Grant the admin role manage_users, mirroring the production permission model.
  await query(
    `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [ROLE_IDS.admin, PERMISSION_IDS.manage_users]
  );

  await query(
    `INSERT INTO users (id, email, status) VALUES
      ('b0000000-0000-0000-0000-000000000001', 'staff.only@ridematrix.com', 'Active'),
      ('b0000000-0000-0000-0000-000000000002', 'multi.role@ridematrix.com', 'Active'),
      ('b0000000-0000-0000-0000-000000000003', 'customer.only@ridematrix.com', 'Suspended'),
      ('b0000000-0000-0000-0000-000000000004', 'partner.only@ridematrix.com', 'Active'),
      ('b0000000-0000-0000-0000-000000000005', 'staff.and.customer@ridematrix.com', 'Active')
     ON CONFLICT (id) DO NOTHING`
  );

  // admin@ridematrix.com (seeded by createAuthTables) -> admin
  // driver@ridematrix.com (seeded by createAuthTables) -> driver
  // staff.only -> staff
  // multi.role -> staff + tech_support
  // customer.only -> customer (must be excluded from staff list)
  // partner.only -> partner (must be excluded from staff list)
  // staff.and.customer -> staff + customer (must appear once, with both roles)
  await query(
    `INSERT INTO user_roles (user_id, role_id) VALUES
      ('a0000000-0000-0000-0000-000000000001', $1),
      ('a0000000-0000-0000-0000-000000000002', $2),
      ('b0000000-0000-0000-0000-000000000001', $3),
      ('b0000000-0000-0000-0000-000000000002', $3),
      ('b0000000-0000-0000-0000-000000000002', $4),
      ('b0000000-0000-0000-0000-000000000003', $5),
      ('b0000000-0000-0000-0000-000000000004', $6),
      ('b0000000-0000-0000-0000-000000000005', $3),
      ('b0000000-0000-0000-0000-000000000005', $5)
     ON CONFLICT DO NOTHING`,
    [
      ROLE_IDS.admin,
      ROLE_IDS.driver,
      ROLE_IDS.staff,
      ROLE_IDS.tech_support,
      ROLE_IDS.customer,
      ROLE_IDS.partner
    ]
  );
});

after(async () => {
  await safeCleanupTestDatabase(dbContext);
});

test("STAFF_MANAGEMENT_ROLES does not include customer or partner", () => {
  assert.equal(STAFF_MANAGEMENT_ROLES.includes("customer" as never), false);
  assert.equal(STAFF_MANAGEMENT_ROLES.includes("partner" as never), false);
});

test("listStaffUsers includes internal users and excludes customer/partner-only users", async () => {
  const staff = await listStaffUsers();
  const emails = staff.map((member) => member.email).sort();

  assert.deepEqual(emails, [
    "admin@ridematrix.com",
    "driver@ridematrix.com",
    "multi.role@ridematrix.com",
    "staff.and.customer@ridematrix.com",
    "staff.only@ridematrix.com"
  ]);

  assert.ok(!emails.includes("customer.only@ridematrix.com"));
  assert.ok(!emails.includes("partner.only@ridematrix.com"));
});

test("listStaffUsers never duplicates a user with multiple roles and shows every assigned role once", async () => {
  const staff = await listStaffUsers();
  const multiRole = staff.filter((member) => member.email === "multi.role@ridematrix.com");

  assert.equal(multiRole.length, 1);
  assert.deepEqual(multiRole[0].roles.slice().sort(), ["staff", "tech_support"]);

  // A user with a mix of a staff-qualifying role and a non-staff role must
  // still appear exactly once, with all roles (not only the staff one).
  const mixed = staff.filter((member) => member.email === "staff.and.customer@ridematrix.com");
  assert.equal(mixed.length, 1);
  assert.deepEqual(mixed[0].roles.slice().sort(), ["customer", "staff"]);
});

test("listStaffUsers returns email, status and created date, with a safe null for last login when unavailable", async () => {
  const staff = await listStaffUsers();
  const staffOnly = staff.find((member) => member.email === "staff.only@ridematrix.com");

  assert.ok(staffOnly);
  assert.equal(staffOnly?.status, "Active");
  assert.ok(staffOnly?.createdAt);
  // The shared test schema has no last-login column, so the service must not
  // invent a value; it must resolve to null rather than throwing.
  assert.equal(staffOnly?.lastLoginAt, null);
});

test("listStaffUsers reads an existing last-login column when the schema provides one", async () => {
  await query(`ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP`);
  await query(
    `UPDATE users SET last_login_at = $1 WHERE email = 'staff.only@ridematrix.com'`,
    ["2024-05-01T10:00:00.000Z"]
  );
  resetStaffSchemaCacheForTests();

  try {
    const staff = await listStaffUsers();
    const staffOnly = staff.find((member) => member.email === "staff.only@ridematrix.com");
    assert.ok(staffOnly?.lastLoginAt);
    assert.equal(new Date(staffOnly!.lastLoginAt as string).toISOString(), "2024-05-01T10:00:00.000Z");
  } finally {
    await query(`ALTER TABLE users DROP COLUMN last_login_at`);
    resetStaffSchemaCacheForTests();
  }
});

async function insertAuditEvent(event: {
  id: string;
  occurredAt: string;
  eventName?: string;
  accountId?: string | null;
  loginIdentifier?: string | null;
  success: boolean;
  failureCategory?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO staff_login_audit
      (id, occurred_at, event_name, account_id, login_identifier, success, failure_category, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      event.id,
      event.occurredAt,
      event.eventName ?? (event.success ? "staff_login_succeeded" : "staff_login_failed"),
      event.accountId ?? null,
      event.loginIdentifier ?? null,
      event.success,
      event.failureCategory ?? null,
      event.ipAddress ?? null,
      event.userAgent ?? null
    ]
  );
}

const STAFF_ONLY_ID = "b0000000-0000-0000-0000-000000000001";
const MULTI_ROLE_ID = "b0000000-0000-0000-0000-000000000002";

test("listStaffUsers derives last login from the latest successful staff_login_audit event", async () => {
  await insertAuditEvent({ id: "evt-1", occurredAt: "2025-01-01T08:00:00.000Z", accountId: STAFF_ONLY_ID, success: true });
  await insertAuditEvent({ id: "evt-2", occurredAt: "2025-03-01T08:00:00.000Z", accountId: STAFF_ONLY_ID, success: true });
  // Later failures must not count as a login.
  await insertAuditEvent({
    id: "evt-3",
    occurredAt: "2025-04-01T08:00:00.000Z",
    accountId: STAFF_ONLY_ID,
    success: false,
    failureCategory: "unauthorized"
  });
  // Another user's events must never leak into this user's last login.
  await insertAuditEvent({ id: "evt-4", occurredAt: "2025-06-01T08:00:00.000Z", accountId: MULTI_ROLE_ID, success: true });

  try {
    const staff = await listStaffUsers();
    const staffOnly = staff.find((member) => member.email === "staff.only@ridematrix.com");
    const multiRole = staff.find((member) => member.email === "multi.role@ridematrix.com");
    const admin = staff.find((member) => member.email === "admin@ridematrix.com");

    assert.equal(staffOnly?.lastLoginAt, "2025-03-01T08:00:00.000Z");
    assert.equal(multiRole?.lastLoginAt, "2025-06-01T08:00:00.000Z");
    assert.equal(admin?.lastLoginAt, null);
  } finally {
    await query(`DELETE FROM staff_login_audit`);
  }
});

test("listStaffUsers falls back to normalized email only for audit events without an account id", async () => {
  await insertAuditEvent({
    id: "evt-email-1",
    occurredAt: "2025-02-01T08:00:00.000Z",
    accountId: null,
    loginIdentifier: "  STAFF.Only@RideMatrix.com ",
    success: true
  });
  // An event attributed to a different account id must not match by email.
  await insertAuditEvent({
    id: "evt-email-2",
    occurredAt: "2025-09-01T08:00:00.000Z",
    accountId: "some-other-account",
    loginIdentifier: "staff.only@ridematrix.com",
    success: true
  });

  try {
    const staff = await listStaffUsers();
    const staffOnly = staff.find((member) => member.email === "staff.only@ridematrix.com");
    assert.equal(staffOnly?.lastLoginAt, "2025-02-01T08:00:00.000Z");
  } finally {
    await query(`DELETE FROM staff_login_audit`);
  }
});

test("listStaffUsers uses the most recent of the users last-login column and the audit table", async () => {
  await query(`ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ`);
  await query(`UPDATE users SET last_login_at = $1 WHERE email = 'staff.only@ridematrix.com'`, [
    "2025-05-01T10:00:00.000Z"
  ]);
  await query(`UPDATE users SET last_login_at = $1 WHERE email = 'multi.role@ridematrix.com'`, [
    "2025-01-01T10:00:00.000Z"
  ]);
  await insertAuditEvent({ id: "evt-mix-1", occurredAt: "2025-04-01T08:00:00.000Z", accountId: STAFF_ONLY_ID, success: true });
  await insertAuditEvent({ id: "evt-mix-2", occurredAt: "2025-07-01T08:00:00.000Z", accountId: MULTI_ROLE_ID, success: true });
  resetStaffSchemaCacheForTests();

  try {
    const staff = await listStaffUsers();
    assert.equal(
      staff.find((member) => member.email === "staff.only@ridematrix.com")?.lastLoginAt,
      "2025-05-01T10:00:00.000Z"
    );
    assert.equal(
      staff.find((member) => member.email === "multi.role@ridematrix.com")?.lastLoginAt,
      "2025-07-01T08:00:00.000Z"
    );
  } finally {
    await query(`DELETE FROM staff_login_audit`);
    await query(`ALTER TABLE users DROP COLUMN last_login_at`);
    resetStaffSchemaCacheForTests();
  }
});

test("listStaffUsers ignores malformed audit timestamps instead of failing", async () => {
  await insertAuditEvent({ id: "evt-bad", occurredAt: "not-a-date", accountId: STAFF_ONLY_ID, success: true });
  await insertAuditEvent({ id: "evt-bad-2", occurredAt: "2025-13-45T99:00:00.000Z", accountId: STAFF_ONLY_ID, success: true });
  await insertAuditEvent({ id: "evt-bad-3", occurredAt: "9999-99-99", accountId: MULTI_ROLE_ID, success: true });
  await insertAuditEvent({ id: "evt-good", occurredAt: "2025-02-01T08:00:00.000Z", accountId: MULTI_ROLE_ID, success: true });

  try {
    const staff = await listStaffUsers();
    assert.equal(staff.find((member) => member.email === "staff.only@ridematrix.com")?.lastLoginAt, null);
    assert.equal(
      staff.find((member) => member.email === "multi.role@ridematrix.com")?.lastLoginAt,
      "2025-02-01T08:00:00.000Z"
    );

    const events = await listStaffLoginAuditEvents({ id: MULTI_ROLE_ID, email: "multi.role@ridematrix.com" });
    assert.deepEqual(
      events.map((event) => event.id),
      ["evt-good", "evt-bad-3"],
      "malformed timestamps are listed after valid events"
    );
    assert.equal(events[1].occurredAt, null);
  } finally {
    await query(`DELETE FROM staff_login_audit`);
  }
});

test("getStaffUser validates ids and returns only internal staff users", async () => {
  assert.equal(isValidStaffAccountId(STAFF_ONLY_ID), true);
  assert.equal(isValidStaffAccountId("../etc/passwd"), false);
  assert.equal(isValidStaffAccountId("1' OR '1'='1"), false);
  assert.equal(isValidStaffAccountId(""), false);
  assert.equal(isValidStaffAccountId("x".repeat(65)), false);

  assert.equal((await getStaffUser(STAFF_ONLY_ID))?.email, "staff.only@ridematrix.com");
  assert.equal(await getStaffUser("b0000000-0000-0000-0000-000000000003"), null, "customer-only users are not staff");
  assert.equal(await getStaffUser("ffffffff-0000-0000-0000-000000000000"), null);
  assert.equal(await getStaffUser("1' OR '1'='1"), null);
});

test("listStaffLoginAuditEvents returns only the selected account's events, newest first", async () => {
  await insertAuditEvent({
    id: "evt-a",
    occurredAt: "2025-01-01T08:00:00.000Z",
    accountId: STAFF_ONLY_ID,
    loginIdentifier: "staff.only@ridematrix.com",
    success: true,
    ipAddress: "203.0.113.5",
    userAgent: "UA-1"
  });
  await insertAuditEvent({
    id: "evt-b",
    occurredAt: "2025-01-02T08:00:00.000Z",
    accountId: STAFF_ONLY_ID,
    success: false,
    failureCategory: "unauthorized"
  });
  await insertAuditEvent({
    id: "evt-c",
    occurredAt: "2025-01-03T08:00:00.000Z",
    accountId: null,
    loginIdentifier: "Staff.Only@ridematrix.com",
    success: false,
    failureCategory: "invalid_credentials"
  });
  await insertAuditEvent({ id: "evt-other", occurredAt: "2025-01-04T08:00:00.000Z", accountId: MULTI_ROLE_ID, success: true });
  await insertAuditEvent({
    id: "evt-anon",
    occurredAt: "2025-01-05T08:00:00.000Z",
    accountId: null,
    loginIdentifier: null,
    success: false,
    failureCategory: "unauthorized"
  });

  try {
    const events = await listStaffLoginAuditEvents({ id: STAFF_ONLY_ID, email: "staff.only@ridematrix.com" });
    assert.deepEqual(
      events.map((event) => event.id),
      ["evt-c", "evt-b", "evt-a"]
    );
    assert.equal(events[2].success, true);
    assert.equal(events[2].ipAddress, "203.0.113.5");
    assert.equal(events[2].userAgent, "UA-1");
    assert.equal(events[1].failureCategory, "unauthorized");
    assert.equal("loginIdentifier" in events[0], false);
  } finally {
    await query(`DELETE FROM staff_login_audit`);
  }
});

test("hasManageUsersPermission checks role_permissions/permissions and is false with no matching grant", async () => {
  assert.equal(await hasManageUsersPermission(["admin"]), true);
  assert.equal(await hasManageUsersPermission(["driver"]), false);
  assert.equal(await hasManageUsersPermission([]), false);
});

test("canManageStaff prefers manage_users permission with an admin/superuser fallback", async () => {
  assert.equal(await canManageStaff(["admin"]), true);
  // superuser has no explicit role_permissions row in this fixture, but the
  // documented safe fallback still authorizes it.
  assert.equal(await canManageStaff(["superuser"]), true);
  assert.equal(await canManageStaff(["staff"]), false);
  assert.equal(await canManageStaff(["customer"]), false);
  assert.equal(await canManageStaff([]), false);
});
