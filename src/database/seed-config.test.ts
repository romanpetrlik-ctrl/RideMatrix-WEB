import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, initializeDatabase } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import { getCustomerCount } from "../services/customers";

let dbContext: TestDatabaseContext;

before(async () => {
  dbContext = await createTestDatabaseContext("test_seed_config");
});

after(async () => {
  delete process.env.SEED_DEMO_DATA;
  delete process.env.NODE_ENV;
  await dbContext.cleanup();
});

test("does not seed demo customers when SEED_DEMO_DATA=false", async () => {
  process.env.SEED_DEMO_DATA = "false";

  await initializeDatabase();

  assert.equal(await getCustomerCount(), 0);
});

test("does not seed demo customers in production by default, and stays empty across a restart", async () => {
  delete process.env.SEED_DEMO_DATA;
  process.env.NODE_ENV = "production";

  await closeDatabase();
  await initializeDatabase();

  assert.equal(await getCustomerCount(), 0);

  await closeDatabase();
  await initializeDatabase();

  assert.equal(await getCustomerCount(), 0);
});

test("an explicit SEED_DEMO_DATA=true still seeds demo customers even with NODE_ENV=production", async () => {
  const freshContext = await createTestDatabaseContext("test_seed_prod_override");
  process.env.NODE_ENV = "production";
  process.env.SEED_DEMO_DATA = "true";

  await initializeDatabase();

  assert.equal(await getCustomerCount(), 18);

  await freshContext.cleanup();
});
