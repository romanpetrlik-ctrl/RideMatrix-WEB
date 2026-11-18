import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleRoutesProvider, decodePolyline, detectRoadChargeZones, metersToMiles } from "./booking-routing";

// Google's documented example polyline: (38.5,-120.2) → (40.7,-120.95) → (43.252,-126.453).
const EXAMPLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const stops = [{ latitude: 51.5, longitude: -0.1 }, { latitude: 51.45, longitude: -0.2 }, { latitude: 51.47, longitude: -0.45 }];

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("decodes provider polylines and converts metres to miles without rounding the fare input", () => {
  assert.deepEqual(decodePolyline(EXAMPLE), [
    { latitude: 38.5, longitude: -120.2 },
    { latitude: 40.7, longitude: -120.95 },
    { latitude: 43.252, longitude: -126.453 }
  ]);
  assert.equal(metersToMiles(1609.344), "1.000000");
  assert.equal(metersToMiles(16093), "9.999727");
});

test("detects London charging zones only when the route geometry enters them", () => {
  const throughCentral = detectRoadChargeZones([{ latitude: 51.5155, longitude: -0.1419 }, { latitude: 51.5079, longitude: -0.0877 }]);
  assert.deepEqual(throughCentral.map((zone) => zone.zone).sort(), ["london-congestion-charge", "london-ulez"]);
  const rural = detectRoadChargeZones([{ latitude: 50.72, longitude: -1.88 }, { latitude: 50.8, longitude: -1.9 }]);
  assert.deepEqual(rural, []);
});

test("routes all ordered stops (including vias) and reports tolls and zones", async () => {
  let request: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
  const provider = createGoogleRoutesProvider({
    apiKey: "server-key",
    now: () => new Date("2027-03-10T09:00:00Z"),
    zones: () => [],
    fetch: (async (url: string, init: RequestInit) => {
      request = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
      return okResponse({ routes: [{ distanceMeters: 32186.88, duration: "1834s", polyline: { encodedPolyline: EXAMPLE }, travelAdvisory: { tollInfo: {} } }] });
    }) as typeof fetch
  });
  const route = await provider(stops, { departureTime: new Date("2027-03-10T12:00:00Z") });
  assert.equal(route.status, "resolved");
  if (route.status !== "resolved") return;
  assert.equal(route.distanceMiles, "20.000000");
  assert.equal(route.durationSeconds, 1834);
  assert.equal(route.tollsReported, true);
  assert.equal(route.trafficModel, "traffic-aware");
  assert.equal(route.path.length, 3);
  const sent = request!;
  assert.equal(sent.headers["X-Goog-Api-Key"], "server-key");
  assert.deepEqual((sent.body.intermediates as unknown[]).length, 1, "via stops are sent in order as intermediates");
  assert.deepEqual(sent.body.origin, { location: { latLng: { latitude: 51.5, longitude: -0.1 } } });
  assert.deepEqual(sent.body.destination, { location: { latLng: { latitude: 51.47, longitude: -0.45 } } });
});

test("never fabricates a route when routing is unavailable or the provider fails", async () => {
  const noKey = await createGoogleRoutesProvider({ apiKey: "" })(stops, {});
  assert.equal(noKey.status, "unresolved");

  const httpError = await createGoogleRoutesProvider({ apiKey: "k", fetch: (async () => new Response("no", { status: 500 })) as typeof fetch })(stops, {});
  assert.deepEqual(httpError.status === "unresolved" && httpError.reason, "provider-error");

  const thrown = await createGoogleRoutesProvider({ apiKey: "k", fetch: (async () => { throw new Error("offline"); }) as typeof fetch })(stops, {});
  assert.deepEqual(thrown.status === "unresolved" && thrown.reason, "provider-error");

  const empty = await createGoogleRoutesProvider({ apiKey: "k", fetch: (async () => okResponse({ routes: [] })) as typeof fetch })(stops, {});
  assert.deepEqual(empty.status === "unresolved" && empty.reason, "no-route");

  const oneStop = await createGoogleRoutesProvider({ apiKey: "k", fetch: (async () => okResponse({})) as typeof fetch })(stops.slice(0, 1), {});
  assert.deepEqual(oneStop.status === "unresolved" && oneStop.reason, "missing-stops");
});
