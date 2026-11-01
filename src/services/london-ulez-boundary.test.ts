import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getLondonLezBoundary } from "./london-lez-boundary";
import {
  getLondonUlezBoundary,
  londonUlezBoundaryMetadata,
  parseLondonUlezBoundary,
  validateLondonUlezBoundary
} from "./london-ulez-boundary";

test("London ULEZ reference data preserves the supplied 22 source features", () => {
  const boundary = getLondonUlezBoundary();
  const supplied = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "src/reference-data/toll-fees/london-ulez/boundary.geojson"),
    "utf8"
  ));

  assert.deepEqual(boundary, supplied);
  assert.equal(boundary.type, "FeatureCollection");
  assert.equal(boundary.features.length, 22);
  assert.equal(new Set(boundary.features.map((feature) => feature.properties["@id"])).size, 22);
  assert.equal(new Set(boundary.features.map((feature) => feature.properties.UNIQUE_ID)).size, 22);
  assert.ok(boundary.features.every((feature) => feature.properties.DATASET === "Low Emission Zone"));
  assert.deepEqual(
    [...new Set(boundary.features.map((feature) => feature.properties.DATE_CREAT))],
    ["20071113"]
  );
  assert.deepEqual(
    boundary.features.reduce<Record<string, number>>((counts, feature) => {
      counts[feature.geometry.type] = (counts[feature.geometry.type] ?? 0) + 1;
      return counts;
    }, {}),
    { Polygon: 21, MultiPolygon: 1 }
  );
  assert.equal(londonUlezBoundaryMetadata.featureCount, 22);
  assert.equal(londonUlezBoundaryMetadata.sourceUrl, "Not provided");
  assert.equal(londonUlezBoundaryMetadata.sourceArchive, "Not provided");
  assert.equal(londonUlezBoundaryMetadata.licence, "Not provided");
  assert.equal(londonUlezBoundaryMetadata.effectiveDate, "Not provided");
  assert.equal(londonUlezBoundaryMetadata.verificationDate, "Unverified");
});

test("London ULEZ and LEZ source features have matching geometry without changing LEZ records", () => {
  const lez = getLondonLezBoundary();
  const ulez = getLondonUlezBoundary();
  const ulezById = new Map(ulez.features.map((feature) => [feature.properties.UNIQUE_ID, feature]));

  for (const lezFeature of lez.features) {
    const ulezFeature = ulezById.get(lezFeature.properties.UNIQUE_ID);
    assert.ok(ulezFeature);
    assert.deepEqual(ulezFeature.geometry, lezFeature.geometry);
    assert.equal(lezFeature.properties.DATASET, "Low Emission Zone");
  }
});

test("every London ULEZ position and closed polygon ring is valid WGS 84", () => {
  const boundary = getLondonUlezBoundary();
  let coordinateCount = 0;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length === 2 && value.every((coordinate) => typeof coordinate === "number")) {
      const [longitude, latitude] = value as number[];
      assert.ok(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180);
      assert.ok(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90);
      coordinateCount += 1;
      return;
    }
    value.forEach(visit);
  };

  boundary.features.forEach((feature) => visit(feature.geometry.coordinates));
  assert.equal(coordinateCount, 24_856);
  assert.ok(validateLondonUlezBoundary(boundary));
});

test("invalid London ULEZ GeoJSON is rejected explicitly instead of becoming empty data", () => {
  const boundary = getLondonUlezBoundary();
  assert.equal(validateLondonUlezBoundary({ ...boundary, features: boundary.features.slice(0, -1) }), false);
  assert.throws(() => parseLondonUlezBoundary({ type: "FeatureCollection", features: [] }), /failed validation/);

  const duplicateIds = structuredClone(boundary);
  duplicateIds.features[1].properties["@id"] = duplicateIds.features[0].properties["@id"];
  assert.equal(validateLondonUlezBoundary(duplicateIds), false);

  const invalidCoordinates = structuredClone(boundary);
  const setFirstLongitudeOutOfRange = (value: unknown): boolean => {
    if (!Array.isArray(value)) return false;
    if (value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      value[0] = 181;
      return true;
    }
    return value.some(setFirstLongitudeOutOfRange);
  };
  assert.equal(setFirstLongitudeOutOfRange(invalidCoordinates.features[0].geometry.coordinates), true);
  assert.equal(validateLondonUlezBoundary(invalidCoordinates), false);
});
