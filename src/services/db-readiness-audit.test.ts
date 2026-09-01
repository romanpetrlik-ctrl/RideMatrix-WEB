import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { getPool, initializeDatabase } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import {
  FUTURE_SUPERUSER_EMAIL,
  OPERATIONAL_ACCOUNT_EMAIL,
  QueryRunner,
  assertReadOnlyStatement,
  auditDatabaseReadiness,
  createReadOnlyRunner,
  describeDatabaseTarget,
  formatReadinessReport,
  maskEmail,
  runDatabaseReadinessAudit
} from "./db-readiness-audit";

describe("database readiness audit — safety", () => {
  test("only SELECT statements are accepted", () => {
    assertReadOnlyStatement("SELECT 1");
    assertReadOnlyStatement("WITH x AS (SELECT 1) SELECT * FROM x");

    for (const statement of [
      "INSERT INTO users (email) VALUES ('x@example.com')",
      "UPDATE users SET status = 'Active'",
      "DELETE FROM customers",
      "DROP TABLE customers",
      "TRUNCATE customers",
      "ALTER TABLE users ADD COLUMN x TEXT",
      "CREATE TABLE t (id INT)",
      "SELECT 1; DROP TABLE customers"
    ]) {
      assert.throws(() => assertReadOnlyStatement(statement), /non read-only statement/);
    }
  });

  test("the read-only runner refuses to execute a mutating statement", async () => {
    let executed = 0;
    const runner = createReadOnlyRunner({
      query: async () => {
        executed += 1;
        return { rows: [] } as any;
      }
    } as any);

    await assert.rejects(() => runner("DELETE FROM customers"), /non read-only statement/);
    assert.equal(executed, 0);
  });

  test("the connection target is reported without credentials", () => {
    // Assembled from parts so no credential-looking literal is committed.
    const credential = ["app", "user"].join("_");
    const url = `postgres://${credential}:${["n0t", "real"].join("-")}@db.internal:5432/ridematrix`;
    const target = describeDatabaseTarget(url);

    assert.equal(target.configured, true);
    assert.equal(target.redactedTarget, "db.internal:5432/ridematrix");
    assert.ok(!JSON.stringify(target).includes(credential));
    assert.ok(!JSON.stringify(target).includes("n0t-real"));
  });

  test("a missing DATABASE_URL yields NOT_VERIFIED instead of a guess", async () => {
    const report = await runDatabaseReadinessAudit({ databaseUrl: "" });

    assert.equal(report.target.configured, false);
    assert.equal(report.target.reachable, false);
    assert.deepEqual(
      report.sections.map((section) => section.status),
      ["NOT_VERIFIED", "NOT_VERIFIED", "NOT_VERIFIED"]
    );
    assert.match(formatReadinessReport(report), /NOT inspected/);
  });

  test("an unreachable database yields NOT_VERIFIED instead of throwing", async () => {
    const report = await runDatabaseReadinessAudit({
      databaseUrl: `postgres://${["someone", ["n0t", "real"].join("-")].join(":")}@127.0.0.1:1/ridematrix`,
      connect: async () => {
        throw new Error("connection refused");
      }
    });

    assert.equal(report.target.reachable, false);
    assert.match(String(report.target.problem), /could not be inspected/);
    assert.ok(!JSON.stringify(report).includes("n0t-real"));
    assert.deepEqual(
      report.sections.map((section) => section.status),
      ["NOT_VERIFIED", "NOT_VERIFIED", "NOT_VERIFIED"]
    );
  });

  test("email addresses are masked in report labels", () => {
    assert.equal(maskEmail(OPERATIONAL_ACCOUNT_EMAIL), "bo***s@romanairporttransfers.co.uk");
    assert.equal(maskEmail("a@example.com"), "a***@example.com");
    assert.equal(maskEmail("not-an-email"), "***");
  });
});

