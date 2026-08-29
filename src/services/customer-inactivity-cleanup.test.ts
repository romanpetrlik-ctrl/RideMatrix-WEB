import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closeDatabase } from "../database/connection";
import { findInactiveCustomers } from "./customer-inactivity-cleanup";
import { createCustomer, deleteCustomer, getCustomerById } from "./customers";

let temporaryDirectory: string;

before(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ridematrix-cleanup-"));
  process.env.DATABASE_FILE = path.join(temporaryDirectory, "test.sqlite");
});

after(() => {
  closeDatabase();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("only reports customers without recent bookings as inactive", () => {
  const inactive = findInactiveCustomers(12);

  assert.ok(inactive.every((customer) => customer.bookings.length === 0));
  assert.ok(inactive.some((customer) => customer.id === "cust-003"));
  assert.ok(!inactive.some((customer) => customer.id === "cust-001"));
});

test("keeps a freshly created customer out of the inactive set", () => {
  const created = createCustomer({
    givenName: "Recent",
    surname: "Signup",
    email: "recent.signup@example.com",
    phone: null,
    status: "Active"
  });

  const inactive = findInactiveCustomers(12);

  assert.ok(!inactive.some((customer) => customer.id === created.id));
});

test("deletion performed by the cleanup survives a restart", () => {
  assert.equal(deleteCustomer("cust-003"), true);

  closeDatabase();

  assert.equal(getCustomerById("cust-003"), undefined);
});
