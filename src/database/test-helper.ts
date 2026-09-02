import pg from "pg";
import { closeDatabase, initializeDatabase } from "./connection";

const { Pool } = pg;

export function getBaseTestDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgres://runner@127.0.0.1:5432/ridematrix_test"
  );
}

/**
 * Shape of `users.status` in the test schema. Production deployments own the
 * auth schema and model the column as the `user_status` enum, so tests can
 * reproduce that shape without touching any production database.
 */
export type AuthTablesOptions = {
  statusEnumValues?: string[];
  statusDefault?: string;
};

export type TestDatabaseContext = {
  schemaName: string;
  databaseUrl: string;
  cleanup: () => Promise<void>;
  createAuthTables: (options?: AuthTablesOptions) => Promise<void>;
  countAuthRows: () => Promise<{ users: number; roles: number; permissions: number }>;
};

let schemaCounter = 0;

export async function createTestDatabaseContext(prefix: string): Promise<TestDatabaseContext> {
  const baseUrl = getBaseTestDatabaseUrl();
  schemaCounter += 1;
  const schemaName = `${prefix}_${Date.now()}_${schemaCounter}_${Math.floor(Math.random() * 100000)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let cleanedUp = false;

  const adminPool = new Pool({ connectionString: baseUrl });
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName};`);

  const separator = baseUrl.includes("?") ? "&" : "?";
  const databaseUrl = `${baseUrl}${separator}options=-csearch_path%3D${schemaName}`;

  await closeDatabase();
  process.env.DATABASE_URL = databaseUrl;

  const createAuthTables = async (options?: AuthTablesOptions) => {
    const statusDefault = options?.statusDefault ?? "Active";
    let statusColumnDefinition = `VARCHAR(50) DEFAULT '${statusDefault}'`;

    if (options?.statusEnumValues) {
      const labels = options.statusEnumValues.map((value) => `'${value.replace(/'/g, "''")}'`);
      await adminPool.query(
        `CREATE TYPE ${schemaName}.user_status AS ENUM (${labels.join(", ")});`
      );
      statusColumnDefinition = `${schemaName}.user_status DEFAULT '${statusDefault}'::${schemaName}.user_status`;
    }

    await adminPool.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.roles (
        id SERIAL PRIMARY KEY,
        key VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100),
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ${schemaName}.permissions (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ${schemaName}.role_permissions (
        role_id INTEGER REFERENCES ${schemaName}.roles(id) ON DELETE CASCADE,
        permission_id INTEGER REFERENCES ${schemaName}.permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      );

      CREATE TABLE IF NOT EXISTS ${schemaName}.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        status ${statusColumnDefinition},
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ${schemaName}.user_roles (
        user_id UUID REFERENCES ${schemaName}.users(id) ON DELETE CASCADE,
        role_id INTEGER REFERENCES ${schemaName}.roles(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, role_id)
      );

      CREATE TABLE IF NOT EXISTS ${schemaName}.login_codes (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        code VARCHAR(10) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO ${schemaName}.roles (id, key, description) VALUES
        (1, 'admin', 'Administrator'),
        (2, 'driver', 'Driver')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO ${schemaName}.permissions (id, key, description) VALUES
        (1, 'view_dashboard', 'View Dashboard'),
        (2, 'manage_users', 'Manage Users')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO ${schemaName}.users (id, email, status) VALUES
        ('a0000000-0000-0000-0000-000000000001', 'admin@ridematrix.com', '${statusDefault}'),
        ('a0000000-0000-0000-0000-000000000002', 'driver@ridematrix.com', '${statusDefault}')
      ON CONFLICT (id) DO NOTHING;
    `);
  };

  const countAuthRows = async () => {
    const resUsers = await adminPool.query(`SELECT COUNT(*)::int AS count FROM ${schemaName}.users;`);
    const resRoles = await adminPool.query(`SELECT COUNT(*)::int AS count FROM ${schemaName}.roles;`);
    const resPerms = await adminPool.query(`SELECT COUNT(*)::int AS count FROM ${schemaName}.permissions;`);
    return {
      users: resUsers.rows[0].count,
      roles: resRoles.rows[0].count,
      permissions: resPerms.rows[0].count
    };
  };

  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    await closeDatabase();
    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
    } finally {
      try {
        await adminPool.end();
      } finally {
        if (process.env.DATABASE_URL === databaseUrl) {
          if (previousDatabaseUrl === undefined) {
            delete process.env.DATABASE_URL;
          } else {
            process.env.DATABASE_URL = previousDatabaseUrl;
          }
        }
      }
    }
  };

  return {
    schemaName,
    databaseUrl,
    cleanup,
    createAuthTables,
    countAuthRows
  };
}
