import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { initializeDatabase, query } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import {
  StaffUserActor,
  createStaffUser,
  describeUserStatusColumn,
  resolveInvitedUserStatus,
  selectInvitedStatusLabel
} from "./staff-users";

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
    await dbContext.cleanup();
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
      roles: ["staff"],
      actor: ACTOR
    });

    assert.equal(created.email, "enum.invite@example.com");
    assert.equal(created.status, "invited");
    assert.deepEqual(created.roles, ["staff"]);
    assert.equal(await statusOf("enum.invite@example.com"), "invited");
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
    await dbContext.cleanup();
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
    await dbContext.cleanup();
  });

  test("the account keeps the Pending status", async () => {
    const created = await createStaffUser({
      email: "text.status@example.com",
      roles: ["staff"],
      actor: ACTOR
    });

    assert.equal(created.status, "Pending");
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
