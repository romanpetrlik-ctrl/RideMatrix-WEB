import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

function loadAutocomplete() {
  const source = fs.readFileSync(path.join(process.cwd(), "public/js/customer-address-autocomplete.js"), "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.runInNewContext(source, sandbox);
  return {
    api: sandbox.window.RideMatrixAddressAutocomplete,
    window: sandbox.window
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createField(initialValue = "") {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    value: initialValue,
    textContent: "",
    addEventListener(type: string, listener: () => void) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(listener);
    },
    trigger(type: string) {
      (listeners[type] || []).forEach((listener) => listener());
    }
  };
}

function createForm(browserKey: string) {
  const fields = {
    address: createField(""),
    addressSearch: createField(""),
    houseNameNumber: createField(""),
    addressLine1: createField(""),
    addressLine2: createField(""),
    addressLine3: createField(""),
    cityTown: createField(""),
    county: createField(""),
    state: createField(""),
    postcode: createField(""),
    latitude: createField("51.5"),
    longitude: createField("-0.12"),
    status: createField("")
  };

  const bySelector: Record<string, ReturnType<typeof createField> | undefined> = {
    "#address": fields.address,
    "#addressSearch": fields.addressSearch,
    "#houseNameNumber": fields.houseNameNumber,
    "#addressLine1": fields.addressLine1,
    "#addressLine2": fields.addressLine2,
    "#addressLine3": fields.addressLine3,
    "#cityTown": fields.cityTown,
    "#county": fields.county,
    "#state": fields.state,
    "#postcode": fields.postcode,
    "#latitude": fields.latitude,
    "#longitude": fields.longitude,
    "[data-address-autocomplete-status]": fields.status
  };

  return {
    fields,
    form: {
      dataset: { addressAutocompleteBrowserKey: browserKey },
      querySelector(selector: string) {
        return bySelector[selector] || null;
      }
    }
  };
}

test("maps a Google place result into structured customer address fields", () => {
  const loaded = loadAutocomplete();
  assert.ok(loaded.api);

  const mapped = JSON.parse(JSON.stringify(loaded.api.mapPlaceToAddress({
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

test("shows manual-entry fallback when browser key is missing", () => {
  const loaded = loadAutocomplete();
  const { form, fields } = createForm("");

  loaded.api.bindAutocomplete(form as any);

  assert.equal(fields.status.textContent, "Google address suggestions are unavailable. Enter the address manually.");
});

test("shows manual-entry fallback and clears coordinates when map script fails to load", async () => {
  const loaded = loadAutocomplete();
  loaded.window.RideMatrixMaps = {
    load: () => Promise.reject(new Error("script failure"))
  };
  const { form, fields } = createForm("browser-key");

  loaded.api.bindAutocomplete(form as any);
  await flushPromises();

  assert.equal(fields.status.textContent, "Google address suggestions are unavailable. Enter the address manually.");
  assert.equal(fields.latitude.value, "");
  assert.equal(fields.longitude.value, "");
});

test("initializes Google Places autocomplete and maps selected place into form fields", async () => {
  const loaded = loadAutocomplete();
  let selectedPlace: any = null;
  let placeChangedHandler: (() => void) | null = null;

  loaded.window.RideMatrixMaps = {
    load: () => Promise.resolve(true)
  };
  loaded.window.google = {
    maps: {
      places: {
        Autocomplete: class {
          addListener(event: string, handler: () => void) {
            if (event === "place_changed") {
              placeChangedHandler = handler;
            }
          }

          getPlace() {
            return selectedPlace;
          }
        }
      }
    }
  };
  const { form, fields } = createForm("browser-key");

  loaded.api.bindAutocomplete(form as any);
  await flushPromises();

  assert.equal(fields.status.textContent, "Google address suggestions are available. You can still edit every field manually.");
  selectedPlace = {
    formatted_address: "1 Test Street, London SW1A 1AA, UK",
    address_components: [
      { long_name: "1", types: ["street_number"] },
      { long_name: "Test Street", types: ["route"] },
      { long_name: "London", types: ["postal_town"] },
      { long_name: "SW1A", types: ["postal_code"] },
      { long_name: "1AA", types: ["postal_code_suffix"] }
    ],
    geometry: {
      location: {
        lat: () => 51.5,
        lng: () => -0.12
      }
    }
  };

  assert.ok(placeChangedHandler);
  (placeChangedHandler as unknown as () => void)();

  assert.equal(fields.address.value, "1 Test Street, London SW1A 1AA, UK");
  assert.equal(fields.addressSearch.value, "1 Test Street, London SW1A 1AA, UK");
  assert.equal(fields.addressLine1.value, "Test Street");
  assert.equal(fields.cityTown.value, "London");
  assert.equal(fields.postcode.value, "SW1A 1AA");
  assert.equal(fields.latitude.value, "51.5");
  assert.equal(fields.longitude.value, "-0.12");
});
