import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleMapsProvider } from "./google-maps";

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, async json() { return body; } } as Response;
}

const googleResult = {
  formatted_address: "10 Downing Street, London SW1A 2AA, UK",
  place_id: "place-1",
  types: ["street_address"],
  geometry: { location: { lat: 51.5034, lng: -0.1276 } },
  address_components: [
    { long_name: "United Kingdom", short_name: "GB", types: ["country"] },
    { long_name: "London", types: ["postal_town"] },
    { long_name: "SW1A 2AA", types: ["postal_code"] }
  ]
};

test("maps a precise UK Google result and caches unchanged addresses", async () => {
  let calls = 0;
  const provider = createGoogleMapsProvider("server-only", {
    fetch: async (_input, init) => {
      calls += 1;
      assert.ok(init?.signal);
      return response({ status: "OK", results: [googleResult] });
    }
  });

  const first = await provider.geocodeAddress(" 10  Downing Street, London ");
  const second = await provider.geocodeAddress("10 Downing Street, London");
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first?.matchQuality, "exact");
  assert.equal(first?.postcode, "SW1A 2AA");
});

test("distinguishes partial, ambiguous, no-result, malformed, timeout, and rate-limit responses", async () => {
  const partial = createGoogleMapsProvider("key", {
    fetch: async () => response({
      status: "OK",
      results: [{ ...googleResult, partial_match: true, types: ["street_address"] }]
    })
  });
  assert.equal((await partial.geocodeAddress("partial"))?.matchQuality, "partial");

  const ambiguous = createGoogleMapsProvider("key", {
    fetch: async () => response({ status: "OK", results: [googleResult, googleResult] })
  });
  assert.equal((await ambiguous.geocodeAddress("ambiguous"))?.matchQuality, "ambiguous");

  for (const body of [{ status: "ZERO_RESULTS" }, { status: "OVER_QUERY_LIMIT" }, { status: "OK", results: [{}] }]) {
    const provider = createGoogleMapsProvider("key", { fetch: async () => response(body) });
    assert.equal(await provider.geocodeAddress(JSON.stringify(body)), null);
  }

  const timedOut = createGoogleMapsProvider("key", {
    timeoutMs: 1,
    fetch: async (_input, init) => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })
  });
  assert.equal(await timedOut.geocodeAddress("timeout"), null);
});

test("rejects invalid reverse-geocoding coordinates without a request", async () => {
  let calls = 0;
  const provider = createGoogleMapsProvider("key", { fetch: async () => { calls += 1; return response({}); } });
  assert.equal(await provider.reverseGeocode({ latitude: 91, longitude: 0 }), null);
  assert.equal(calls, 0);
});
