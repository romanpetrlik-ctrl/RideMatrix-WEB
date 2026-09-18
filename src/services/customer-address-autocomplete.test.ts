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
    hidden: false,
    firstChild: null as any,
    appendChild(child: any) {
      this.firstChild = child;
      return child;
    },
    removeChild() {
      this.firstChild = null;
    },
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
    addressSearchManual: createField(""),
    autocompleteHost: createField(""),
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
    "#addressSearchManual": fields.addressSearchManual,
    "[data-address-autocomplete-host]": fields.autocompleteHost,
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

test("maps a selected place into structured customer address fields", () => {
  const loaded = loadAutocomplete();
  assert.ok(loaded.api);

  const mapped = JSON.parse(JSON.stringify(loaded.api.mapPlaceToAddress({
    formattedAddress: "10 Downing Street, Westminster, London SW1A 2AA, UK",
    location: {
      lat: () => 51.5034,
      lng: () => -0.1276
    },
    addressComponents: [
      { longText: "10", types: ["street_number"] },
      { longText: "Downing Street", types: ["route"] },
      { longText: "Westminster", types: ["sublocality_level_1"] },
      { longText: "London", types: ["postal_town"] },
      { longText: "Greater London", types: ["administrative_area_level_2"] },
      { longText: "England", types: ["administrative_area_level_1"] },
      { longText: "SW1A", types: ["postal_code"] },
      { longText: "2AA", types: ["postal_code_suffix"] }
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

test("handles missing address components without throwing", () => {
  const loaded = loadAutocomplete();
  const mapped = JSON.parse(JSON.stringify(loaded.api.mapPlaceToAddress({
    formattedAddress: "UK",
    location: {}
  })));

  assert.equal(mapped.address, "UK");
  assert.equal(mapped.addressLine1, "");
  assert.equal(mapped.postcode, "");
});

test("shows manual-entry fallback when browser key is missing", () => {
  const loaded = loadAutocomplete();
  const { form, fields } = createForm("");

  loaded.api.bindAutocomplete(form as any);
  fields.addressSearchManual.value = "Fallback lane 9";
  fields.addressSearchManual.trigger("input");

  assert.equal(fields.status.textContent, "Google address suggestions are unavailable. Continue with manual address entry.");
  assert.equal(fields.addressSearchManual.hidden, false);
  assert.equal(fields.address.value, "Fallback lane 9");
  assert.equal(fields.addressSearch.value, "Fallback lane 9");
  assert.equal(fields.latitude.value, "");
  assert.equal(fields.longitude.value, "");
});

test("manual fallback keeps address in sync and clears coordinates", async () => {
  const loaded = loadAutocomplete();
  loaded.window.RideMatrixMaps = {
    load: () => Promise.reject(new Error("script failure"))
  };
  const { form, fields } = createForm("browser-key");

  loaded.api.bindAutocomplete(form as any);
  await flushPromises();

  fields.addressSearchManual.value = "Manual road 1, Poole";
  fields.addressSearchManual.trigger("input");

  assert.equal(fields.status.textContent, "Google address suggestions are unavailable. Continue with manual address entry.");
  assert.equal(fields.address.value, "Manual road 1, Poole");
  assert.equal(fields.addressSearch.value, "Manual road 1, Poole");
  assert.equal(fields.latitude.value, "");
  assert.equal(fields.longitude.value, "");
});

test("initializes PlaceAutocompleteElement, handles gmp-select, and fetches only needed fields", async () => {
  const loaded = loadAutocomplete();
  const fetchedFields: string[][] = [];
  let selectedHandler: ((event: any) => void) | null = null;

  class MockPlaceAutocompleteElement {
    className = "";
    attributes: Record<string, string> = {};
    addEventListener(type: string, handler: (event: any) => void) {
      if (type === "gmp-select") selectedHandler = handler;
    }
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    }
  }

  loaded.window.RideMatrixMaps = {
    load: () => Promise.resolve(true)
  };
  loaded.window.google = {
    maps: {
      importLibrary: async (library: string) => {
        assert.equal(library, "places");
        return { PlaceAutocompleteElement: MockPlaceAutocompleteElement };
      }
    }
  };
  const { form, fields } = createForm("browser-key");

  loaded.api.bindAutocomplete(form as any);
  await flushPromises();

  assert.equal(fields.status.textContent, "Google address suggestions are available. You can still edit every field manually.");
  assert.equal(fields.addressSearchManual.hidden, true);
  assert.equal(fields.autocompleteHost.hidden, false);
  assert.ok(selectedHandler);
  const handler = selectedHandler as (event: any) => Promise<void> | void;

  const place = {
    formattedAddress: "1 Test Street, London SW1A 1AA, UK",
    addressComponents: [
      { longText: "1", types: ["street_number"] },
      { longText: "Test Street", types: ["route"] },
      { longText: "London", types: ["postal_town"] },
      { longText: "SW1A", types: ["postal_code"] },
      { longText: "1AA", types: ["postal_code_suffix"] }
    ],
    location: {
      lat: () => 51.5,
      lng: () => -0.12
    },
    fetchFields: async (request: { fields: string[] }) => {
      fetchedFields.push(request.fields);
    }
  };

  await handler({
    placePrediction: {
      toPlace: () => place
    }
  });
  await flushPromises();

  assert.deepEqual(
    JSON.parse(JSON.stringify(fetchedFields)),
    [["formattedAddress", "addressComponents", "location", "displayName"]]
  );
  assert.equal(fields.address.value, "1 Test Street, London SW1A 1AA, UK");
  assert.equal(fields.addressSearch.value, "1 Test Street, London SW1A 1AA, UK");
  assert.equal(fields.addressSearchManual.value, "1 Test Street, London SW1A 1AA, UK");
  assert.equal(fields.addressLine1.value, "Test Street");
  assert.equal(fields.cityTown.value, "London");
  assert.equal(fields.postcode.value, "SW1A 1AA");
  assert.equal(fields.latitude.value, "51.5");
  assert.equal(fields.longitude.value, "-0.12");
});

test("does not use legacy google.maps.places.Autocomplete API", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "public/js/customer-address-autocomplete.js"), "utf8");
  assert.doesNotMatch(source, /new\s+window\.google\.maps\.places\.Autocomplete/);
  assert.doesNotMatch(source, /place_changed/);
  assert.doesNotMatch(source, /getPlace\(\)/);
  assert.match(source, /PlaceAutocompleteElement/);
  assert.match(source, /gmp-select/);
});
