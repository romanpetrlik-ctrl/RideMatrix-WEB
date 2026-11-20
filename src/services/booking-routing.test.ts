import assert from "node:assert/strict";
import test from "node:test";
import {
  createGoogleRoutesProvider,
  createRoadChargeZone,
  decodePolyline,
  detectRoadChargeZones,
  detectTunnelCrossings,
  metersToMiles,
  TUNNEL_REFERENCE_GEOMETRY,
  type TunnelReferenceGeometry
} from "./booking-routing";

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
  assert.deepEqual(throughCentral.map((zone) => zone.zone).sort(), ["london-congestion-charge", "london-lez", "london-ulez"]);
  const rural = detectRoadChargeZones([{ latitude: 50.72, longitude: -1.88 }, { latitude: 50.8, longitude: -1.9 }]);
  assert.deepEqual(rural, []);
});

test("a route inside the stored Congestion Charge polygon is CC exposure; a route outside it is not", () => {
  const inside = detectRoadChargeZones([{ latitude: 51.508, longitude: -0.1281 }, { latitude: 51.509, longitude: -0.125 }]);
  assert.ok(inside.some((zone) => zone.zone === "london-congestion-charge"));
  const outside = detectRoadChargeZones([{ latitude: 51.539, longitude: -0.1426 }, { latitude: 51.556, longitude: -0.178 }]);
  assert.equal(outside.some((zone) => zone.zone === "london-congestion-charge"), false);
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

const square = (id: "london-lez" | "london-ulez" | "london-congestion-charge", west: number, south: number, east: number, north: number) =>
  createRoadChargeZone(id, id, [{ geometry: { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] } }]);

test("zone exposure uses route segment intersection, including detours through Via stops", () => {
  const zones = [square("london-congestion-charge", -0.1, 51.5, -0.08, 51.52)];
  // Pickup and drop-off are both outside the zone; the leg to the Via stop passes straight through it.
  const throughVia = detectRoadChargeZones([
    { latitude: 51.51, longitude: -0.12 },
    { latitude: 51.51, longitude: -0.06 },
    { latitude: 51.53, longitude: -0.06 }
  ], zones);
  assert.equal(throughVia.length, 1);
  assert.equal(throughVia[0].zone, "london-congestion-charge");
  assert.equal(throughVia[0].evidence.method, "route-polygon-intersection");
  assert.equal(throughVia[0].evidence.segmentIndex, 0);
  assert.deepEqual(throughVia[0].evidence.firstContact, { latitude: 51.51, longitude: -0.1 });

  // The Via stop itself sits inside the zone (no segment needs to cross a boundary twice to count).
  const viaInside = detectRoadChargeZones([
    { latitude: 51.49, longitude: -0.12 },
    { latitude: 51.51, longitude: -0.09 },
    { latitude: 51.49, longitude: -0.06 }
  ], zones);
  assert.equal(viaInside.length, 1);

  // Endpoints whose straight line would cross the zone, but whose actual route goes around it, are not charged.
  const around = detectRoadChargeZones([
    { latitude: 51.51, longitude: -0.12 },
    { latitude: 51.53, longitude: -0.12 },
    { latitude: 51.53, longitude: -0.06 },
    { latitude: 51.51, longitude: -0.06 }
  ], zones);
  assert.deepEqual(around, []);
});

test("the real LEZ boundary is detected separately from ULEZ and CC for an outer-London route", () => {
  // Heathrow area (inside LEZ, inside expanded ULEZ) to central London.
  const outer = detectRoadChargeZones([{ latitude: 51.47, longitude: -0.45 }, { latitude: 51.47, longitude: -0.44 }]);
  assert.ok(outer.some((zone) => zone.zone === "london-lez"));
  assert.ok(!outer.some((zone) => zone.zone === "london-congestion-charge"));
});

const testPortals: TunnelReferenceGeometry = {
  verified: true,
  provenance: "test fixture",
  portals: [
    { tunnel: "blackwall", label: "Blackwall Tunnel", south: { latitude: 51.49, longitude: -0.005 }, north: { latitude: 51.51, longitude: -0.005 } },
    { tunnel: "silvertown", label: "Silvertown Tunnel", south: { latitude: 51.49, longitude: 0.015 }, north: { latitude: 51.51, longitude: 0.015 } }
  ]
};

test("tunnel crossings are identified per tunnel with direction, and repeated crossings are each counted", () => {
  const blackwallNorth = { latitude: 51.51, longitude: -0.005 };
  const blackwallSouth = { latitude: 51.49, longitude: -0.005 };
  const silverNorth = { latitude: 51.51, longitude: 0.015 };
  const silverSouth = { latitude: 51.49, longitude: 0.015 };
  const crossings = detectTunnelCrossings([blackwallNorth, blackwallSouth, silverSouth, silverNorth], testPortals);
  assert.deepEqual(crossings.map((crossing) => [crossing.tunnel, crossing.direction]), [
    ["blackwall", "southbound"],
    ["silvertown", "northbound"]
  ]);
  assert.ok(crossings.every((crossing) => crossing.geometry.verified));

  const returnTrip = detectTunnelCrossings([blackwallSouth, blackwallNorth, blackwallSouth], testPortals);
  assert.deepEqual(returnTrip.map((crossing) => `${crossing.tunnel}:${crossing.direction}`), ["blackwall:northbound", "blackwall:southbound"]);

  assert.deepEqual(detectTunnelCrossings([{ latitude: 51.51, longitude: 0.05 }, { latitude: 51.49, longitude: 0.05 }], testPortals), []);
});

test("owner-supplied portal coordinates detect real tunnel route crossings", () => {
  assert.equal(TUNNEL_REFERENCE_GEOMETRY.verified, true);
  const expected = {
    blackwall: {
      south: { latitude: 51.49893792969339, longitude: 0.0014513865548262928 },
      north: { latitude: 51.509278165764364, longitude: -0.006665498889019285 }
    },
    silvertown: {
      south: { latitude: 51.497144847933576, longitude: 0.0032492881290614325 },
      north: { latitude: 51.50670017765821, longitude: 0.01454039191106224 }
    }
  };
  for (const [tunnel, portals] of Object.entries(expected)) {
    const configured = TUNNEL_REFERENCE_GEOMETRY.portals.find((item) => item.tunnel === tunnel)!;
    assert.deepEqual(configured.south, portals.south);
    assert.deepEqual(configured.north, portals.north);
    const crossings = detectTunnelCrossings([portals.south, portals.north]);
    assert.equal(crossings.length, 1);
    assert.equal(crossings[0].tunnel, tunnel);
    assert.equal(crossings[0].direction, "northbound");
    assert.equal(crossings[0].geometry.verified, true);
  }
});

test("a tunnel portal pair spanning another tunnel traversal is not counted", () => {
  const blackwall = TUNNEL_REFERENCE_GEOMETRY.portals.find((item) => item.tunnel === "blackwall")!;
  const silvertown = TUNNEL_REFERENCE_GEOMETRY.portals.find((item) => item.tunnel === "silvertown")!;
  const crossings = detectTunnelCrossings([
    blackwall.south,
    blackwall.north,
    silvertown.north,
    silvertown.south,
    blackwall.south
  ]);
  assert.deepEqual(crossings.map((crossing) => `${crossing.tunnel}:${crossing.direction}`), [
    "blackwall:northbound",
    "silvertown:southbound"
  ]);
});

test("a route must pass both portal locations before the tunnel is charged", () => {
  const portals = TUNNEL_REFERENCE_GEOMETRY.portals.find((item) => item.tunnel === "blackwall")!;
  const nearOnlyOnePortal = detectTunnelCrossings([portals.south, { latitude: 51.504, longitude: -0.003 }]);
  assert.deepEqual(nearOnlyOnePortal, []);
});