describe("database readiness audit — missing schema handling", () => {
  function mockRunner(rows: Record<string, any[]>): QueryRunner {
    return async (sql: string) => {
      assertReadOnlyStatement(sql);

      if (sql.includes("information_schema.tables")) {
        return { rows: rows.tables ?? [] };
      }

      if (sql.includes("information_schema.columns")) {
        return { rows: rows.columns ?? [] };
      }

      if (sql.includes("pg_constraint")) {
        return { rows: rows.constraints ?? [] };
      }

      if (sql.includes("pg_indexes")) {
        return { rows: rows.indexes ?? [] };
      }

      return { rows: [] };
    };
  }

  test("an empty database is reported as BLOCKED without throwing", async () => {
    const sections = await auditDatabaseReadiness(mockRunner({}));

    assert.deepEqual(
      sections.map((section) => section.status),
      ["BLOCKED", "BLOCKED", "BLOCKED"]
    );
    assert.match(
      sections[0].checks.find((check) => check.id === "auth_tables_present")!.detail,
      /Missing table\(s\)/
    );
  });

  test("a partially migrated schema reports the missing columns instead of failing", async () => {
    const sections = await auditDatabaseReadiness(
      mockRunner({
        tables: [{ table_name: "users" }, { table_name: "customers" }],
        columns: [
          { table_name: "users", column_name: "id", data_type: "uuid", is_nullable: "NO", column_default: null },
          {
            table_name: "customers",
            column_name: "id",
            data_type: "text",
            is_nullable: "NO",
            column_default: null
          }
        ]
      })
    );

    const authColumns = sections[0].checks.find((check) => check.id === "auth_columns_users");
    assert.equal(authColumns?.status, "FAIL");
    assert.match(authColumns!.detail, /email/);

    const customerColumns = sections[1].checks.find((check) => check.id === "customer_columns_customers");
    assert.equal(customerColumns?.status, "FAIL");
    assert.equal(sections[2].status, "BLOCKED");
  });
});

describe("database readiness audit — against a migrated database", () => {
  let dbContext: TestDatabaseContext;

  before(async () => {
    dbContext = await createTestDatabaseContext("test_db_audit");
    await dbContext.createAuthTables();
    await initializeDatabase();
  });

  after(async () => {
    await dbContext.cleanup();
  });

  async function audit() {
    return runDatabaseReadinessAudit({ connect: () => getPool().connect() });
  }

  test("the customer schema of a migrated database is READY", async () => {
    const report = await audit();
    const customerSchema = report.sections.find((section) => section.id === "customer_schema")!;

    assert.equal(report.target.reachable, true);
    assert.equal(
      customerSchema.checks.find((check) => check.id === "customer_tables_present")!.status,
      "PASS"
    );
    assert.equal(customerSchema.status, "READY");
  });

  test("the auth schema is inspected from the connected database", async () => {
    const report = await audit();
    const auth = report.sections.find((section) => section.id === "auth_schema")!;

    assert.equal(
      auth.checks.find((check) => check.id === "auth_tables_present")!.status,
      "PASS"
    );
    assert.equal(
      auth.checks.find((check) => check.id === "auth_invite_flow_supported")!.status,
      "PASS"
    );
    // The stand-in auth fixture has no superuser role, which must be reported
    // as a blocker rather than silently assumed.
    assert.equal(auth.checks.find((check) => check.id === "auth_superuser_role")!.status, "FAIL");
    assert.equal(auth.status, "BLOCKED");
  });

  test("the future superuser account is reported as absent and is not created", async () => {
    const before = await getPool().query(`SELECT COUNT(*)::int AS count FROM users`);
    const report = await audit();
    const after = await getPool().query(`SELECT COUNT(*)::int AS count FROM users`);

    const check = report.sections
      .find((section) => section.id === "auth_schema")!
      .checks.find((entry) => entry.id === "auth_future_superuser_absent")!;

    assert.equal(check.status, "PASS");
    assert.match(check.detail, /did not create it/);
    assert.equal(after.rows[0].count, before.rows[0].count);
    assert.ok(!JSON.stringify(report).includes(FUTURE_SUPERUSER_EMAIL));
  });

  test("import readiness reports the de-duplication keys and demo population", async () => {
    const report = await audit();
    const importSection = report.sections.find((section) => section.id === "customer_import")!;

    assert.equal(
      importSection.checks.find((check) => check.id === "import_active_email_unique")!.status,
      "PASS"
    );
    assert.equal(
      importSection.checks.find((check) => check.id === "import_dedupe_key_unique")!.status,
      "PASS"
    );
    assert.equal(
      importSection.checks.find((check) => check.id === "import_duplicate_identities")!.status,
      "PASS"
    );

    const population = importSection.checks.find(
      (check) => check.id === "import_existing_customer_population"
    )!;
    assert.equal(population.status, "WARN");
    assert.match(population.detail, /seed=18/);
    assert.equal(importSection.status, "NEEDS_REVIEW");
  });

  test("the audit does not modify customer data", async () => {
    const before = await getPool().query(
      `SELECT COUNT(*)::int AS count, MAX(updated_at) AS updated FROM customers`
    );
    await audit();
    const after = await getPool().query(
      `SELECT COUNT(*)::int AS count, MAX(updated_at) AS updated FROM customers`
    );

    assert.deepEqual(after.rows[0], before.rows[0]);
  });

  test("the rendered report never contains a connection string or password", async () => {
    const rendered = formatReadinessReport(await audit());

    assert.doesNotMatch(rendered, /postgres(ql)?:\/\//i);
    assert.doesNotMatch(rendered, /password/i);
    assert.match(rendered, /Auth schema readiness: /);
    assert.match(rendered, /Customer import readiness: /);
  });
});
