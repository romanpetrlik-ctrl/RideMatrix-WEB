import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closeDatabase, getDatabase } from "../database/connection";
import {
  createCustomer,
  deleteCustomer,
  getCustomerByEmail,
  getCustomerById,
  getCustomerCount,
  listCustomers,
  updateCustomer
} from "./customers";

let temporaryDirectory: string;

before(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ridematrix-customers-"));
  process.env.DATABASE_FILE = path.join(temporaryDirectory, "test.sqlite");
});

after(() => {
  closeDatabase();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

/** Simulates a process restart by dropping the cached connection. */
function restart(): void {
  closeDatabase();
}

test("seeds the demo customers exactly once, even across restarts", () => {
  assert.equal(getCustomerCount(), 18);

  restart();

  assert.equal(getCustomerCount(), 18);
});

test("persists created customers across a restart", () => {
  const created = createCustomer({
    givenName: "Petra",
    surname: "Novak",
    email: "Petra.Novak@Example.com",
    phone: "+44 7700 900200",
    houseNameNumber: "12A",
    addressLine1: "Mill Lane",
    cityTown: "Manchester",
    postcode: "M1 2AB",
    status: "Active"
  });

  restart();

  const reloaded = getCustomerById(created.id);

  assert.ok(reloaded);
  assert.equal(reloaded.surname, "Novak");
  assert.equal(reloaded.houseNameNumber, "12A");
  assert.equal(reloaded.cityTown, "Manchester");
  assert.equal(reloaded.postcode, "M1 2AB");
  assert.equal(reloaded.status, "Active");
});

test("looks customers up by normalized email", () => {
  const found = getCustomerByEmail("  PETRA.NOVAK@example.COM ");

  assert.ok(found);
  assert.equal(found.givenName, "Petra");
});

test("persists updates and status changes", () => {
  const customer = getCustomerByEmail("petra.novak@example.com");
  assert.ok(customer);

  updateCustomer(customer.id, { status: "Suspended", notes: "On hold." });

  restart();

  const reloaded = getCustomerById(customer.id);
  assert.ok(reloaded);
  assert.equal(reloaded.status, "Suspended");
  assert.equal(reloaded.notes, "On hold.");
});

test("filters, searches and paginates the persisted list", () => {
  const suspended = listCustomers({ search: "", status: "Suspended", page: 1, perPage: 10 });
  assert.ok(suspended.customers.every((customer) => customer.status === "Suspended"));
  assert.ok(suspended.totalRecords >= 1);

  const byName = listCustomers({ search: "adams", status: "all", page: 1, perPage: 10 });
  assert.equal(byName.totalRecords, 1);
  assert.equal(byName.customers[0].surname, "Adams");

  const byPhone = listCustomers({ search: "7700900101", status: "all", page: 1, perPage: 10 });
  assert.equal(byPhone.totalRecords, 1);
  assert.equal(byPhone.customers[0].surname, "Adams");

  const firstPage = listCustomers({ search: "", status: "all", page: 1, perPage: 10 });
  assert.equal(firstPage.customers.length, 10);
  assert.equal(firstPage.page, 1);

  const secondPage = listCustomers({ search: "", status: "all", page: 2, perPage: 10 });
  assert.equal(secondPage.page, 2);
  assert.notEqual(firstPage.customers[0].id, secondPage.customers[0].id);
});

test("soft-deletes a customer but retains the booking history", () => {
  const countBefore = getCustomerCount();
  const target = getCustomerById("cust-001");
  assert.ok(target);
  assert.ok(target.bookings.length > 0);

  assert.equal(deleteCustomer("cust-001"), true);
  assert.equal(deleteCustomer("cust-001"), false);
  assert.equal(getCustomerById("cust-001"), undefined);
  assert.equal(getCustomerCount(), countBefore - 1);

  restart();

  assert.equal(getCustomerById("cust-001"), undefined);

  const retainedBookings = getDatabase()
    .prepare("SELECT COUNT(*) AS total FROM customer_bookings WHERE customer_id = ?")
    .get("cust-001") as { total: number };

  assert.equal(Number(retainedBookings.total), 2);
});

test("does not resurrect deleted seed customers on restart", () => {
  restart();

  assert.equal(getCustomerById("cust-001"), undefined);
});
