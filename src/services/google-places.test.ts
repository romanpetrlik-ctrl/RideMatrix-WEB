import assert from "node:assert/strict";
import test from "node:test";
import { verifyGoogleOperationalPlace } from "./google-places";

function response(body: unknown, ok = true): Response {
  return { ok, async json() { return body; } } as Response;
}

const ukPlace = {
  formattedAddress: "10 Downing Street, London SW1A 2AA, UK",
  addressComponents: [
    { longText: "10", types: ["street_number"] },
    { longText: "Downing Street", types: ["route"] },
    { longText: "London", types: ["postal_town"] },
    { longText: "SW1A 2AA", types: ["postal_code"] },
    { longText: "United Kingdom", shortText: "GB", types: ["country"] }
  ],
  location: { latitude: 51.5034, longitude: -0.1276 }
};

test("verifies UK address components and coordinates from a server-side Place Details response", async () => {
  let requestUrl = "";
  let fieldMask = "";
  let apiKeyHeader = "";
  const result = await verifyGoogleOperationalPlace("ChIJ/place", {
    apiKey: "server-key",
    fetch: async (input, init) => {
      requestUrl = String(input);
      const headers = new Headers(init?.headers);
      fieldMask = headers.get("X-Goog-FieldMask") || "";
      apiKeyHeader = headers.get("X-Goog-Api-Key") || "";
      return response(ukPlace);
    }
  });

  assert.equal(result.status, "verified");
  if (result.status !== "verified") return;
  assert.equal(result.address.providerPlaceId, "ChIJ/place");
  assert.equal(result.address.addressLine1, "Downing Street");
  assert.equal(result.address.cityTown, "London");
  assert.equal(result.address.postcode, "SW1A 2AA");
  assert.equal(result.address.countryCode, "GB");
  assert.equal(result.address.latitude, 51.5034);
  assert.equal(result.address.longitude, -0.1276);
  assert.match(requestUrl, /places\/ChIJ%2Fplace$/);
  assert.equal(new URL(requestUrl).search, "");
  assert.equal(apiKeyHeader, "server-key");
  assert.equal(fieldMask, "formattedAddress,displayName,addressComponents,location");
});

test("rejects a Place whose server-returned country is not the UK", async () => {
  const result = await verifyGoogleOperationalPlace("outside-uk", {
    apiKey: "server-key",
    fetch: async () => response({
      ...ukPlace,
      addressComponents: [
        { longText: "France", shortText: "FR", types: ["country"] }
      ]
    })
  });

  assert.deepEqual(result, { status: "outside_uk" });
});

test("does not claim coordinates are verified when Place Details cannot be checked", async () => {
  let requests = 0;
  const noKey = await verifyGoogleOperationalPlace("place-without-key", {
    apiKey: "",
    fetch: async () => { requests += 1; return response(ukPlace); }
  });
  const failedRequest = await verifyGoogleOperationalPlace("unavailable-place", {
    apiKey: "server-key",
    fetch: async () => { requests += 1; return response({}, false); }
  });

  assert.deepEqual(noKey, { status: "unverified" });
  assert.deepEqual(failedRequest, { status: "unverified" });
  assert.equal(requests, 1);
});
