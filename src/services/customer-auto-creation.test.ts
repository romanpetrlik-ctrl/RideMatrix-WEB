import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closeDatabase } from "../database/connection";
import { getOrCreateCustomer } from "./customer-auto-creation";
import { getCustomerCount } from "./customers";

let temporaryDirectory: string;

before(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ridematrix-auto-creation-"));
  process.env.DATABASE_FILE = path.join(temporaryDirectory, "test.sqlite");
});

after(() => {
  closeDatabase();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("creates a customer once and reuses it for the same normalized email", () => {
  const countBefore = getCustomerCount();

  const first = getOrCreateCustomer("Guest.User@Example.com", "Guest User", "+44 7700 900400");
  assert.equal(first.isNew, true);

  closeDatabase();

  const second = getOrCreateCustomer("  guest.user@example.com ", "Guest User", null);
  assert.equal(second.isNew, false);
  assert.equal(second.customerId, first.customerId);
  assert.equal(getCustomerCount(), countBefore + 1);
});
