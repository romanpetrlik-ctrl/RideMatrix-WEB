import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, initializeDatabase, query  } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext, safeCleanupTestDatabase } from "../database/test-helper";
import {
  createCustomer,
  deleteCustomer,
  getCustomerByEmail,
  getCustomerById,
  getCustomerCount,
  listRecentBookingsForCustomer,
  listCustomers,
  updateCustomer
} from "./customers";

let dbContext: TestDatabaseContext;

before(async () => {
  dbContext = await createTestDatabaseContext("test_customers");
  await dbContext.createAuthTables();
  await initializeDatabase();
});

after(async () => {
  await safeCleanupTestDatabase(dbContext);
});

/** Simulates a process restart by dropping the cached pool. */
async function restart(): Promise<void> {
  await closeDatabase();
}

test("seeds the demo customers exactly once, even across restarts", async () => {
  assert.equal(await getCustomerCount(), 18);

  await restart();
  await initializeDatabase();

  assert.equal(await getCustomerCount(), 18);
});

test("persists created customers across a restart", async () => {
  const created = await createCustomer({
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

  await restart();

  const reloaded = await getCustomerById(created.id);

  assert.ok(reloaded);
  assert.equal(reloaded.surname, "Novak");
  assert.equal(reloaded.houseNameNumber, "12A");
  assert.equal(reloaded.cityTown, "Manchester");
  assert.equal(reloaded.postcode, "M1 2AB");
  assert.equal(reloaded.status, "Active");
});

test("looks customers up by normalized email", async () => {
  const found = await getCustomerByEmail("  PETRA.NOVAK@example.COM ");

  assert.ok(found);
  assert.equal(found.givenName, "Petra");
});

test("persists updates and status changes", async () => {
  const customer = await getCustomerByEmail("petra.novak@example.com");
  assert.ok(customer);

  await updateCustomer(customer.id, { status: "Suspended", notes: "On hold." });

  await restart();

  const reloaded = await getCustomerById(customer.id);
  assert.ok(reloaded);
  assert.equal(reloaded.status, "Suspended");
  assert.equal(reloaded.notes, "On hold.");
});

test("lists at most five recent bookings for the requested customer", async () => {
  const customer = await createCustomer({
    givenName: "Recent",
    surname: "Bookings",
    email: "recent.bookings@example.com",
    phone: "+44 7700 900299",
    status: "Active"
  });

  for (let index = 0; index < 6; index += 1) {
    await query(
      `INSERT INTO customer_bookings
       (id, customer_id, reference, service_date, pickup, dropoff, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        `recent-booking-${index}`,
        customer.id,
        `REC-${index}`,
        `2026-09-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
        `Pickup ${index}`,
        `Dropoff ${index}`,
        "Completed",
        new Date().toISOString()
      ]
    );
  }

  const bookings = await listRecentBookingsForCustomer(customer.id);

  assert.equal(bookings.length, 5);
  assert.equal(bookings[0].reference, "REC-5");
  assert.ok(bookings.every((booking) => booking.reference.startsWith("REC-")));
});

test("filters, searches and paginates the persisted list", async () => {
  const suspended = await listCustomers({ search: "", status: "Suspended", page: 1, perPage: 10 });
  assert.ok(suspended.customers.every((customer) => customer.status === "Suspended"));
  assert.ok(suspended.totalRecords >= 1);

  const byName = await listCustomers({ search: "adams", status: "all", page: 1, perPage: 10 });
  assert.equal(byName.totalRecords, 1);
  assert.equal(byName.customers[0].surname, "Adams");

  const byPhone = await listCustomers({ search: "7700900101", status: "all", page: 1, perPage: 10 });
  assert.equal(byPhone.totalRecords, 1);
  assert.equal(byPhone.customers[0].surname, "Adams");

  const firstPage = await listCustomers({ search: "", status: "all", page: 1, perPage: 10 });
  assert.equal(firstPage.customers.length, 10);
  assert.equal(firstPage.page, 1);

  const secondPage = await listCustomers({ search: "", status: "all", page: 2, perPage: 10 });
  assert.equal(secondPage.page, 2);
  assert.notEqual(firstPage.customers[0].id, secondPage.customers[0].id);
});

test("soft-deletes a customer but retains the booking history", async () => {
  const countBefore = await getCustomerCount();
  const target = await getCustomerById("cust-001");
  assert.ok(target);
  assert.ok(target.bookings.length > 0);

  assert.equal(await deleteCustomer("cust-001"), true);
  assert.equal(await deleteCustomer("cust-001"), false);
  assert.equal(await getCustomerById("cust-001"), undefined);
  assert.equal(await getCustomerCount(), countBefore - 1);

  await restart();

  assert.equal(await getCustomerById("cust-001"), undefined);

  const retainedBookings = await query<{ total: number }>(
    "SELECT COUNT(*)::int AS total FROM customer_bookings WHERE customer_id = $1",
    ["cust-001"]
  );

  assert.equal(Number(retainedBookings.rows[0].total), 2);
});

test("does not resurrect deleted seed customers on restart", async () => {
  await restart();
  await initializeDatabase();

  assert.equal(await getCustomerById("cust-001"), undefined);
});

test("preserves existing auth tables and auth data", async () => {
  const authCounts = await dbContext.countAuthRows();
  assert.equal(authCounts.users, 2);
  assert.equal(authCounts.roles, 2);
  assert.equal(authCounts.permissions, 2);
});
