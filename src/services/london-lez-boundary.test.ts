import assert from "node:assert/strict";
import test from "node:test";
import {
  getLondonLezBoundary,
  londonLezBoundaryMetadata,
  validateLondonLezBoundary
} from "./london-lez-boundary";

test("London LEZ reference data retains its 22 unique source features and separate version dates", () => {
  const boundary = getLondonLezBoundary();
  const ids = boundary.features.map((feature) => feature.properties.UNIQUE_ID);

  assert.equal(boundary.type, "FeatureCollection");
  assert.equal(boundary.features.length, 22);
  assert.equal(new Set(ids).size, 22);
  assert.deepEqual(
    new Set(boundary.features.map((feature) => feature.properties.DATE_CREAT)),
    new Set(["20071113"])
  );
  assert.ok(boundary.features.every((feature) => feature.properties.DATASET === "Low Emission Zone"));
  assert.equal(londonLezBoundaryMetadata.datasetVersion, "2021-10-26");
  assert.equal(londonLezBoundaryMetadata.originalFeatureDate, "2007-11-13");
  assert.equal(londonLezBoundaryMetadata.verificationDate, "2026-10-31");
  assert.equal(londonLezBoundaryMetadata.attribution, "Powered by TfL Open Data");
});

test("every London LEZ coordinate is a valid WGS 84 longitude/latitude pair", () => {
  const boundary = getLondonLezBoundary();
  let coordinateCount = 0;
  const longitudeRange = { minimum: Infinity, maximum: -Infinity };
  const latitudeRange = { minimum: Infinity, maximum: -Infinity };
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length === 2 && value.every((coordinate) => typeof coordinate === "number")) {
      const [longitude, latitude] = value as number[];
      assert.ok(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180);
      assert.ok(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90);
      longitudeRange.minimum = Math.min(longitudeRange.minimum, longitude);
      longitudeRange.maximum = Math.max(longitudeRange.maximum, longitude);
      latitudeRange.minimum = Math.min(latitudeRange.minimum, latitude);
      latitudeRange.maximum = Math.max(latitudeRange.maximum, latitude);
      coordinateCount += 1;
      return;
    }
    value.forEach(visit);
  };

  boundary.features.forEach((feature) => visit(feature.geometry.coordinates));
  assert.ok(coordinateCount > 20_000);
  assert.ok(longitudeRange.minimum > -0.6 && longitudeRange.maximum < 0.4);
  assert.ok(latitudeRange.minimum > 51.2 && latitudeRange.maximum < 51.8);
});

test("invalid feature counts, duplicate IDs and out-of-range coordinates fail validation", () => {
  const boundary = getLondonLezBoundary();
  assert.equal(validateLondonLezBoundary({ ...boundary, features: boundary.features.slice(0, -1) }), false);

  const duplicateIds = JSON.parse(JSON.stringify(boundary)) as {
    features: Array<{ properties: { UNIQUE_ID: string } }>;
  };
  duplicateIds.features[1].properties.UNIQUE_ID = duplicateIds.features[0].properties.UNIQUE_ID;
  assert.equal(validateLondonLezBoundary(duplicateIds), false);

  const outOfRange = JSON.parse(JSON.stringify(boundary)) as {
    features: Array<{ geometry: { coordinates: unknown } }>;
  };
  const setFirstLongitudeOutOfRange = (value: unknown): boolean => {
    if (!Array.isArray(value)) return false;
    if (value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      value[0] = 181;
      return true;
    }
    return value.some(setFirstLongitudeOutOfRange);
  };
  assert.equal(setFirstLongitudeOutOfRange(outOfRange.features[0].geometry.coordinates), true);
  assert.equal(validateLondonLezBoundary(outOfRange), false);
});
