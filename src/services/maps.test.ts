import assert from "node:assert/strict";
import test from "node:test";
import {
  createMapService,
  isValidGeoPoint,
  readMapConfiguration,
  toMapView,
  type GeocodedAddress,
  type MapProvider
} from "./maps";

const result: GeocodedAddress = {
  formattedAddress: "10 Downing Street, London",
  point: { latitude: 51.5034, longitude: -0.1276 },
  countryCode: "GB",
  city: "London",
  postcode: "SW1A 2AA"
};

const configured = { provider: "test", apiKey: "test-key", geocodingEnabled: true };

test("map configuration is disabled without provider or API key", () => {
  assert.equal(readMapConfiguration({ MAP_GEOCODING_ENABLED: "true" }).provider, "");
  assert.equal(createMapService(undefined, {
    provider: "test",
    geocodingEnabled: true
  }).enabled, false);
});

test("geocodes a normalized address through the provider-neutral interface", async () => {
  let requested = "";
  const provider: MapProvider = {
    async geocodeAddress(address) {
      requested = address;
      return result;
    },
    async reverseGeocode() {
      return result;
    }
  };

  const service = createMapService(provider, configured);
  assert.deepEqual(await service.geocodeAddress("  10   Downing Street, London "), result);
  assert.equal(requested, "10 Downing Street, London");
  assert.deepEqual(toMapView(result), {
    latitude: 51.5034,
    longitude: -0.1276,
    label: "Customer address",
    zoom: 14
  });
});

test("returns null for no result, malformed responses, provider errors, and invalid coordinates", async () => {
  const provider: MapProvider = {
    async geocodeAddress() {
      return null;
    },
    async reverseGeocode() {
      throw new Error("rate limit");
    }
  };
  const service = createMapService(provider, configured);
  assert.equal(await service.geocodeAddress("unknown"), null);
  assert.equal(await service.reverseGeocode({ latitude: 91, longitude: 0 }), null);
  assert.equal(await service.reverseGeocode({ latitude: 51, longitude: 0 }), null);
  assert.equal(toMapView({ formattedAddress: "bad", point: { latitude: 999, longitude: 0 } }), null);
  assert.equal(isValidGeoPoint({ latitude: 51, longitude: -0.1 }), true);
  assert.equal(isValidGeoPoint({ latitude: 51, longitude: 181 }), false);
});
