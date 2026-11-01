import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  getLondonCongestionChargeBoundary,
  londonCongestionChargeBoundaryMetadata,
  parseLondonCongestionChargeBoundary,
  parseLondonCongestionChargeBoundaryJson,
  validateLondonCongestionChargeBoundary
} from "./london-congestion-charge-boundary";

test("London Congestion Charge reference data retains both supplied Polygon features", () => {
  const boundary = getLondonCongestionChargeBoundary();
  const supplied = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "src/reference-data/toll-fees/london-congestion-charge/boundary.geojson"),
    "utf8"
  ));

  assert.deepEqual(boundary, supplied);
  assert.equal(boundary.type, "FeatureCollection");
  assert.equal(boundary.features.length, 2);
  assert.deepEqual(boundary.features.map((feature) => feature.properties.OBJECTID), [1, 2]);
  assert.deepEqual(boundary.features.map((feature) => feature.properties["@id"]), [
    "997158a0-d5e7-11f1-9b9f-b10002f815fc",
    "997158a1-d5e7-11f1-9b9f-b10002f815fc"
  ]);
  assert.deepEqual(boundary.features.map((feature) => feature.properties), [
    {
      OBJECTID: 1,
      BOUNDARY: "CLoCCS",
      DESCRIPTIO: "Central London Congestion Charging Scheme",
      SHAPE_AREA: 2712.88224283,
      SHAPE_LEN: 806.262926061,
      "@id": "997158a0-d5e7-11f1-9b9f-b10002f815fc"
    },
    {
      OBJECTID: 2,
      BOUNDARY: "CLoCCS",
      DESCRIPTIO: "Central London Congestion Charging Scheme",
      SHAPE_AREA: 21372865.677,
      SHAPE_LEN: 20761.6958959,
      "@id": "997158a1-d5e7-11f1-9b9f-b10002f815fc"
    }
  ]);
  assert.ok(boundary.features.every((feature) => feature.geometry.type === "Polygon"));
  assert.ok(boundary.features.every((feature) => feature.properties.BOUNDARY === "CLoCCS"));
  assert.ok(boundary.features.every((feature) =>
    feature.properties.DESCRIPTIO === "Central London Congestion Charging Scheme"
  ));
  assert.deepEqual(
    Object.keys(boundary.features[0].properties).sort(),
    ["@id", "BOUNDARY", "DESCRIPTIO", "OBJECTID", "SHAPE_AREA", "SHAPE_LEN"].sort()
  );
  assert.deepEqual(
    boundary.features.map(({ properties }) => [properties.SHAPE_AREA, properties.SHAPE_LEN]),
    [[2712.88224283, 806.262926061], [21372865.677, 20761.6958959]]
  );
  assert.equal(londonCongestionChargeBoundaryMetadata.featureCount, 2);
  assert.equal(londonCongestionChargeBoundaryMetadata.sourceUrl, "Not provided");
  assert.equal(londonCongestionChargeBoundaryMetadata.sourceArchive, "Not provided");
  assert.equal(londonCongestionChargeBoundaryMetadata.licence, "Not provided");
  assert.equal(londonCongestionChargeBoundaryMetadata.effectiveDate, "Unknown (not provided)");
  assert.equal(londonCongestionChargeBoundaryMetadata.verificationDate, "Unverified");
});

test("London Congestion Charge polygon coordinates are finite, in range, and closed", () => {
  const boundary = getLondonCongestionChargeBoundary();
  let coordinateCount = 0;
  for (const feature of boundary.features) {
    for (const ring of feature.geometry.coordinates) {
      assert.ok(ring.length >= 4);
      assert.deepEqual(ring[0], ring[ring.length - 1]);
      for (const [longitude, latitude] of ring) {
        assert.ok(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180);
        assert.ok(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90);
        coordinateCount += 1;
      }
    }
  }
  assert.equal(coordinateCount, 1_153);
  assert.ok(validateLondonCongestionChargeBoundary(boundary));
});

test("invalid London Congestion Charge GeoJSON is reported rather than partially loaded", () => {
  assert.throws(
    () => parseLondonCongestionChargeBoundaryJson("{"),
    /is not valid JSON/
  );
  assert.throws(
    () => parseLondonCongestionChargeBoundary({ type: "FeatureCollection", features: [] }),
    /failed validation/
  );

  const boundary = getLondonCongestionChargeBoundary();
  const invalidCoordinates = structuredClone(boundary);
  invalidCoordinates.features[0].geometry.coordinates[0][0][0] = 181;
  assert.equal(validateLondonCongestionChargeBoundary(invalidCoordinates), false);
  assert.throws(() => parseLondonCongestionChargeBoundary(invalidCoordinates), /failed validation/);

  const openRing = structuredClone(boundary);
  openRing.features[0].geometry.coordinates[0].pop();
  assert.equal(validateLondonCongestionChargeBoundary(openRing), false);

  const duplicateIds = structuredClone(boundary);
  duplicateIds.features[1].properties["@id"] = duplicateIds.features[0].properties["@id"];
  assert.equal(validateLondonCongestionChargeBoundary(duplicateIds), false);
});
