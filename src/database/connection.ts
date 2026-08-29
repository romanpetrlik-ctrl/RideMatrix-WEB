import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations";
import { seedCustomers } from "./seed";

export const DEFAULT_DATABASE_FILE = "data/ridematrix.sqlite";

let connection: Database.Database | null = null;

function resolveDatabaseFile(): string {
  const configured = String(process.env.DATABASE_FILE || "").trim() || DEFAULT_DATABASE_FILE;

  if (configured === ":memory:") {
    return configured;
  }

  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function openDatabase(): Database.Database {
  const file = resolveDatabaseFile();

  if (file !== ":memory:") {
    const directory = path.dirname(file);

    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
      throw new Error(
        `Unable to create database directory "${directory}". Check DATABASE_FILE configuration. Cause: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  let database: Database.Database;

  try {
    database = new Database(file);
  } catch (error) {
    throw new Error(
      `Unable to open the SQLite database at "${file}". Check DATABASE_FILE configuration. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (file !== ":memory:") {
    database.pragma("journal_mode = WAL");
  }

  database.pragma("foreign_keys = ON");

  // Used by customer search so that phone numbers can be matched regardless of
  // the separators stored in the database.
  database.function("rm_normalize_phone", { deterministic: true }, (value: unknown) =>
    String(value ?? "").replace(/[^\d+]/g, "").toLowerCase()
  );

  return database;
}

/**
 * Returns the shared SQLite connection, opening it and applying pending
 * migrations and the demo seed on first use.
 */
export function getDatabase(): Database.Database {
  if (connection) {
    return connection;
  }

  const database = openDatabase();

  try {
    runMigrations(database);
    seedCustomers(database);
  } catch (error) {
    database.close();
    throw error;
  }

  connection = database;
  return connection;
}

/**
 * Opens the database eagerly so that configuration problems surface during
 * application startup instead of on the first request.
 */
export function initializeDatabase(): void {
  getDatabase();
}

export function closeDatabase(): void {
  if (!connection) {
    return;
  }

  connection.close();
  connection = null;
}

export function getDatabaseFilePath(): string {
  return resolveDatabaseFile();
}
