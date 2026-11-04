import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

function createField(value = "") {
  const listeners: Record<string, Array<(event: any) => void>> = {};
  return {
    value,
    textContent: "",
    attributes: {} as Record<string, string>,
    addEventListener(type: string, listener: (event: any) => void) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(listener);
    },
    setAttribute(name: string, attributeValue: string) {
      this.attributes[name] = attributeValue;
    },
    focus() {},
    trigger(type: string, event: any = {}) {
      (listeners[type] || []).forEach((listener) => listener(event));
    }
  };
}

function createAirportForm() {
  const fields = {
    label: createField("Previous operational point"),
    placeId: createField("previous-place"),
    latitude: createField("50.7"),
    longitude: createField("-1.8"),
    status: createField("")
  };
  const root = {
    dataset: { airportPlaceBrowserKey: "browser-key" },
    querySelector(selector: string) {
      if (selector === "[data-airport-place-autocomplete-host]") return host;
      if (selector === 'input[name$="LocationLabel"]') return fields.label;
      if (selector === 'input[name$="PlaceId"]') return fields.placeId;
      if (selector === 'input[name$="Latitude"]') return fields.latitude;
      if (selector === 'input[name$="Longitude"]') return fields.longitude;
      if (selector === "[data-airport-place-status]") return fields.status;
      return null;
    }
  };
  const host = {
    appendChild(child: any) {
      autocomplete = child;
      return child;
    }
  };
  let autocomplete: any;
  const formListeners: Record<string, Array<(event: any) => void>> = {};
  const form = {
    addEventListener(type: string, listener: (event: any) => void) {
      formListeners[type] = formListeners[type] || [];
      formListeners[type].push(listener);
    },
    querySelectorAll(selector: string) {
      return selector === "[data-airport-place-root]" ? [root] : [];
    },
    submit() {
      let prevented = false;
      (formListeners.submit || []).forEach((listener) => listener({
        preventDefault() {
          prevented = true;
        }
      }));
      return prevented;
    }
  };
  const documentListeners: Record<string, Array<() => void>> = {};
  const window = {
    RideMatrixMaps: { load: async () => true },
    google: {
      maps: {
        importLibrary: async () => ({
          PlaceAutocompleteElement: class {
            addEventListener(_type: string, listener: (event: any) => void) {
              this.listener = listener;
            }
            setAttribute() {}
            listener!: (event: any) => void;
          }
        })
      }
    }
  };
  const document = {
    addEventListener(type: string, listener: () => void) {
      documentListeners[type] = documentListeners[type] || [];
      documentListeners[type].push(listener);
    },
    querySelectorAll(selector: string) {
      return selector === "[data-airport-place-root]" ? [root] : [];
    },
    querySelector(selector: string) {
      return selector === ".airport-fees__form" ? form : null;
    }
  };
  const source = fs.readFileSync(path.join(process.cwd(), "public/js/airport-fees.js"), "utf8");
  vm.runInNewContext(source, { window, document });
  (documentListeners.DOMContentLoaded || []).forEach((listener) => listener());
  return {
    fields,
    form,
    select(place: any) {
      autocomplete.listener({ placePrediction: { toPlace: () => place } });
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("clears the previous airport Place while a replacement is loading or rejected", async () => {
  const airport = createAirportForm();
  await flushPromises();
  const request = deferred<void>();

  airport.select({ fetchFields: () => request.promise });

  assert.equal(airport.fields.placeId.value, "");
  assert.equal(airport.fields.latitude.value, "");
  assert.equal(airport.fields.longitude.value, "");
  assert.equal(airport.fields.label.value, "");
  assert.equal(airport.form.submit(), true);

  request.reject(new Error("Place fetch failed"));
  await flushPromises();

  assert.equal(airport.fields.placeId.value, "");
  assert.equal(airport.form.submit(), true);
});

test("only applies the latest airport Place selection and accepts string display names", async () => {
  const airport = createAirportForm();
  await flushPromises();
  const firstRequest = deferred<void>();
  const secondRequest = deferred<void>();

  airport.select({
    fetchFields: () => firstRequest.promise,
    id: "first-place",
    displayName: "First operational point",
    location: { lat: 1, lng: 2 }
  });
  airport.select({
    fetchFields: () => secondRequest.promise,
    id: "second-place",
    displayName: "  Terminal Car Park 1  ",
    location: { lat: 50.7799, lng: -1.8425 }
  });

  secondRequest.resolve();
  await flushPromises();
  firstRequest.resolve();
  await flushPromises();

  assert.equal(airport.fields.placeId.value, "second-place");
  assert.equal(airport.fields.label.value, "Terminal Car Park 1");
  assert.equal(airport.fields.latitude.value, "50.7799");
  assert.equal(airport.fields.longitude.value, "-1.8425");
});

test("ignores an error from a superseded airport Place request", async () => {
  const airport = createAirportForm();
  await flushPromises();
  const firstRequest = deferred<void>();

  airport.select({ fetchFields: () => firstRequest.promise });
  airport.select({
    fetchFields: async () => {},
    id: "current-place",
    displayName: { text: "Current operational point" },
    location: { lat: 51, lng: -2 }
  });
  await flushPromises();
  firstRequest.reject(new Error("Old Place fetch failed"));
  await flushPromises();

  assert.equal(airport.fields.placeId.value, "current-place");
  assert.equal(airport.fields.status.textContent, "Google Place selected. Its Place ID and operational coordinates will be saved.");
});
