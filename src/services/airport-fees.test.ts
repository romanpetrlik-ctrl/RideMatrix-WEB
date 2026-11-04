import assert from "node:assert/strict";
import test from "node:test";
import { validateAirportFeeForm } from "./airport-fees";

function validForm() {
  return {
    displayName: "Bournemouth Airport (BOH)",
    dropoffPlaceId: "ChIJ-operational-point",
    dropoffLocationLabel: "Bournemouth Airport Car Park 1",
    dropoffLatitude: "50.7799",
    dropoffLongitude: "-1.8425",
    dropoffFee: "0",
    pickupPlaceId: "ChIJ-operational-point",
    pickupLocationLabel: "Bournemouth Airport Car Park 1",
    pickupLatitude: "50.7799",
    pickupLongitude: "-1.8425",
    pickupFee: "4.5"
  };
}

test("airport fees accept independently selected pickup and drop-off Places", () => {
  const form = validForm();
  form.pickupPlaceId = "ChIJ-pickup";
  form.pickupLocationLabel = "Terminal pickup";
  form.pickupLatitude = "50.781";
  form.pickupLongitude = "-1.84";

  const result = validateAirportFeeForm(form);

  assert.deepEqual(result.errors, {});
  assert.equal(result.values.displayName, "Bournemouth Airport (BOH)");
  assert.equal(result.values.dropoffPlaceId, "ChIJ-operational-point");
  assert.equal(result.values.pickupPlaceId, "ChIJ-pickup");
  assert.equal(result.values.dropoffFee, "0.00");
  assert.equal(result.values.pickupFee, "4.50");
});

test("airport fees accept the same selected Place for both operations", () => {
  const result = validateAirportFeeForm(validForm());

  assert.deepEqual(result.errors, {});
  assert.equal(result.values.dropoffPlaceId, result.values.pickupPlaceId);
  assert.equal(result.values.dropoffLatitude, result.values.pickupLatitude);
  assert.equal(result.values.dropoffLongitude, result.values.pickupLongitude);
});

test("airport fee validation rejects missing Place selections and malformed coordinates", () => {
  const form = validForm();
  form.pickupPlaceId = "";
  form.dropoffLatitude = "5.07799e1";

  const result = validateAirportFeeForm(form);

  assert.match(result.errors.pickupLocation, /Google Places/);
  assert.match(result.errors.dropoffLocation, /Google Places/);
});

test("airport fee validation rejects blank, malformed, and out-of-range amounts", () => {
  const form = validForm();
  form.dropoffFee = "";
  form.pickupFee = "1000000.00";

  const result = validateAirportFeeForm(form);

  assert.match(result.errors.dropoffFee, /GBP amount/);
  assert.match(result.errors.pickupFee, /GBP amount/);
  assert.equal(result.values.dropoffFee, "");
  assert.equal(result.values.pickupFee, "1000000.00");
});

test("airport fee validation preserves invalid submitted values and requires an airport name", () => {
  const form = validForm();
  form.displayName = "";
  form.pickupFee = "1.234";

  const result = validateAirportFeeForm(form);

  assert.match(result.errors.displayName, /airport display name/);
  assert.match(result.errors.pickupFee, /GBP amount/);
  assert.equal(result.values.displayName, "");
  assert.equal(result.values.pickupFee, "1.234");
});
