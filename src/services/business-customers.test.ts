import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MIGRATIONS } from "../database/migrations";
import { validateBusinessCustomer, type BusinessFormData } from "./business-customers";

function validForm(): BusinessFormData {
  return {
    registeredName: "  Example Business Ltd  ",
    registeredHouseNameNumber: "12A",
    registeredAddressLine1: "High Street",
    registeredCityTown: "Dorchester",
    registeredPostcode: "DT1 1AA",
    registeredCountry: "United Kingdom",
    officePhone: "020 7946 0958",
    officeEmail: " OFFICE@Example.com ",
    bookerFullName: "Alex Booker",
    bookerEmail: "booker@example.com",
    bookerPhone: "+44 7911 123456",
    bookingAuthRequired: "yes",
    bookingAuthChannel: "both",
    accountsFullName: "Finance Team",
    accountsEmail: "finance@example.com"
  };
}

test("validates a complete business, normalizes contacts and permits a blank operational address", () => {
  const result = validateBusinessCustomer(validForm());
  assert.deepEqual(result.errors, []);
  assert.ok(result.input);
  assert.equal(result.input.registeredName, "Example Business Ltd");
  assert.equal(result.input.officePhone, "+442079460958");
  assert.equal(result.input.officeEmail, "office@example.com");
  assert.equal(result.input.bookerPhone, "+447911123456");
  assert.equal(result.input.bookingAuthRequired, true);
  assert.equal(result.input.bookingAuthChannel, "both");
  assert.equal(result.input.accountsEmail, "finance@example.com");
  assert.equal(result.input.accountsPhone, null);
  assert.equal(result.input.operationalAddress.addressLine1, "");
  assert.equal(result.input.registeredAddress.latitude, null);
  assert.equal(result.data.registeredName, "Example Business Ltd");
});

