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

const configured = { enabled: true, provider: "google" as const, serverApiKey: "test-key", geocodingEnabled: true };

test("map configuration is disabled without provider or API key", () => {
  assert.equal(readMapConfiguration({ GOOGLE_MAPS_ENABLED: "true" }).provider, "google");
  assert.equal(createMapService(undefined, {
    enabled: true,
    provider: "google",
    geocodingEnabled: true
  }).enabled, false);
});

test("map configuration keeps browser and server keys separate", () => {
  const configuration = readMapConfiguration({
    GOOGLE_MAPS_ENABLED: "true",
    GOOGLE_MAPS_SERVER_API_KEY: "server-only",
    GOOGLE_MAPS_BROWSER_API_KEY: "browser-only",
    GOOGLE_MAPS_MAP_ID: "map-id"
  });

  assert.equal(configuration.serverApiKey, "server-only");
  assert.equal(configuration.browserApiKey, "browser-only");
  assert.equal(configuration.mapId, "map-id");
});

test("map configuration accepts public browser settings and validates its default point", () => {
  const configuration = readMapConfiguration({
    NEXT_PUBLIC_GOOGLE_MAPS_ENABLED: "true",
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "browser-only",
    NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID: "map-id",
    GOOGLE_MAPS_DEFAULT_LATITUDE: "51.5034",
    NEXT_PUBLIC_GOOGLE_MAPS_DEFAULT_LONGITUDE: "-0.1276"
  });

  assert.equal(configuration.enabled, true);
  assert.equal(configuration.browserApiKey, "browser-only");
  assert.equal(configuration.mapId, "map-id");
  assert.deepEqual(configuration.defaultPoint, { latitude: 51.5034, longitude: -0.1276 });
  assert.equal(readMapConfiguration({
    GOOGLE_MAPS_DEFAULT_LATITUDE: "91",
    GOOGLE_MAPS_DEFAULT_LONGITUDE: "0"
  }).defaultPoint, undefined);
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
