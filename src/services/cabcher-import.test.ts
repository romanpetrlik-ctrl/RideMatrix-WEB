import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closeDatabase } from "../database/connection";
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

let temporaryDirectory: string;

before(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ridematrix-import-"));
  process.env.DATABASE_FILE = path.join(temporaryDirectory, "test.sqlite");
});

after(() => {
  closeDatabase();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("imports bookings and derives customers durably", () => {
  const result = importCabcherBookings({
    csvContent: CSV,
    originalFilename: "cabcher.csv",
    uploadedBy: "admin@example.com",
    now: IMPORT_TIME
  });

  assert.equal(result.summary.bookingsImported, 3);
  assert.equal(result.summary.customersCreated, 2);
  assert.equal(result.batch.status, "imported");

  closeDatabase();

  assert.equal(listImportBatches().length, 1);
  assert.equal(listDerivedCustomers().length, 2);

  const jane = listDerivedCustomers().find((customer) => customer.email === "jane.doe@example.com");
  assert.ok(jane);
  assert.equal(jane.bookingCountTotal, 2);
});

test("exposes imported customers through the persistent customer service", () => {
  const jane = getCustomerByEmail("jane.doe@example.com");

  assert.ok(jane);
  assert.equal(jane.surname, "Doe");
  assert.equal(jane.status, "Active");
  assert.equal(jane.bookings.length, 2);
});

test("does not duplicate bookings or customers when the same file is imported again", () => {
  const countBefore = getCustomerCount();

  const result = importCabcherBookings({
    csvContent: CSV,
    originalFilename: "cabcher.csv",
    uploadedBy: "admin@example.com",
    now: IMPORT_TIME
  });

  assert.equal(result.summary.bookingsImported, 0);
  assert.equal(result.summary.rejectedRows, 3);
  assert.equal(listDerivedCustomers().length, 2);
  assert.equal(getCustomerCount(), countBefore);

  const jane = getCustomerByEmail("jane.doe@example.com");
  assert.ok(jane);
  assert.equal(listImportedBookingsForCustomer(jane.id).length, 2);
});

test("matches imported bookings to an existing customer with the same email", () => {
  const existing = createCustomer({
    givenName: "Nina",
    surname: "Hall",
    email: "Nina.Hall@Example.com",
    phone: null,
    status: "Active"
  });

  const countBefore = getCustomerCount();

  importCabcherBookings({
    csvContent: [
      "Name,Email,Date & Time,Pick Up,Drop Off",
      "Nina Hall,nina.hall@example.com,03/03/2025 11:00,Bath Spa,Bristol Airport"
    ].join("\n"),
    originalFilename: "second.csv",
    uploadedBy: "admin@example.com",
    now: IMPORT_TIME
  });

  assert.equal(getCustomerCount(), countBefore);

  const reloaded = getCustomerByEmail("nina.hall@example.com");
  assert.ok(reloaded);
  assert.equal(reloaded.id, existing.id);
  assert.equal(reloaded.surname, "Hall");
  assert.equal(reloaded.bookings.length, 1);
});
