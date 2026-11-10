import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAirportPickupTimingRule,
  validateAirportFeeForm,
  type AirportFeeRecord
} from "./airport-fees";

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
    pickupFee: "4.5",
    pickupTimeReference: "ALT",
    pickupDeferredPolicy: "no",
    pickupDeferredMinutes: "0",
    pickupFeeCoveredMinutes: "30"
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
  assert.equal(result.values.pickupTimeReference, "ALT");
  assert.equal(result.values.pickupDeferredMinutes, "0");
  assert.equal(result.values.pickupFeeCoveredMinutes, "30");
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

test("airport pick-up timing requires an explicit supported time reference and fee-covered period", () => {
  const form = validForm();
  form.pickupTimeReference = "";
  form.pickupFeeCoveredMinutes = "25";

  const invalid = validateAirportFeeForm(form);

  assert.match(invalid.errors.pickupTimeReference, /Select Actual Landing Time/);
  assert.match(invalid.errors.pickupFeeCoveredMinutes, /fee-covered period/);
  assert.equal(invalid.values.pickupFee, "4.5");

  for (const reference of ["ALT", "AGA"]) {
    const valid = validateAirportFeeForm({ ...validForm(), pickupTimeReference: reference });
    assert.equal(valid.errors.pickupTimeReference, undefined);
  }
  const unsupported = validateAirportFeeForm({ ...validForm(), pickupTimeReference: "scheduled" });
  assert.match(unsupported.errors.pickupTimeReference, /Select Actual Landing Time/);
});

test("airport pick-up deferred policy accepts only consistent Yes/No and minutes values", () => {
  const noDeferredPeriod = validateAirportFeeForm({
    ...validForm(),
    pickupDeferredPolicy: "no",
    pickupDeferredMinutes: "0"
  });
  assert.equal(noDeferredPeriod.errors.pickupDeferredPolicy, undefined);
  assert.equal(noDeferredPeriod.errors.pickupDeferredMinutes, undefined);

  const deferredPeriod = validateAirportFeeForm({
    ...validForm(),
    pickupDeferredPolicy: "yes",
    pickupDeferredMinutes: "15"
  });
  assert.equal(deferredPeriod.errors.pickupDeferredMinutes, undefined);

  for (const minutes of ["15", "30", "45", "60"]) {
    const valid = validateAirportFeeForm({
      ...validForm(),
      pickupDeferredPolicy: "yes",
      pickupDeferredMinutes: minutes
    });
    assert.equal(valid.errors.pickupDeferredMinutes, undefined);
  }
  for (const minutes of ["10", "15", "20", "30", "40", "45", "60"]) {
    const valid = validateAirportFeeForm({ ...validForm(), pickupFeeCoveredMinutes: minutes });
    assert.equal(valid.errors.pickupFeeCoveredMinutes, undefined);
  }

  for (const [policy, minutes] of [["", "0"], ["yes", "0"], ["no", "15"], ["yes", "5"], ["maybe", "30"]]) {
    const invalid = validateAirportFeeForm({
      ...validForm(),
      pickupDeferredPolicy: policy,
      pickupDeferredMinutes: minutes
    });
    assert.ok(invalid.errors.pickupDeferredPolicy || invalid.errors.pickupDeferredMinutes);
  }
});

test("pick-up timing rule describes the complete relative window without changing the configured fee", () => {
  const record: AirportFeeRecord = {
    id: "airport-1",
    displayName: "Example Airport",
    dropoffPlaceId: "dropoff",
    dropoffLocationLabel: "Drop-off",
    dropoffLatitude: 1,
    dropoffLongitude: 1,
    dropoffFee: "2.00",
    pickupPlaceId: "pickup",
    pickupLocationLabel: "Pick-up",
    pickupLatitude: 1,
    pickupLongitude: 1,
    pickupFee: "8.00",
    pickupTimeReference: "AGA",
    pickupDeferredEnabled: true,
    pickupDeferredMinutes: 30,
    pickupFeeCoveredMinutes: 30,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  assert.equal(
    formatAirportPickupTimingRule(record),
    "Customer time window: 60 minutes from Actual Gate Arrival (AGA); first 30 minutes are deferred, then the £8.00 pick-up fee covers the following 30 minutes."
  );
  assert.equal(record.pickupFee, "8.00");

  record.pickupTimeReference = null;
  assert.equal(formatAirportPickupTimingRule(record), "Setup incomplete: pick-up timing policy is not configured.");
});
