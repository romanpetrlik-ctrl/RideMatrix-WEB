import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

function loadAutocomplete() {
  const source = fs.readFileSync(path.join(process.cwd(), "public/js/customer-address-autocomplete.js"), "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.runInNewContext(source, sandbox);
  return sandbox.window.RideMatrixAddressAutocomplete;
}

test("maps a Google place result into structured customer address fields", () => {
  const autocomplete = loadAutocomplete();
  assert.ok(autocomplete);

  const mapped = JSON.parse(JSON.stringify(autocomplete.mapPlaceToAddress({
    formatted_address: "10 Downing Street, Westminster, London SW1A 2AA, UK",
    geometry: {
      location: {
        lat: () => 51.5034,
        lng: () => -0.1276
      }
    },
    address_components: [
      { long_name: "10", types: ["street_number"] },
      { long_name: "Downing Street", types: ["route"] },
      { long_name: "Westminster", types: ["sublocality_level_1"] },
      { long_name: "London", types: ["postal_town"] },
      { long_name: "Greater London", types: ["administrative_area_level_2"] },
      { long_name: "England", types: ["administrative_area_level_1"] },
      { long_name: "SW1A", types: ["postal_code"] },
      { long_name: "2AA", types: ["postal_code_suffix"] }
    ]
  })));

  assert.deepEqual(mapped, {
    address: "10 Downing Street, Westminster, London SW1A 2AA, UK",
    addressSearch: "10 Downing Street, Westminster, London SW1A 2AA, UK",
    houseNameNumber: "10",
    addressLine1: "Downing Street",
    addressLine2: "Westminster",
    addressLine3: "Greater London",
    cityTown: "London",
    county: "Greater London",
    state: "England",
    postcode: "SW1A 2AA",
    latitude: "51.5034",
    longitude: "-0.1276"
  });
});
