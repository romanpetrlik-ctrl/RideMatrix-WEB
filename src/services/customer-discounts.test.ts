import assert from "node:assert/strict";
import test from "node:test";
import { InvalidCustomerDiscountError, normalizeCustomerDiscountPercentage } from "./customers";

test("normalizes optional customer discount percentages", () => {
  assert.equal(normalizeCustomerDiscountPercentage(""), null);
  assert.equal(normalizeCustomerDiscountPercentage(" 12.5 "), "12.50");
  assert.equal(normalizeCustomerDiscountPercentage("0.01"), "0.01");
  assert.equal(normalizeCustomerDiscountPercentage("100"), "100.00");
});

test("rejects invalid customer discount percentages", () => {
  for (const value of ["0", "-1", "100.01", "12.345", "1e1", "NaN"]) {
    assert.throws(() => normalizeCustomerDiscountPercentage(value), InvalidCustomerDiscountError, value);
  }
});