test("accepts full structured addresses, boundary coordinates and an optional accounts phone", () => {
  const result = validateBusinessCustomer({
    ...validForm(),
    registeredAddressLine2: "Business Park",
    registeredAddressLine3: "West Wing",
    registeredCounty: "Dorset",
    registeredState: "England",
    registeredLatitude: "-90", registeredLongitude: "180",
    operationalAddressLine1: "Depot Road", operationalCityTown: "Poole",
    operationalPostcode: "BH15 1AA", operationalCountry: "GB",
    operationalLatitude: "0", operationalLongitude: "-180",
    accountsFullName: " Finance Team ", accountsEmail: " FINANCE@EXAMPLE.COM ",
    accountsPhone: "0044 20 7946 0958"
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.input?.registeredAddress.latitude, -90);
  assert.equal(result.input?.registeredAddress.longitude, 180);
  assert.equal(result.input?.operationalAddress.latitude, 0);
  assert.equal(result.input?.registeredAddress.addressLine3, "West Wing");
  assert.equal(result.input?.registeredAddress.county, "Dorset");
  assert.equal(result.input?.accountsFullName, "Finance Team");
  assert.equal(result.input?.accountsEmail, "finance@example.com");
  assert.equal(result.input?.accountsPhone, "+442079460958");
});

test("requires all mandatory business, registered address, booker and accounts fields", () => {
  for (const field of [
    "registeredName", "registeredHouseNameNumber", "registeredAddressLine1", "registeredCityTown",
    "registeredPostcode", "registeredCountry", "officePhone", "officeEmail",
    "bookerFullName", "bookerEmail", "bookerPhone", "bookingAuthRequired",
    "accountsFullName", "accountsEmail"
  ]) {
    const result = validateBusinessCustomer({ ...validForm(), [field]: " " });
    assert.equal(result.input, undefined, field);
    assert.ok(result.errors.length > 0, field);
  }
});

test("rejects malformed inputs rather than coercing arrays and objects to strings", () => {
  for (const input of [null, undefined, true, 3, "text", [], {}]) {
    const result = validateBusinessCustomer(input);
    assert.ok(result.errors.length > 0);
    assert.equal(result.input, undefined);
  }
  for (const value of [["yes"], { value: "yes" }, true]) {
    const result = validateBusinessCustomer({ ...validForm(), bookingAuthRequired: value });
    assert.equal(result.input, undefined);
    assert.ok(result.errors.some((error) => error.includes("single text")));
  }
});

test("validates every supplied email and phone", () => {
  for (const field of ["officeEmail", "bookerEmail", "accountsEmail"]) {
    for (const invalid of ["invalid", "a@@example.com", "a b@example.com", "a@example"]) {
      const result = validateBusinessCustomer({ ...validForm(), [field]: invalid });
      assert.equal(result.input, undefined, `${field}: ${invalid}`);
      assert.ok(result.errors.some((error) => error.includes("valid email")));
    }
  }
  for (const field of ["officePhone", "bookerPhone", "accountsPhone"]) {
    const result = validateBusinessCustomer({ ...validForm(), [field]: "123" });
    assert.equal(result.input, undefined);
    assert.ok(result.errors.some((error) => error.includes("valid phone")));
  }
});

test("authorization requires an explicit choice and conditional valid channel", () => {
  for (const value of ["", "true", "false", "Yes", "0"]) {
    assert.equal(validateBusinessCustomer({ ...validForm(), bookingAuthRequired: value }).input, undefined);
  }
  for (const channel of ["", "sms", "Email"]) {
    assert.equal(validateBusinessCustomer({ ...validForm(), bookingAuthChannel: channel }).input, undefined);
  }
  for (const channel of ["email", "whatsapp", "both"]) {
    assert.equal(validateBusinessCustomer({ ...validForm(), bookingAuthChannel: channel }).input?.bookingAuthChannel, channel);
  }
  const noAuth = validateBusinessCustomer({ ...validForm(), bookingAuthRequired: "no", bookingAuthChannel: "both" });
  assert.deepEqual(noAuth.errors, []);
  assert.equal(noAuth.input?.bookingAuthRequired, false);
  assert.equal(noAuth.input?.bookingAuthChannel, null);
  assert.equal(noAuth.data.bookingAuthChannel, "");
});

test("partial operational addresses require street, city, postcode and country but not house number", () => {
  for (const field of ["operationalHouseNameNumber", "operationalAddressLine2", "operationalCounty", "operationalLatitude"]) {
    const result = validateBusinessCustomer({ ...validForm(), [field]: "1" });
    assert.equal(result.input, undefined);
    assert.ok(result.errors.some((error) => error.includes("Operational address: addressLine1")));
  }
  const result = validateBusinessCustomer({
    ...validForm(), operationalAddressLine1: "Depot Road", operationalCityTown: "Poole",
    operationalPostcode: "BH15 1AA", operationalCountry: "UK"
  });
  assert.deepEqual(result.errors, []);
});

test("coordinates must be strictly numeric, finite, paired and within their respective ranges", () => {
  for (const prefix of ["registered", "operational"]) {
    const base = {
      ...validForm(), operationalAddressLine1: "Depot Road", operationalCityTown: "Poole",
      operationalPostcode: "BH15 1AA", operationalCountry: "UK"
    };
    for (const [latitude, longitude] of [
      ["51", ""], ["", "-2"], ["NaN", "1"], ["Infinity", "1"], ["1", "-Infinity"],
      ["90.01", "0"], ["-90.01", "0"], ["0", "180.01"], ["0", "-180.01"],
      ["0x10", "0"], ["1north", "0"], ["1e999", "0"]
    ]) {
      const result = validateBusinessCustomer({
        ...base, [`${prefix}Latitude`]: latitude, [`${prefix}Longitude`]: longitude
      });
      assert.equal(result.input, undefined, `${prefix}: ${latitude}, ${longitude}`);
      assert.ok(result.errors.length > 0);
    }
  }
});

test("plain SQL migration exactly matches the native migration", () => {
  const native = MIGRATIONS.find((migration) => migration.id === "0021_business_customers");
  assert.ok(native);
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  assert.equal(normalize(readFileSync("sql/0021_business_customers.sql", "utf8")), normalize(native.sql));
});
