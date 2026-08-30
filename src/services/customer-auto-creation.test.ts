import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, initializeDatabase } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import { getOrCreateCustomer } from "./customer-auto-creation";
import { getCustomerCount } from "./customers";

let dbContext: TestDatabaseContext;

before(async () => {
  dbContext = await createTestDatabaseContext("test_autocreate");
  await initializeDatabase();
});

after(async () => {
  await dbContext.cleanup();
});

test("creates a customer once and reuses it for the same normalized email", async () => {
  const countBefore = await getCustomerCount();

  const first = await getOrCreateCustomer("Guest.User@Example.com", "Guest User", "+44 7700 900400");
  assert.equal(first.isNew, true);

  await closeDatabase();

  const second = await getOrCreateCustomer("  guest.user@example.com ", "Guest User", null);
  assert.equal(second.isNew, false);
  assert.equal(second.customerId, first.customerId);
  assert.equal(await getCustomerCount(), countBefore + 1);
});
