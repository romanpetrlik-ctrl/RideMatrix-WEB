import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCustomerAddress,
  buildCustomerAddressFormData,
  hasStructuredCustomerAddress,
  normalizeCustomerAddressFallback,
  parseCustomerCoordinate
} from "./customer-addresses";

test("builds a canonical customer address from structured fields", () => {
  assert.equal(buildCustomerAddress({
    houseNameNumber: " 221B ",
    addressLine1: " Baker   Street ",
    addressLine2: "",
    addressLine3: " Marylebone ",
    cityTown: " London ",
    postcode: " NW1 6XE "
  }), "221B, Baker Street, Marylebone, London, NW1 6XE");
});

test("falls back to the legacy address string when structured fields are absent", () => {
  assert.equal(hasStructuredCustomerAddress({ address: "10 Downing Street, London" }), false);
  assert.equal(normalizeCustomerAddressFallback("  10   Downing Street,\nLondon  "), "10 Downing Street, London");
  assert.deepEqual(buildCustomerAddressFormData({
    address: " 10 Downing Street, London SW1A 2AA ",
    latitude: 51.5034,
    longitude: -0.1276
  }), {
    address: "10 Downing Street, London SW1A 2AA",
    addressSearch: "10 Downing Street, London SW1A 2AA",
    houseNameNumber: "",
    addressLine1: "",
    addressLine2: "",
    addressLine3: "",
    cityTown: "",
    county: "",
    state: "",
    postcode: "",
    latitude: "51.5034",
    longitude: "-0.1276"
  });
});

test("parses optional coordinate strings safely", () => {
  assert.equal(parseCustomerCoordinate("51.5007"), 51.5007);
  assert.equal(parseCustomerCoordinate(""), null);
  assert.equal(parseCustomerCoordinate("not-a-number"), null);
});
