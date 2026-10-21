import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { initializeDatabase, query  } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext, safeCleanupTestDatabase } from "../database/test-helper";
import {
  ImmutableRoleError,
  RolePolicyViolationError,
  StaffUserActor,
  createStaffUser,
  describeUserStatusColumn,
  resolveInvitedUserStatus,
  selectInvitedStatusLabel,
  updateStaffUserRoles,
  updateStaffDisplayName
} from "./staff-users";
import { getStaffUser, listStaffUsers } from "./staff";
import { listStaffRoleAuditEvents } from "./staff-role-audit";

const ACTOR: StaffUserActor = {
  email: "admin@ridematrix.com",
  roles: ["admin"],
  permissions: ["manage_users"]
};

async function seedStaffRole(): Promise<void> {
  await query(
    `INSERT INTO roles (id, key, description) VALUES (3, 'staff', 'Staff')
     ON CONFLICT (id) DO NOTHING`
  );
}

async function statusOf(email: string): Promise<string | null> {
  const result = await query<{ status: string | null }>(
    `SELECT status::text AS status FROM users WHERE lower(email) = $1`,
    [email]
  );

  return result.rows[0]?.status ?? null;
}

describe("invited status resolution", () => {
  test("prefers the Pending label when the enum exposes it", () => {
    assert.equal(selectInvitedStatusLabel(["Active", "Pending", "Suspended"]), "Pending");
  });

  test("matches enum labels regardless of case and separators", () => {
    assert.equal(selectInvitedStatusLabel(["active", "pending_invite"]), "pending_invite");
    assert.equal(selectInvitedStatusLabel(["active", "invited", "suspended"]), "invited");
  });

  test("never falls back to an active or suspended label", () => {
    assert.equal(selectInvitedStatusLabel(["active", "suspended", "deleted"]), null);
  });

  test("a text status column keeps the application default", () => {
    assert.equal(resolveInvitedUserStatus({ kind: "text" }), "Pending");
    assert.equal(resolveInvitedUserStatus({ kind: "absent" }), null);
  });
});

describe("createStaffUser against a production-shaped user_status enum", () => {
  let dbContext: TestDatabaseContext;

  before(async () => {
    dbContext = await createTestDatabaseContext("test_staff_users_enum");
    await dbContext.createAuthTables({
      statusEnumValues: ["active", "invited", "suspended", "deleted"],
      statusDefault: "active"
    });
    await initializeDatabase();
    await seedStaffRole();
  });

  after(async () => {
  await safeCleanupTestDatabase(dbContext);
});

  test("the enum rejects the hard-coded Pending value (production failure mode)", async () => {
    await assert.rejects(
      query(`INSERT INTO users (email, status) VALUES ($1, $2)`, [
        "enum.reject@example.com",
        "Pending"
      ]),
      (error: { code?: string }) => error.code === "22P02"
    );
  });

  test("the status column is detected as an enum with its labels", async () => {
    const column = await describeUserStatusColumn((sql, params) => query(sql, params as unknown[]));

    assert.equal(column.kind, "enum");
    assert.deepEqual(column.kind === "enum" ? column.labels : [], [
      "active",
      "invited",
      "suspended",
      "deleted"
    ]);
  });

  test("an invitation is created with the enum's invited status", async () => {
    const created = await createStaffUser({
      email: "Enum.Invite@Example.com",
      displayName: "Known colleague",
      roles: ["staff"],
      actor: ACTOR
    });

    assert.equal(created.email, "enum.invite@example.com");
    assert.equal(created.status, "invited");
    assert.deepEqual(created.roles, ["staff"]);
    assert.equal(await statusOf("enum.invite@example.com"), "invited");
    assert.equal((await getStaffUser(created.id))?.displayName, "Known colleague");
  });
});

describe("createStaffUser against an enum without an invited label", () => {
  let dbContext: TestDatabaseContext;

  before(async () => {
    dbContext = await createTestDatabaseContext("test_staff_users_enum_plain");
    await dbContext.createAuthTables({
      statusEnumValues: ["active", "suspended"],
      statusDefault: "active"
    });
    await initializeDatabase();
    await seedStaffRole();
  });

  after(async () => {
  await safeCleanupTestDatabase(dbContext);
});

  test("the account is inserted without an explicit status instead of failing", async () => {
    const created = await createStaffUser({
      email: "fallback@example.com",
      roles: ["staff"],
      actor: ACTOR
    });

    assert.equal(created.status, "active");
    assert.deepEqual(created.roles, ["staff"]);
  });
});

