import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closeDatabase, getDatabase } from "../database/connection";
import { getCustomerCount } from "../services/customers";

let temporaryDirectory: string;

before(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ridematrix-seed-config-"));
  process.env.DATABASE_FILE = path.join(temporaryDirectory, "test.sqlite");
});

after(() => {
  closeDatabase();
  delete process.env.SEED_DEMO_DATA;
  delete process.env.NODE_ENV;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("does not seed demo customers when SEED_DEMO_DATA=false", () => {
  process.env.SEED_DEMO_DATA = "false";

  getDatabase();

  assert.equal(getCustomerCount(), 0);
});

test("does not seed demo customers in production by default, and stays empty across a restart", () => {
  delete process.env.SEED_DEMO_DATA;
  process.env.NODE_ENV = "production";

  closeDatabase();
  getDatabase();

  assert.equal(getCustomerCount(), 0);

  closeDatabase();
  getDatabase();

  assert.equal(getCustomerCount(), 0);
});

test("an explicit SEED_DEMO_DATA=true still seeds demo customers even with NODE_ENV=production", () => {
  process.env.NODE_ENV = "production";
  process.env.SEED_DEMO_DATA = "true";

  closeDatabase();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  process.env.DATABASE_FILE = path.join(temporaryDirectory, "test-seeded.sqlite");

  getDatabase();

  assert.equal(getCustomerCount(), 18);
});
