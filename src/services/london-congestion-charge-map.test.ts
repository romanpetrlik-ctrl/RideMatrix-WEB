import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { getLondonCongestionChargeBoundary } from "./london-congestion-charge-boundary";

type MapElement = {
  dataset: Record<string, string>;
  parentElement: { querySelector: () => { textContent: string } };
};

function loadMapComponent(
  fetchResponse: { ok: boolean; status: number; json: () => Promise<unknown> },
  loadMaps: () => Promise<boolean> = async () => true
) {
  const source = fs.readFileSync(path.join(process.cwd(), "public/js/london-congestion-charge-map.js"), "utf8");
  let ready: (() => Promise<void>) | undefined;
  const status = { textContent: "" };
  const element: MapElement = {
    dataset: {
      mapBrowserKey: "test-browser-key",
      mapId: "test-map-id",
      boundaryUrl: "/protected/london-congestion-charge-boundary.json"
    },
    parentElement: { querySelector: () => status }
  };
  const polygons: Array<Record<string, unknown>> = [];
  const points: Array<{ lat: number; lng: number }> = [];
  let mapCount = 0;
  let fittedBounds: unknown;
  const maps = {
    Map: class {
      fitBounds(bounds: unknown) { fittedBounds = bounds; }
      constructor() { mapCount += 1; }
    },
    Polygon: class {
      constructor(options: Record<string, unknown>) { polygons.push(options); }
    },
    LatLngBounds: class {
      extend(point: { lat: number; lng: number }) { points.push(point); }
    }
  };
  type TestGoogleMaps = typeof maps;
  const windowObject: {
    google: { maps: TestGoogleMaps };
    RideMatrixMaps: { load: () => Promise<boolean> };
    RideMatrixLondonCongestionChargeMap?: {
      renderBoundary: (element: MapElement, maps: TestGoogleMaps, boundary: unknown) => number;
    };
  } = {
    google: { maps },
    RideMatrixMaps: { load: loadMaps }
  };
  const sandbox = {
    window: windowObject,
    document: {
      querySelectorAll: () => [element],
      addEventListener: (_event: string, callback: () => Promise<void>) => { ready = callback; }
    },
    fetch: async () => fetchResponse,
    Promise
  };

  vm.runInNewContext(source, sandbox);
  if (!windowObject.RideMatrixLondonCongestionChargeMap) {
    throw new Error("London Congestion Charge map component did not load.");
  }
  return {
    component: windowObject.RideMatrixLondonCongestionChargeMap,
    element,
    maps,
    polygons,
    points,
    get mapCount() { return mapCount; },
    get fittedBounds() { return fittedBounds; },
    status,
    async start() {
      assert.ok(ready);
      await ready();
    }
  };
}

test("map preview renders both source Polygon features with GeoJSON longitude/latitude and fits their bounds", async () => {
  const boundary = getLondonCongestionChargeBoundary();
  const harness = loadMapComponent({
    ok: true,
    status: 200,
    json: async () => boundary
  });

  await harness.start();

  assert.equal(harness.mapCount, 1);
  assert.equal(harness.polygons.length, 2);
  assert.equal(harness.points.length, 1_153);
  assert.equal(harness.points[0].lat, boundary.features[0].geometry.coordinates[0][0][1]);
  assert.equal(harness.points[0].lng, boundary.features[0].geometry.coordinates[0][0][0]);
  assert.ok(harness.fittedBounds);
  assert.match(harness.status.textContent, /boundary displayed/);
  assert.match(harness.status.textContent, /Both source Polygon features/);
});

test("map preview reports malformed geometry without rendering partial polygons", async () => {
  const boundary = structuredClone(getLondonCongestionChargeBoundary());
  boundary.features[1].geometry.coordinates[0][0][0] = 181;
  const harness = loadMapComponent({
    ok: true,
    status: 200,
    json: async () => boundary
  });

  await harness.start();

  assert.equal(harness.mapCount, 0);
  assert.equal(harness.polygons.length, 0);
  assert.match(harness.status.textContent, /Map preview unavailable/);
  assert.doesNotMatch(harness.status.textContent, /boundary displayed/);
});

test("map preview reports unavailable protected geometry without rendering a blank success state", async () => {
  const harness = loadMapComponent({
    ok: false,
    status: 503,
    json: async () => ({ error: "Boundary unavailable." })
  });

  await harness.start();

  assert.equal(harness.mapCount, 0);
  assert.equal(harness.polygons.length, 0);
  assert.match(harness.status.textContent, /Map preview unavailable/);
  assert.doesNotMatch(harness.status.textContent, /boundary displayed/);
});

test("map preview reports Google Maps loading failures", async () => {
  const harness = loadMapComponent({
    ok: true,
    status: 200,
    json: async () => getLondonCongestionChargeBoundary()
  }, async () => {
    throw new Error("Google Maps unavailable");
  });

  await harness.start();

  assert.equal(harness.mapCount, 0);
  assert.equal(harness.polygons.length, 0);
  assert.match(harness.status.textContent, /Map preview unavailable/);
});

test("reference page renders an accessible boundary preview without fee behavior", () => {
  const template = fs.readFileSync(path.join(process.cwd(), "src/views/pages/toll-fees.ejs"), "utf8");

  assert.match(template, /london-congestion-charge-preview-title/);
  assert.match(template, /data-london-congestion-charge-map/);
  assert.match(template, /Both supplied Polygon features/);
  assert.match(template, /does not calculate fees or charge customers/);
  assert.doesNotMatch(template, /calculateCongestionCharge|chargeCongestionFee|bookingTotal/);
});