describe("createStaffUser against a text status column", () => {
  let dbContext: TestDatabaseContext;

  before(async () => {
    dbContext = await createTestDatabaseContext("test_staff_users_text");
    await dbContext.createAuthTables();
    await initializeDatabase();
    await seedStaffRole();
  });

  after(async () => {
  await safeCleanupTestDatabase(dbContext);
});

  test("the account keeps the Pending status", async () => {
    const created = await createStaffUser({
      email: "text.status@example.com",
      roles: ["staff"],
      actor: ACTOR
    });

    assert.equal(created.status, "Pending");
    assert.equal((await getStaffUser(created.id))?.displayName, null);
  });

  test("names are stored separately, updated and cleared without changing auth accounts", async () => {
    const created = await createStaffUser({
      email: "named.staff@example.com", displayName: "  Žaneta O’Neill  ", roles: ["staff"], actor: ACTOR
    });
    assert.equal((await getStaffUser(created.id))?.displayName, "Žaneta O’Neill");
    assert.equal(await updateStaffDisplayName(created.id, "  Operations team  ", ACTOR), true);
    assert.equal((await getStaffUser(created.id))?.displayName, "Operations team");
    const listed = await listStaffUsers();
    assert.equal(listed.find((member) => member.id === created.id)?.displayName, "Operations team");
    assert.deepEqual(listed.map((member) => member.email), listed.map((member) => member.email).sort());
    assert.equal(await updateStaffDisplayName(created.id, "   ", ACTOR), true);
    assert.equal((await getStaffUser(created.id))?.displayName, null);
    assert.equal(await statusOf(created.email), "Pending");
    assert.deepEqual((await getStaffUser(created.id))?.roles, ["staff"]);
    const columns = await query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'display_name'`);
    assert.equal(columns.rows.length, 0, "external auth schema remains unchanged");
  });

  test("profile changes require management rights and an existing internal staff account", async () => {
    await assert.rejects(updateStaffDisplayName("a0000000-0000-0000-0000-000000000002", "Name", {
      email: "driver@example.com", roles: ["driver"], permissions: []
    }));
    for (const id of ["invalid'input", "ffffffff-0000-0000-0000-000000000000", "a0000000-0000-0000-0000-000000000002"]) {
      assert.equal(await updateStaffDisplayName(id, "Name", ACTOR), false);
    }
  });

  test("invalid display names cannot create an account", async () => {
    await assert.rejects(createStaffUser({
      email: "invalid.name@example.com", displayName: "X".repeat(101), roles: ["staff"], actor: ACTOR
    }));
    const result = await query(`SELECT id FROM users WHERE email = $1`, ["invalid.name@example.com"]);
    assert.equal(result.rows.length, 0);
  });

  test("an unknown role leaves neither a user nor role assignments behind", async () => {
    await assert.rejects(
      createStaffUser({ email: "rollback@example.com", roles: ["not_a_role"], actor: ACTOR })
    );

    const result = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM users WHERE lower(email) = $1`,
      ["rollback@example.com"]
    );

    assert.equal(result.rows[0].count, 0);
  });
});

describe("updateStaffUserRoles", () => {
  let dbContext: TestDatabaseContext;

  before(async () => {
    dbContext = await createTestDatabaseContext("test_staff_roles_update");
    await dbContext.createAuthTables();
    await initializeDatabase();
    await query(
      `INSERT INTO roles (id, key, description) VALUES
         (3, 'staff', 'Staff'),
         (4, 'customer', 'Customer'),
         (5, 'superuser', 'Superuser')
       ON CONFLICT (id) DO NOTHING`
    );
    await query(
      `INSERT INTO permissions (id, key, description) VALUES
         (10, 'manage_user_roles', 'Manage user roles')
       ON CONFLICT (id) DO NOTHING`
    );
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES
         (1, 2),
         (1, 10),
         (5, 10)
       ON CONFLICT DO NOTHING`
    );
  });

  after(async () => {
    await safeCleanupTestDatabase(dbContext);
  });

  const actor: StaffUserActor = {
    userId: "a0000000-0000-0000-0000-000000000001",
    email: "admin@ridematrix.com",
    roles: ["admin"],
    permissions: ["manage_users", "manage_user_roles"]
  };

  test("updates role mappings transactionally and records before/after roles", async () => {
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES
        ('a0000000-0000-0000-0000-000000000002', 3)
       ON CONFLICT DO NOTHING`
    );
    const updated = await updateStaffUserRoles({
      accountId: "a0000000-0000-0000-0000-000000000002",
      roles: ["staff", "driver"],
      actor,
      expectedSuperuserMembership: "absent"
    });
    assert.deepEqual(updated.beforeRoles, ["driver", "staff"]);
    assert.deepEqual(updated.afterRoles, ["driver", "staff"]);
    const target = await query<{ role: string }>(
      `SELECT r.key AS role
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id::text = $1
        ORDER BY r.key`,
      ["a0000000-0000-0000-0000-000000000002"]
    );
    assert.deepEqual(target.rows.map((row) => row.role), ["driver", "staff"]);
    const audits = await listStaffRoleAuditEvents("a0000000-0000-0000-0000-000000000002", 10);
    assert.equal(audits[0].success, true);
    assert.deepEqual(audits[0].beforeRoles, ["driver", "staff"]);
    assert.deepEqual(audits[0].afterRoles, ["driver", "staff"]);
  });

  test("rejects immutable superuser modifications", async () => {
    await assert.rejects(
      updateStaffUserRoles({
        accountId: "a0000000-0000-0000-0000-000000000002",
        roles: ["superuser"],
        actor,
        expectedSuperuserMembership: "absent"
      }),
      ImmutableRoleError
    );
  });

  test("prevents self lockout of privileged access", async () => {
    await assert.rejects(
      updateStaffUserRoles({
        accountId: actor.userId!,
        roles: [],
        actor,
        expectedSuperuserMembership: "absent"
      }),
      RolePolicyViolationError
    );
  });

  test("rejects internal+customer combination by default policy", async () => {
    await query(
      `INSERT INTO users (id, email, status) VALUES
        ('c0000000-0000-0000-0000-000000000001', 'customer.role.mix@example.com', 'Active')
       ON CONFLICT (id) DO NOTHING`
    );
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES
        ('c0000000-0000-0000-0000-000000000001', 4)
       ON CONFLICT DO NOTHING`
    );
    await assert.rejects(
      updateStaffUserRoles({
        accountId: "c0000000-0000-0000-0000-000000000001",
        roles: ["staff"],
        actor,
        expectedSuperuserMembership: "absent"
      }),
      RolePolicyViolationError
    );
  });
});
