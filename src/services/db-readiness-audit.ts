/**
 * Read-only production/database readiness audit.
 *
 * The audit inspects the schema of whatever database `DATABASE_URL` points at
 * and reports whether it is ready for
 *   - the internal auth / `/staff/invite` onboarding flow, and
 *   - the Cabcher customer import.
 *
 * Safety rules enforced by this module:
 *   - every statement it issues is a `SELECT` (see `assertReadOnlyStatement`),
 *   - the statements run inside a `READ ONLY` transaction,
 *   - no user, role, permission, or customer row is ever created or modified,
 *   - no connection string, password, login code, or token is ever reported.
 */

import type { Pool, PoolClient } from "pg";
import { getPool } from "../database/connection";
import { describeUserStatusColumn, resolveInvitedUserStatus } from "./staff-users";

export type ReadinessStatus = "READY" | "BLOCKED" | "NEEDS_REVIEW" | "NOT_VERIFIED";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export type AuditCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
};

export type AuditSection = {
  id: "auth_schema" | "customer_schema" | "customer_import";
  label: string;
  status: ReadinessStatus;
  checks: AuditCheck[];
};

export type AuditTarget = {
  /** True when DATABASE_URL is configured in this environment. */
  configured: boolean;
  /** True when the audit actually connected and read the schema. */
  reachable: boolean;
  /** `host/database` only — never the user, password, or query string. */
  redactedTarget: string | null;
  /** Present when the connection or configuration failed. */
  problem: string | null;
};

export type ReadinessReport = {
  generatedAt: string;
  target: AuditTarget;
  sections: AuditSection[];
  notes: string[];
};

export type QueryRunner = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** Future real superuser; the audit only checks whether it already exists. */
export const FUTURE_SUPERUSER_EMAIL = "roman.petrlik@hotmail.com";

/** Existing operational account; the audit only reads its role names. */
export const OPERATIONAL_ACCOUNT_EMAIL = "bookings@romanairporttransfers.co.uk";

const AUTH_TABLES = [
  "users",
  "roles",
  "permissions",
  "user_roles",
  "role_permissions",
  "login_codes"
] as const;

const REQUIRED_AUTH_COLUMNS: Record<string, string[]> = {
  users: ["id", "email"],
  roles: ["id", "key"],
  permissions: ["id", "key"],
  user_roles: ["user_id", "role_id"],
  role_permissions: ["role_id", "permission_id"],
  login_codes: ["email", "code", "expires_at"]
};

const CUSTOMER_TABLES = [
  "customers",
  "customer_bookings",
  "import_batches",
  "imported_bookings",
  "imported_customers"
] as const;

const REQUIRED_CUSTOMER_COLUMNS: Record<string, string[]> = {
  customers: [
    "id",
    "given_name",
    "surname",
    "email",
    "email_normalized",
    "phone",
    "status",
    "source",
    "preferred_contact",
    "created_at",
    "updated_at",
    "last_booking_at",
    "deleted_at"
  ],
  customer_bookings: ["id", "customer_id", "reference", "service_date", "status", "created_at"],
  import_batches: [
    "id",
    "source_type",
    "original_filename",
    "uploaded_by",
    "uploaded_at",
    "status",
    "total_rows",
    "imported_rows",
    "rejected_rows"
  ],
  imported_bookings: [
    "id",
    "import_batch_id",
    "customer_email",
    "customer_name_raw",
    "service_date_time",
    "pickup_text",
    "dropoff_text",
    "customer_id",
    "dedupe_key",
    "created_at",
    "updated_at"
  ],
  imported_customers: ["id", "email", "full_name", "booking_count_total", "created_at", "updated_at"]
};

/** Permissions the invite flow consults when authorizing role delegation. */
const INVITE_PERMISSIONS = ["manage_users", "manage_user_roles"];

const SUPERUSER_ROLE = "superuser";

const INTERNAL_ROLES = ["superuser", "admin", "staff", "tech_support", "driver"];

