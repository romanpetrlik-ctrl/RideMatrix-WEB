import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import {
  STAFF_MANAGEMENT_ROLES,
  canManageStaff,
  hasManageUsersPermission,
  listStaffUsers,
  resetStaffSchemaCacheForTests
} from "./staff";

let dbContext: TestDatabaseContext;

const ROLE_IDS = {
  admin: 1,
  driver: 2,
  staff: 3,
  tech_support: 4,
  dispatcher: 5,
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
    `INSERT INTO roles (id, name, description) VALUES
      ($1, 'staff', 'Staff'),
      ($2, 'tech_support', 'Technical Support'),
      ($3, 'dispatcher', 'Dispatcher'),
      ($4, 'superuser', 'Superuser'),
      ($5, 'customer', 'Customer'),
      ($6, 'partner', 'Partner')
     ON CONFLICT (id) DO NOTHING`,
    [
      ROLE_IDS.staff,
      ROLE_IDS.tech_support,
      ROLE_IDS.dispatcher,
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
  // multi.role -> staff + dispatcher
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
      ROLE_IDS.dispatcher,
      ROLE_IDS.customer,
      ROLE_IDS.partner
    ]
  );
});

after(async () => {
  await dbContext.cleanup();
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
  assert.deepEqual(multiRole[0].roles.slice().sort(), ["dispatcher", "staff"]);

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
