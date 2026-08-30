import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { closeDatabase, initializeDatabase } from "../database/connection";
import { TestDatabaseContext, createTestDatabaseContext } from "../database/test-helper";
import {
  importCabcherBookings,
  listDerivedCustomers,
  listImportBatches,
  listImportedBookingsForCustomer
} from "./cabcher-import";
import { createCustomer, getCustomerByEmail, getCustomerCount } from "./customers";

const CSV = [
  "Name,Email,Date & Time,Pick Up,Drop Off,Contact No.,Vehicle,Payment,Total Fare,Order No.",
  "Jane Doe,JANE.DOE@example.com,01/03/2025 09:30,Leeds Station,Leeds Bradford Airport,+44 7700 900301,Saloon,Card,42.50,A-1",
  "Jane Doe,jane.doe@example.com,05/04/2025 18:00,Leeds Bradford Airport,Leeds Station,+44 7700 900301,Saloon,Cash,44.00,A-2",
  "John Smith,john.smith@example.com,02/03/2025 07:00,York Station,Leeds Station,,Estate,Card,60.00,A-3"
].join("\n");

const IMPORT_TIME = new Date("2026-01-01T00:00:00Z");

let dbContext: TestDatabaseContext;

before(async () => {
  dbContext = await createTestDatabaseContext("test_import");
  await initializeDatabase();
});

after(async () => {
  await dbContext.cleanup();
});

test("imports bookings and derives customers durably", async () => {
  const result = await importCabcherBookings({
    csvContent: CSV,
    originalFilename: "cabcher.csv",
    uploadedBy: "admin@example.com",
    now: IMPORT_TIME
  });

  assert.equal(result.summary.bookingsImported, 3);
  assert.equal(result.summary.customersCreated, 2);
  assert.equal(result.batch.status, "imported");

  await closeDatabase();

  const batches = await listImportBatches();
  const derived = await listDerivedCustomers();
  assert.equal(batches.length, 1);
  assert.equal(derived.length, 2);

  const jane = derived.find((customer) => customer.email === "jane.doe@example.com");
  assert.ok(jane);
  assert.equal(jane.bookingCountTotal, 2);
});

test("exposes imported customers through the persistent customer service", async () => {
  const jane = await getCustomerByEmail("jane.doe@example.com");

  assert.ok(jane);
  assert.equal(jane.surname, "Doe");
  assert.equal(jane.status, "Active");
  assert.equal(jane.bookings.length, 2);
});

test("does not duplicate bookings or customers when the same file is imported again", async () => {
  const countBefore = await getCustomerCount();

  const result = await importCabcherBookings({
    csvContent: CSV,
    originalFilename: "cabcher.csv",
    uploadedBy: "admin@example.com",
    now: IMPORT_TIME
  });

  assert.equal(result.summary.bookingsImported, 0);
  assert.equal(result.summary.rejectedRows, 3);
  const derived = await listDerivedCustomers();
  assert.equal(derived.length, 2);
  assert.equal(await getCustomerCount(), countBefore);

  const jane = await getCustomerByEmail("jane.doe@example.com");
  assert.ok(jane);
  const bookings = await listImportedBookingsForCustomer(jane.id);
  assert.equal(bookings.length, 2);
});

test("matches imported bookings to an existing customer with the same email", async () => {
  const existing = await createCustomer({
    givenName: "Nina",
    surname: "Hall",
    email: "Nina.Hall@Example.com",
    phone: null,
    status: "Active"
  });

  const countBefore = await getCustomerCount();

  await importCabcherBookings({
    csvContent: [
      "Name,Email,Date & Time,Pick Up,Drop Off",
      "Nina Hall,nina.hall@example.com,03/03/2025 11:00,Bath Spa,Bristol Airport"
    ].join("\n"),
    originalFilename: "second.csv",
    uploadedBy: "admin@example.com",
    now: IMPORT_TIME
  });

  assert.equal(await getCustomerCount(), countBefore);

  const reloaded = await getCustomerByEmail("nina.hall@example.com");
  assert.ok(reloaded);
  assert.equal(reloaded.id, existing.id);
  assert.equal(reloaded.surname, "Hall");
  assert.equal(reloaded.bookings.length, 1);
});