/**
 * Masks an email address so a report can state *that* an account exists without
 * broadcasting the full address: `bo****gs@romanairporttransfers.co.uk`.
 */
export function maskEmail(email: string): string {
  const trimmed = String(email || "").trim();
  const at = trimmed.lastIndexOf("@");

  if (at <= 0) {
    return "***";
  }

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }

  return `${local.slice(0, 2)}***${local.slice(-1)}@${domain}`;
}

/**
 * Describes the configured target without exposing credentials. Only the host
 * and database name are kept; user, password and options are dropped.
 */
export function describeDatabaseTarget(rawUrl: string | undefined): AuditTarget {
  const configured = String(rawUrl || "").trim();

  if (!configured) {
    return {
      configured: false,
      reachable: false,
      redactedTarget: null,
      problem:
        "DATABASE_URL is not configured in this environment, so no database could be inspected."
    };
  }

  try {
    const parsed = new URL(configured);
    const database = parsed.pathname.replace(/^\//, "") || "(default)";
    const host = parsed.hostname || "(local socket)";
    const port = parsed.port ? `:${parsed.port}` : "";

    return {
      configured: true,
      reachable: false,
      redactedTarget: `${host}${port}/${database}`,
      problem: null
    };
  } catch {
    // Some valid libpq URLs (e.g. unix-socket style `postgresql://user@/db`)
    // are not accepted by the WHATWG URL parser. Fall back to a conservative
    // pattern that keeps host and database only and always drops credentials.
    const match = /^[a-z0-9+.-]+:\/\/(?:[^@/]*@)?([^/?#]*)(?:\/([^?#]*))?/i.exec(configured);
    const host = match?.[1] ? match[1] : "(local socket)";
    const database = match?.[2] ? match[2] : "(default)";

    return {
      configured: true,
      reachable: false,
      redactedTarget: `${host}/${database}`,
      problem: null
    };
  }
}

const READ_ONLY_STATEMENT = /^\s*(select|with)\b/i;
const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|copy|merge|vacuum|refresh)\b/i;

/**
 * Guards the audit against ever issuing a mutating statement. Exported so tests
 * can prove the audit is read-only.
 */
export function assertReadOnlyStatement(sql: string): void {
  if (!READ_ONLY_STATEMENT.test(sql) || FORBIDDEN_KEYWORDS.test(sql)) {
    throw new Error("Database readiness audit refused a non read-only statement.");
  }
}

export function createReadOnlyRunner(client: Pool | PoolClient): QueryRunner {
  return async (sql: string, params?: unknown[]) => {
    assertReadOnlyStatement(sql);
    const result = await client.query(sql, params as any[]);
    return { rows: result.rows };
  };
}

type SchemaFacts = {
  tables: Set<string>;
  columns: Map<string, Map<string, { nullable: boolean; dataType: string; hasDefault: boolean }>>;
  constraints: { table: string; type: string; definition: string }[];
  indexes: { table: string; name: string; definition: string }[];
};

async function loadSchemaFacts(run: QueryRunner): Promise<SchemaFacts> {
  const tablesResult = await run(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = ANY (current_schemas(false))`
  );

  const columnsResult = await run(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = ANY (current_schemas(false))`
  );

  const constraintsResult = await run(
    `SELECT rel.relname AS table_name,
            con.contype AS constraint_type,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = ANY (current_schemas(false))`
  );

  const indexesResult = await run(
    `SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
       FROM pg_indexes
      WHERE schemaname = ANY (current_schemas(false))`
  );

  const columns = new Map<
    string,
    Map<string, { nullable: boolean; dataType: string; hasDefault: boolean }>
  >();

  for (const row of columnsResult.rows) {
    const table = String(row.table_name);

    if (!columns.has(table)) {
      columns.set(table, new Map());
    }

    columns.get(table)!.set(String(row.column_name), {
      nullable: String(row.is_nullable).toUpperCase() === "YES",
      dataType: String(row.data_type),
      hasDefault: row.column_default !== null && row.column_default !== undefined
    });
  }

  return {
    tables: new Set(tablesResult.rows.map((row) => String(row.table_name))),
    columns,
    constraints: constraintsResult.rows.map((row) => ({
      table: String(row.table_name),
      type: String(row.constraint_type),
      definition: String(row.definition)
    })),
    indexes: indexesResult.rows.map((row) => ({
      table: String(row.table_name),
      name: String(row.index_name),
      definition: String(row.definition)
    }))
  };
}

function missingColumns(facts: SchemaFacts, table: string, required: string[]): string[] {
  const present = facts.columns.get(table);

  if (!present) {
    return [...required];
  }

  return required.filter((column) => !present.has(column));
}

function hasUniqueOn(facts: SchemaFacts, table: string, column: string): boolean {
  const pattern = new RegExp(`\\(\\s*(lower\\()?${column}\\b`, "i");

  const uniqueConstraint = facts.constraints.some(
    (entry) =>
      entry.table === table &&
      (entry.type === "u" || entry.type === "p") &&
      pattern.test(entry.definition)
  );

  if (uniqueConstraint) {
    return true;
  }

  return facts.indexes.some(
    (entry) => entry.table === table && /UNIQUE/i.test(entry.definition) && pattern.test(entry.definition)
  );
}

function hasForeignKey(facts: SchemaFacts, table: string, column: string, target: string): boolean {
  return facts.constraints.some(
    (entry) =>
      entry.table === table &&
      entry.type === "f" &&
      entry.definition.includes(`(${column})`) &&
      new RegExp(`REFERENCES\\s+(\\w+\\.)?${target}\\b`, "i").test(entry.definition)
  );
}

function sectionStatus(checks: AuditCheck[]): ReadinessStatus {
  if (checks.some((check) => check.status === "FAIL")) {
    return "BLOCKED";
  }

  if (checks.some((check) => check.status === "WARN" || check.status === "UNKNOWN")) {
    return "NEEDS_REVIEW";
  }

  return "READY";
}

async function auditAuthSchema(run: QueryRunner, facts: SchemaFacts): Promise<AuditSection> {
  const checks: AuditCheck[] = [];
  const missingTables = AUTH_TABLES.filter((table) => !facts.tables.has(table));

  checks.push({
    id: "auth_tables_present",
    label: "Auth tables exist",
    status: missingTables.length === 0 ? "PASS" : "FAIL",
    detail:
      missingTables.length === 0
        ? `Found: ${AUTH_TABLES.join(", ")}.`
        : `Missing table(s): ${missingTables.join(", ")}.`
  });

  for (const [table, required] of Object.entries(REQUIRED_AUTH_COLUMNS)) {
    if (!facts.tables.has(table)) {
      continue;
    }

    const missing = missingColumns(facts, table, required);
    checks.push({
      id: `auth_columns_${table}`,
      label: `Columns required by the application on ${table}`,
      status: missing.length === 0 ? "PASS" : "FAIL",
      detail: missing.length === 0 ? "All required columns present." : `Missing: ${missing.join(", ")}.`
    });
  }

  if (facts.tables.has("users")) {
    checks.push({
      id: "auth_users_email_unique",
      label: "users.email is unique",
      status: hasUniqueOn(facts, "users", "email") ? "PASS" : "WARN",
      detail: hasUniqueOn(facts, "users", "email")
        ? "A unique constraint or index covers users.email."
        : "No unique constraint/index found on users.email; duplicate accounts would be possible."
    });

    const statusColumn = facts.columns.get("users")?.get("status");

    if (!statusColumn) {
      checks.push({
        id: "auth_users_status_column",
        label: "users.status can carry an invited (non-active) state",
        status: "WARN",
        detail: "Column absent; invited accounts are created without an explicit status."
      });
    } else {
      const column = await describeUserStatusColumn(run);
      const invitedStatus = resolveInvitedUserStatus(column);

      checks.push({
        id: "auth_users_status_column",
        label: "users.status can carry an invited (non-active) state",
        status: invitedStatus || statusColumn.hasDefault ? "PASS" : "WARN",
        detail:
          column.kind === "enum"
            ? invitedStatus
              ? `Enum ${column.typeName} (${column.labels.join(", ")}); invited accounts use "${invitedStatus}".`
              : `Enum ${column.typeName} (${column.labels.join(", ")}) has no invited/pending label; invited accounts are created without an explicit status${
                  statusColumn.hasDefault ? " and fall back to the column default" : ""
                }.`
            : `Present (${statusColumn.dataType}${
                statusColumn.hasDefault ? ", has default" : ""
              }); invited accounts use "${invitedStatus}".`
      });
    }
  }

  if (facts.tables.has("roles")) {
    const roleRows = await run(`SELECT key AS name FROM roles WHERE key = ANY($1::text[])`, [
      INTERNAL_ROLES
    ]);
    const presentRoles = roleRows.rows.map((row) => String(row.name));
    const missingRoles = INTERNAL_ROLES.filter((role) => !presentRoles.includes(role));

    checks.push({
      id: "auth_superuser_role",
      label: "superuser role exists",
      status: presentRoles.includes(SUPERUSER_ROLE) ? "PASS" : "FAIL",
      detail: presentRoles.includes(SUPERUSER_ROLE)
        ? "The superuser role is present in roles."
        : "The superuser role is missing; superuser delegation cannot be assigned."
    });

    checks.push({
      id: "auth_internal_roles",
      label: "Internal roles offered by /staff/invite exist",
      status: missingRoles.length === 0 ? "PASS" : "WARN",
      detail:
        missingRoles.length === 0
          ? `All internal roles present: ${INTERNAL_ROLES.join(", ")}.`
          : `Missing role(s): ${missingRoles.join(", ")}. They will not be offered by the invite form.`
    });
  }

  if (facts.tables.has("permissions") && facts.tables.has("role_permissions")) {
    const permissionRows = await run(
      `SELECT key AS name FROM permissions WHERE key = ANY($1::text[])`,
      [INVITE_PERMISSIONS]
    );
    const presentPermissions = permissionRows.rows.map((row) => String(row.name));
    const missingPermissions = INVITE_PERMISSIONS.filter(
      (permission) => !presentPermissions.includes(permission)
    );

    checks.push({
      id: "auth_invite_permissions",
      label: "Permissions used by the invite flow exist",
      status: missingPermissions.length === 0 ? "PASS" : "WARN",
      detail:
        missingPermissions.length === 0
          ? `Present: ${INVITE_PERMISSIONS.join(", ")}.`
          : `Missing permission(s): ${missingPermissions.join(", ")}. Authorization then falls back to the superuser role.`
    });

    const grantRows = await run(
      `SELECT r.key AS role_name, p.key AS permission_name
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE p.key = ANY($1::text[])
        ORDER BY r.key, p.key`,
      [INVITE_PERMISSIONS]
    );

    checks.push({
      id: "auth_permission_grants",
      label: "Role → permission relationships for user administration",
      status: grantRows.rows.length > 0 ? "PASS" : "WARN",
      detail:
        grantRows.rows.length > 0
          ? grantRows.rows
              .map((row) => `${row.role_name} → ${row.permission_name}`)
              .join(", ")
          : "No role currently grants manage_users/manage_user_roles; only superuser accounts can invite."
    });
  }

  if (facts.tables.has("users")) {
    const futureRow = await run(
      `SELECT COUNT(*)::int AS count FROM users WHERE lower(email) = lower($1)`,
      [FUTURE_SUPERUSER_EMAIL]
    );
    const futureExists = Number(futureRow.rows[0]?.count || 0) > 0;

    checks.push({
      id: "auth_future_superuser_absent",
      label: `Future superuser account (${maskEmail(FUTURE_SUPERUSER_EMAIL)})`,
      status: futureExists ? "WARN" : "PASS",
      detail: futureExists
        ? "A row with this address already exists; onboarding must reuse it instead of creating a duplicate."
        : "No row uses this address yet; it can be created later through /staff/invite. The audit did not create it."
    });

    if (facts.tables.has("user_roles") && facts.tables.has("roles")) {
      const operationalRow = await run(
        `SELECT COUNT(*)::int AS count FROM users WHERE lower(email) = lower($1)`,
        [OPERATIONAL_ACCOUNT_EMAIL]
      );
      const operationalExists = Number(operationalRow.rows[0]?.count || 0) > 0;

      const roleRows = await run(
        `SELECT r.key AS name
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE lower(u.email) = lower($1)
          ORDER BY r.key`,
        [OPERATIONAL_ACCOUNT_EMAIL]
      );
      const roleNames = roleRows.rows.map((row) => String(row.name));

      checks.push({
        id: "auth_operational_account",
        label: `Operational account (${maskEmail(OPERATIONAL_ACCOUNT_EMAIL)})`,
        status: operationalExists ? (roleNames.length > 0 ? "PASS" : "WARN") : "WARN",
        detail: !operationalExists
          ? "No row uses this address in the inspected database."
          : roleNames.length > 0
            ? `Assigned role(s): ${roleNames.join(", ")}. Not modified by this audit.`
            : "The account exists but has no role assignment, so it cannot delegate roles."
      });
    }
  }

  const inviteSupported =
    facts.tables.has("users") &&
    facts.tables.has("roles") &&
    facts.tables.has("user_roles") &&
    missingColumns(facts, "users", ["id", "email"]).length === 0 &&
    missingColumns(facts, "user_roles", ["user_id", "role_id"]).length === 0;

  checks.push({
    id: "auth_invite_flow_supported",
    label: "Schema supports the /staff/invite flow",
    status: inviteSupported ? "PASS" : "FAIL",
    detail: inviteSupported
      ? "users + roles + user_roles can carry a new internal account and its role assignments."
      : "The invite flow cannot run against this schema."
  });

  return {
    id: "auth_schema",
    label: "Auth schema readiness",
    status: sectionStatus(checks),
    checks
  };
}

async function auditCustomerSchema(run: QueryRunner, facts: SchemaFacts): Promise<AuditSection> {
  const checks: AuditCheck[] = [];
  const missingTables = CUSTOMER_TABLES.filter((table) => !facts.tables.has(table));

  checks.push({
    id: "customer_tables_present",
    label: "Customer tables exist",
    status: missingTables.length === 0 ? "PASS" : "FAIL",
    detail:
      missingTables.length === 0
        ? `Found: ${CUSTOMER_TABLES.join(", ")}.`
        : `Missing table(s): ${missingTables.join(", ")}.`
  });

  for (const [table, required] of Object.entries(REQUIRED_CUSTOMER_COLUMNS)) {
    if (!facts.tables.has(table)) {
      continue;
    }

    const missing = missingColumns(facts, table, required);
    checks.push({
      id: `customer_columns_${table}`,
      label: `Columns required by the application on ${table}`,
      status: missing.length === 0 ? "PASS" : "FAIL",
      detail: missing.length === 0 ? "All required columns present." : `Missing: ${missing.join(", ")}.`
    });
  }

  if (facts.tables.has("customers")) {
    const columns = facts.columns.get("customers")!;
    const notNullExpectations = ["given_name", "surname", "status", "source", "created_at", "updated_at"];
    const unexpectedlyNullable = notNullExpectations.filter(
      (column) => columns.has(column) && columns.get(column)!.nullable
    );

    checks.push({
      id: "customer_not_null_columns",
      label: "Required customer columns are NOT NULL",
      status: unexpectedlyNullable.length === 0 ? "PASS" : "WARN",
      detail:
        unexpectedlyNullable.length === 0
          ? "given_name, surname, status, source and timestamps are NOT NULL."
          : `Nullable where the application expects a value: ${unexpectedlyNullable.join(", ")}.`
    });

    const defaults = ["status", "source", "preferred_contact"].filter(
      (column) => columns.get(column)?.hasDefault
    );

    checks.push({
      id: "customer_defaults",
      label: "Customer defaults present",
      status: defaults.length === 3 ? "PASS" : "WARN",
      detail: `Columns with defaults: ${defaults.length > 0 ? defaults.join(", ") : "none"}.`
    });

    checks.push({
      id: "customer_primary_key",
      label: "customers has a primary key",
      status: facts.constraints.some((entry) => entry.table === "customers" && entry.type === "p")
        ? "PASS"
        : "FAIL",
      detail: facts.constraints.some((entry) => entry.table === "customers" && entry.type === "p")
        ? "Primary key present on customers.id."
        : "No primary key found on customers."
    });

    const softDelete = columns.has("deleted_at");
    checks.push({
      id: "customer_soft_delete",
      label: "Soft delete column present",
      status: softDelete ? "PASS" : "FAIL",
      detail: softDelete
        ? "customers.deleted_at exists, matching the soft-delete persistence semantics."
        : "customers.deleted_at is missing; delete and uniqueness behaviour would differ."
    });
  }

  if (facts.tables.has("customer_bookings") && facts.tables.has("customers")) {
    const fkPresent = hasForeignKey(facts, "customer_bookings", "customer_id", "customers");
    checks.push({
      id: "customer_bookings_fk",
      label: "customer_bookings.customer_id references customers",
      status: fkPresent ? "PASS" : "WARN",
      detail: fkPresent
        ? "Foreign key present."
        : "No foreign key found; orphaned bookings would not be prevented by the database."
    });
  }

  if (facts.tables.has("schema_migrations")) {
    const applied = await run(`SELECT id FROM schema_migrations ORDER BY id`);
    checks.push({
      id: "customer_migrations_applied",
      label: "Applied customer-persistence migrations",
      status: applied.rows.length > 0 ? "PASS" : "WARN",
      detail:
        applied.rows.length > 0
          ? `Applied: ${applied.rows.map((row) => String(row.id)).join(", ")}.`
          : "schema_migrations is empty; run npm run db:migrate before importing."
    });
  } else {
    checks.push({
      id: "customer_migrations_applied",
      label: "Applied customer-persistence migrations",
      status: "FAIL",
      detail: "schema_migrations table is missing; the customer schema has never been migrated here."
    });
  }

  return {
    id: "customer_schema",
    label: "Customer schema readiness",
    status: sectionStatus(checks),
    checks
  };
}

async function auditCustomerImport(run: QueryRunner, facts: SchemaFacts): Promise<AuditSection> {
  const checks: AuditCheck[] = [];

  if (!facts.tables.has("customers")) {
    checks.push({
      id: "import_customers_table",
      label: "Import target table",
      status: "FAIL",
      detail: "The customers table is missing, so the Cabcher import cannot run."
    });

    return {
      id: "customer_import",
      label: "Customer import readiness",
      status: sectionStatus(checks),
      checks
    };
  }

  const activeEmailIndex = facts.indexes.find(
    (entry) =>
      entry.table === "customers" &&
      /UNIQUE/i.test(entry.definition) &&
      /email_normalized/i.test(entry.definition)
  );

  checks.push({
    id: "import_active_email_unique",
    label: "Active customer e-mail uniqueness",
    status: activeEmailIndex ? "PASS" : "FAIL",
    detail: activeEmailIndex
      ? `Unique index ${activeEmailIndex.name} enforces one active customer per normalized e-mail.`
      : "No unique index on customers(email_normalized); import de-duplication cannot be enforced."
  });

  const normalizedColumn = facts.columns.get("customers")?.get("email_normalized");
  checks.push({
    id: "import_email_normalized_column",
    label: "Normalized e-mail de-duplication key",
    status: normalizedColumn ? "PASS" : "FAIL",
    detail: normalizedColumn
      ? `customers.email_normalized (${normalizedColumn.dataType}) stores lower(trim(email)), the key used by the importer.`
      : "customers.email_normalized is missing; the importer's de-duplication key has no storage."
  });

  const duplicates = await run(
    `SELECT COUNT(*)::int AS count
       FROM (
         SELECT email_normalized
           FROM customers
          WHERE deleted_at IS NULL
            AND email_normalized IS NOT NULL
          GROUP BY email_normalized
         HAVING COUNT(*) > 1
       ) AS duplicated`
  );
  const duplicateCount = Number(duplicates.rows[0]?.count || 0);

  checks.push({
    id: "import_duplicate_identities",
    label: "Conflicting active customer identity keys",
    status: duplicateCount === 0 ? "PASS" : "FAIL",
    detail:
      duplicateCount === 0
        ? "No duplicate active email_normalized values."
        : `${duplicateCount} normalized e-mail value(s) are used by more than one active customer; merge or soft-delete them before importing.`
  });

  const unnormalized = await run(
    `SELECT COUNT(*)::int AS count
       FROM customers
      WHERE deleted_at IS NULL
        AND email IS NOT NULL
        AND btrim(email) <> ''
        AND (email_normalized IS NULL OR email_normalized <> lower(btrim(email)))`
  );
  const unnormalizedCount = Number(unnormalized.rows[0]?.count || 0);

  checks.push({
    id: "import_email_normalization_consistency",
    label: "Stored e-mails are normalized consistently",
    status: unnormalizedCount === 0 ? "PASS" : "WARN",
    detail:
      unnormalizedCount === 0
        ? "Every active customer with an e-mail has a matching email_normalized value."
        : `${unnormalizedCount} active customer row(s) have a missing or stale email_normalized value.`
  });

  if (facts.tables.has("imported_bookings")) {
    const dedupeUnique = hasUniqueOn(facts, "imported_bookings", "dedupe_key");
    checks.push({
      id: "import_dedupe_key_unique",
      label: "imported_bookings.dedupe_key is unique",
      status: dedupeUnique ? "PASS" : "FAIL",
      detail: dedupeUnique
        ? "Re-running an import cannot create duplicate booking rows."
        : "No unique constraint/index on dedupe_key; a re-run would duplicate bookings."
    });

    const bookingFk = hasForeignKey(facts, "imported_bookings", "import_batch_id", "import_batches");
    checks.push({
      id: "import_batch_fk",
      label: "imported_bookings references import_batches",
      status: bookingFk ? "PASS" : "WARN",
      detail: bookingFk ? "Foreign key present." : "No foreign key found on import_batch_id."
    });
  }

  if (facts.tables.has("imported_customers")) {
    const emailUnique = hasUniqueOn(facts, "imported_customers", "email");
    checks.push({
      id: "import_imported_customers_email_unique",
      label: "imported_customers.email is unique",
      status: emailUnique ? "PASS" : "FAIL",
      detail: emailUnique
        ? "Aggregated import customers are keyed uniquely by e-mail."
        : "No unique constraint/index on imported_customers.email."
    });
  }

  const sources = await run(
    `SELECT source, COUNT(*)::int AS count
       FROM customers
      WHERE deleted_at IS NULL
      GROUP BY source
      ORDER BY source`
  );
  const sourceSummary = sources.rows
    .map((row) => `${row.source}=${row.count}`)
    .join(", ");
  const seedRow = sources.rows.find((row) => String(row.source) === "seed");
  const seedCount = Number(seedRow?.count || 0);

  checks.push({
    id: "import_existing_customer_population",
    label: "Existing active customer population",
    status: seedCount > 0 ? "WARN" : "PASS",
    detail:
      (sourceSummary ? `Active customers by source: ${sourceSummary}. ` : "No active customers. ") +
      (seedCount > 0
        ? "Demo/seed records are still present; review npm run cleanup:demo before a production import."
        : "No demo/seed records present.")
  });

  const batches = facts.tables.has("import_batches")
    ? await run(`SELECT COUNT(*)::int AS count FROM import_batches`)
    : { rows: [{ count: 0 }] };

  checks.push({
    id: "import_previous_batches",
    label: "Previous import batches",
    status: "PASS",
    detail: `${Number(batches.rows[0]?.count || 0)} import batch record(s) on file. The audit did not run an import.`
  });

  return {
    id: "customer_import",
    label: "Customer import readiness",
    status: sectionStatus(checks),
    checks
  };
}

function notVerifiedSections(reason: string): AuditSection[] {
  const check = (id: AuditSection["id"], label: string): AuditSection => ({
    id,
    label,
    status: "NOT_VERIFIED",
    checks: [
      {
        id: `${id}_not_verified`,
        label: "Verification not performed",
        status: "UNKNOWN",
        detail: reason
      }
    ]
  });

  return [
    check("auth_schema", "Auth schema readiness"),
    check("customer_schema", "Customer schema readiness"),
    check("customer_import", "Customer import readiness")
  ];
}

/**
 * Runs the audit against an already-open read-only runner. Exported so tests can
 * drive it with a mock runner or a test-database client.
 */
export async function auditDatabaseReadiness(run: QueryRunner): Promise<AuditSection[]> {
  const facts = await loadSchemaFacts(run);

  return [
    await auditAuthSchema(run, facts),
    await auditCustomerSchema(run, facts),
    await auditCustomerImport(run, facts)
  ];
}

export type RunAuditOptions = {
  /** Overridable for tests; defaults to the shared pool from DATABASE_URL. */
  connect?: () => Promise<PoolClient>;
  databaseUrl?: string;
};

/**
 * Connects using the existing `DATABASE_URL` behaviour, runs the audit inside a
 * `READ ONLY` transaction and always rolls back. Never throws for a missing or
 * unreachable database: the report then carries `NOT_VERIFIED`.
 */
export async function runDatabaseReadinessAudit(
  options: RunAuditOptions = {}
): Promise<ReadinessReport> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const target = describeDatabaseTarget(databaseUrl);
  const notes = [
    "This audit is read-only: it runs only SELECT/metadata queries inside a READ ONLY transaction.",
    `It never creates ${maskEmail(FUTURE_SUPERUSER_EMAIL)}, never modifies ${maskEmail(
      OPERATIONAL_ACCOUNT_EMAIL
    )}, and never imports customers.`,
    "Statuses describe only the database that was actually connected to; a local or test database says nothing about production."
  ];

  if (!target.configured) {
    return {
      generatedAt: new Date().toISOString(),
      target,
      sections: notVerifiedSections(target.problem || "DATABASE_URL is not configured."),
      notes
    };
  }

  let client: PoolClient | null = null;

  try {
    client = await (options.connect ? options.connect() : getPool().connect());
    await client.query("BEGIN READ ONLY");

    try {
      const sections = await auditDatabaseReadiness(createReadOnlyRunner(client));

      return {
        generatedAt: new Date().toISOString(),
        target: { ...target, reachable: true },
        sections,
        notes
      };
    } finally {
      // Nothing was written, but rolling back keeps the guarantee explicit.
      await client.query("ROLLBACK");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";

    return {
      generatedAt: new Date().toISOString(),
      target: {
        ...target,
        problem: `The configured database could not be inspected (${message}).`
      },
      sections: notVerifiedSections(
        "The configured database could not be inspected, so readiness could not be verified."
      ),
      notes
    };
  } finally {
    client?.release();
  }
}

/** Renders the machine-readable report as human-readable text. */
export function formatReadinessReport(report: ReadinessReport): string {
  const lines: string[] = [];

  lines.push("RideMatrix database readiness audit (read-only)");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(
    `Target: ${report.target.redactedTarget ?? "(not configured)"} — ${
      report.target.reachable ? "inspected" : "NOT inspected"
    }`
  );

  if (report.target.problem) {
    lines.push(`Problem: ${report.target.problem}`);
  }

  lines.push("");

  for (const section of report.sections) {
    lines.push(`${section.label}: ${section.status}`);

    for (const check of section.checks) {
      lines.push(`  [${check.status}] ${check.label} — ${check.detail}`);
    }

    lines.push("");
  }

  for (const note of report.notes) {
    lines.push(`Note: ${note}`);
  }

  return lines.join("\n");
}
