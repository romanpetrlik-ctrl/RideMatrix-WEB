import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

function createField(initialValue = "") {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    value: initialValue,
    hidden: false,
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

function loadScript() {
  const source = fs.readFileSync(path.join(process.cwd(), "public/js/setup-address-autocomplete.js"), "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.runInNewContext(source, sandbox);
  return sandbox.window;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("operational address selection stores the Google Place ID and its exact coordinates", async () => {
  const window = loadScript();
  const handlers: Record<string, (event: any) => void> = {};
  class PlaceAutocomplete {
    setAttribute() {}
    addEventListener(type: string, handler: (event: any) => void) {
      handlers[type] = handler;
    }
  }
  window.RideMatrixMaps = { load: async () => true };
  window.google = {
    maps: {
      importLibrary: async () => ({ PlaceAutocompleteElement: PlaceAutocomplete })
    }
  };

  const names = [
    "operationalPlaceSearch", "formattedAddress", "houseNameNumber", "addressLine1", "addressLine2",
    "addressLine3", "cityTown", "county", "state", "postcode", "countryCode", "countryName",
    "latitude", "longitude", "providerName", "providerPlaceId"
  ];
  const fields: Record<string, ReturnType<typeof createField>> = {};
  names.forEach((name) => { fields[name] = createField(); });
  const host = {
    hidden: true,
    replaceChildren() {}
  };
  const status = createField();
  const form = {
    dataset: { addressAutocompleteBrowserKey: "test-browser-key" },
    querySelector(selector: string) {
      if (selector === "[data-place-autocomplete-host]") return host;
      if (selector === "#operationalPlaceStatus") return status;
      return fields[selector.slice(1)] || null;
    }
  };

  window.RideMatrixSetupAddressAutocomplete.bind(form);
  await flushPromises();
  handlers["gmp-select"]({
    placePrediction: {
      id: "ChIJtest-place",
      toPlace: () => ({
        id: "ChIJtest-place",
        fetchFields: async () => {},
        formattedAddress: "10 Downing Street, London SW1A 2AA, UK",
        location: { lat: () => 51.5034, lng: () => -0.1276 },
        addressComponents: [
          { longText: "10", types: ["street_number"] },
          { longText: "Downing Street", types: ["route"] },
          { longText: "London", types: ["postal_town"] },
          { longText: "SW1A", types: ["postal_code"] },
          { longText: "2AA", types: ["postal_code_suffix"] },
          { longText: "United Kingdom", types: ["country"], shortText: "GB" }
        ]
      })
    }
  });
  await flushPromises();

  assert.equal(fields.providerName.value, "google");
  assert.equal(fields.providerPlaceId.value, "ChIJtest-place");
  assert.equal(fields.latitude.value, "51.5034");
  assert.equal(fields.longitude.value, "-0.1276");
  assert.equal(fields.countryCode.value, "GB");
  assert.equal(fields.formattedAddress.value, "10 Downing Street, London SW1A 2AA, UK");
  assert.match(status.textContent || "", /will be saved together/);

  fields.operationalPlaceSearch.trigger("input");
  assert.equal(fields.providerPlaceId.value, "");
  assert.equal(fields.latitude.value, "");
  assert.equal(fields.longitude.value, "");
});

test("operational address cannot continue without a selected Google Place", () => {
  const window = loadScript();
  const status = createField();
  const search = createField();
  window.RideMatrixSetupAddressAutocomplete.bind({
    dataset: { addressAutocompleteBrowserKey: "" },
    querySelector(selector: string) {
      if (selector === "#operationalPlaceSearch") return search;
      if (selector === "#operationalPlaceStatus") return status;
      return null;
    }
  });
  assert.match(status.textContent || "", /select a Google Places result to continue/);
});
