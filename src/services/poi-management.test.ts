import assert from "node:assert/strict";
import test from "node:test";
import { validatePoiFeeForm, validatePoiForm } from "./poi-management";

function validPoi() {
  return {
    displayName: "Configured Hotel Name",
    category: "hotel",
    placeId: "ChIJ-selected-place",
    locationLabel: "Selected Google Place",
    latitude: "51.4701",
    longitude: "-0.4543",
    notes: "Drop-off is free for the first 10 minutes."
  };
}

function validFee(poiId = "poi-stable-id") {
  return {
    poiId,
    action: "EV charging",
    amount: "12.5",
    feeBasis: "per kWh",
    trigger: "confirmation",
    notes: "Operator-confirmed optional service."
  };
}

test("POI validation saves the selected Place ID and coordinates separately from its configured identity", () => {
  const result = validatePoiForm(validPoi());

  assert.deepEqual(result.errors, {});
  assert.equal(result.values.displayName, "Configured Hotel Name");
  assert.equal(result.values.placeId, "ChIJ-selected-place");
  assert.equal(result.values.locationLabel, "Selected Google Place");
  assert.equal(result.values.latitude, "51.4701");
  assert.equal(result.values.longitude, "-0.4543");
  assert.equal(result.values.notes, "Drop-off is free for the first 10 minutes.");
});

test("POI validation rejects a missing Place ID or invalid resolved coordinates and preserves submissions", () => {
  const result = validatePoiForm({
    ...validPoi(),
    displayName: "Typed name",
    placeId: "",
    latitude: "91",
    longitude: "not-a-coordinate"
  });

  assert.match(result.errors.location, /Google Places/);
  assert.equal(result.values.displayName, "Typed name");
  assert.equal(result.values.placeId, "");
  assert.equal(result.values.latitude, "91");
});

test("POI Fee validation requires an existing POI, a valid amount, explicit basis, and trigger", () => {
  const invalid = validatePoiFeeForm({
    ...validFee("missing-poi"),
    amount: "6.001",
    feeBasis: "",
    trigger: ""
  }, ["poi-stable-id"]);

  assert.match(invalid.errors.poiId, /existing POI/);
  assert.match(invalid.errors.amount, /GBP amount/);
  assert.match(invalid.errors.feeBasis, /basis or unit/);
  assert.match(invalid.errors.trigger, /Choose/);

  const valid = validatePoiFeeForm(validFee(), ["poi-stable-id"]);
  assert.deepEqual(valid.errors, {});
  assert.equal(valid.values.amount, "12.50");
  assert.equal(valid.values.trigger, "confirmation");
});

test("POI Fee validation accepts independently configured fee bases and selection triggers", () => {
  const result = validatePoiFeeForm({
    ...validFee(),
    action: "Drop-off",
    amount: "6",
    feeBasis: "per visit",
    trigger: "selection",
    notes: ""
  }, ["poi-stable-id"]);

  assert.deepEqual(result.errors, {});
  assert.equal(result.values.amount, "6.00");
  assert.equal(result.values.feeBasis, "per visit");
  assert.equal(result.values.trigger, "selection");
});

test("POI Fee validation preserves invalid values for field-level correction", () => {
  const result = validatePoiFeeForm({
    ...validFee(),
    amount: "1000000.00",
    feeBasis: "x".repeat(101)
  }, ["poi-stable-id"]);

  assert.match(result.errors.amount, /GBP amount/);
  assert.match(result.errors.feeBasis, /100 characters/);
  assert.equal(result.values.amount, "1000000.00");
  assert.equal(result.values.feeBasis, "x".repeat(101));
});
