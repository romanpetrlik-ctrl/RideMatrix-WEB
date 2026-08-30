import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, initializeDatabase } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import { findInactiveCustomers } from "./customer-inactivity-cleanup";
import { createCustomer, deleteCustomer, getCustomerById } from "./customers";

let dbContext: TestDatabaseContext;

before(async () => {
  dbContext = await createTestDatabaseContext("test_inactivity");
  await initializeDatabase();
});

after(async () => {
  await dbContext.cleanup();
});

test("only reports customers without recent bookings as inactive", async () => {
  const inactive = await findInactiveCustomers(12);

  assert.ok(inactive.every((customer) => customer.bookings.length === 0));
  assert.ok(inactive.some((customer) => customer.id === "cust-003"));
  assert.ok(!inactive.some((customer) => customer.id === "cust-001"));
});

test("keeps a freshly created customer out of the inactive set", async () => {
  const created = await createCustomer({
    givenName: "Recent",
    surname: "Signup",
    email: "recent.signup@example.com",
    phone: null,
    status: "Active"
  });

  const inactive = await findInactiveCustomers(12);

  assert.ok(!inactive.some((customer) => customer.id === created.id));
});

test("deletion performed by the cleanup survives a restart", async () => {
  assert.equal(await deleteCustomer("cust-003"), true);

  await closeDatabase();

  assert.equal(await getCustomerById("cust-003"), undefined);
});
