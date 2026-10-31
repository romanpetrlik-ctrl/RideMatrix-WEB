import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { getLondonLezBoundary } from "./london-lez-boundary";

type MapElement = {
  dataset: Record<string, string>;
  parentElement: { querySelector: () => { textContent: string } };
};

function loadMapComponent(
  fetchResponse: { ok: boolean; status: number; json: () => Promise<unknown> },
  loadMaps: () => Promise<boolean> = async () => true
) {
  const source = fs.readFileSync(path.join(process.cwd(), "public/js/london-lez-map.js"), "utf8");
  let ready: (() => Promise<void>) | undefined;
  const status = { textContent: "" };
  const element: MapElement = {
    dataset: {
      mapBrowserKey: "test-browser-key",
      mapId: "test-map-id",
      boundaryUrl: "/protected/london-lez-boundary.json"
    },
    parentElement: { querySelector: () => status }
  };
  const polygons: Array<Record<string, unknown>> = [];
  let mapCount = 0;
  let boundsCount = 0;
  const maps = {
    Map: class {
      fitBounds() {}
      constructor() { mapCount += 1; }
    },
    Polygon: class {
      constructor(options: Record<string, unknown>) { polygons.push(options); }
    },
    LatLngBounds: class {
      extend() { boundsCount += 1; }
    }
  };
  type TestGoogleMaps = typeof maps;
  const windowObject: {
    google: { maps: TestGoogleMaps };
    RideMatrixMaps: { load: () => Promise<boolean> };
    RideMatrixLondonLezMap?: { renderBoundary: (element: MapElement, maps: TestGoogleMaps, boundary: unknown) => number };
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
  if (!windowObject.RideMatrixLondonLezMap) throw new Error("London LEZ map component did not load.");
  return {
    component: windowObject.RideMatrixLondonLezMap,
    element,
    maps,
    polygons,
    get mapCount() { return mapCount; },
    get boundsCount() { return boundsCount; },
    status,
    async start() {
      assert.ok(ready);
      await ready();
    }
  };
}

test("Google Maps preview renders every supplied LEZ feature as boundary polygons", async () => {
  const boundary = getLondonLezBoundary();
  const harness = loadMapComponent({
    ok: true,
    status: 200,
    json: async () => boundary
  });

  await harness.start();

  assert.equal(harness.mapCount, 1);
  assert.equal(harness.polygons.length, boundary.features.reduce(
    (count, feature) => count + (feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates.length : 1),
    0
  ));
  assert.ok(harness.boundsCount > 20_000);
  assert.match(harness.status.textContent, /London LEZ boundary displayed/);
  assert.match(harness.status.textContent, /Powered by TfL Open Data/);
});

test("map preview reports protected boundary-data failures without claiming success", async () => {
  const harness = loadMapComponent({
    ok: false,
    status: 403,
    json: async () => ({ error: "System settings access is required." })
  });

  await harness.start();

  assert.equal(harness.mapCount, 0);
  assert.equal(harness.polygons.length, 0);
  assert.match(harness.status.textContent, /Map preview unavailable/);
  assert.doesNotMatch(harness.status.textContent, /boundary displayed/);
});

test("map preview reports Google Maps loading failures without claiming success", async () => {
  const harness = loadMapComponent({
    ok: true,
    status: 200,
    json: async () => getLondonLezBoundary()
  }, async () => {
    throw new Error("Google Maps unavailable");
  });

  await harness.start();

  assert.equal(harness.mapCount, 0);
  assert.equal(harness.polygons.length, 0);
  assert.match(harness.status.textContent, /Map preview unavailable/);
  assert.doesNotMatch(harness.status.textContent, /boundary displayed/);
});
