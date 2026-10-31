import fs from "node:fs";
import path from "node:path";

type Position = [number, number];
type LinearRing = Position[];

type LondonLezPolygon = {
  type: "Polygon";
  coordinates: LinearRing[];
};

type LondonLezMultiPolygon = {
  type: "MultiPolygon";
  coordinates: LinearRing[][];
};

type LondonLezFeature = {
  type: "Feature";
  properties: Record<string, string | number>;
  geometry: LondonLezPolygon | LondonLezMultiPolygon;
};

export type LondonLezBoundary = {
  type: "FeatureCollection";
  features: LondonLezFeature[];
};

export const londonLezBoundaryMetadata = {
  title: "London Low Emission Zone boundary",
  featureCount: 22,
  sourceArchive: "LEZ_Boundary_20211026_Shape_Files.zip",
  datasetVersion: "2021-10-26",
  originalFeatureDate: "2007-11-13",
  verificationDate: "2026-10-31",
  sourceUrl: "https://roads.data.tfl.gov.uk/#!boundaries%2F",
  termsUrl: "https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service",
  licence: "TfL Transport Data Service terms",
  attribution: "Powered by TfL Open Data",
  sourceCoordinateSystem: "EPSG:27700 (British National Grid)",
  displayCoordinateSystem: "WGS 84 (RFC 7946 longitude, latitude)"
} as const;

const boundaryPath = path.join(__dirname, "../reference-data/toll-fees/london-lez/boundary.geojson");
let cachedBoundary: LondonLezBoundary | undefined;

function isPosition(value: unknown): value is Position {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === "number"
    && Number.isFinite(value[0])
    && value[0] >= -180
    && value[0] <= 180
    && typeof value[1] === "number"
    && Number.isFinite(value[1])
    && value[1] >= -90
    && value[1] <= 90;
}

function isLinearRing(value: unknown): value is LinearRing {
  return Array.isArray(value) && value.length >= 4 && value.every(isPosition);
}

function isProperties(value: unknown): value is Record<string, string | number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) =>
    typeof item === "string" || (typeof item === "number" && Number.isFinite(item))
  );
}

function isLondonLezFeature(value: unknown): value is LondonLezFeature {
  if (!value || typeof value !== "object") return false;
  const feature = value as Partial<LondonLezFeature>;
  if (
    feature.type !== "Feature"
    || !isProperties(feature.properties)
    || typeof feature.properties.UNIQUE_ID !== "string"
    || feature.properties.DATASET !== "Low Emission Zone"
    || feature.properties.DATE_CREAT !== "20071113"
    || !feature.geometry
  ) {
    return false;
  }

  if (feature.geometry.type === "Polygon") {
    return Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.every(isLinearRing);
  }
  if (feature.geometry.type === "MultiPolygon") {
    return Array.isArray(feature.geometry.coordinates)
      && feature.geometry.coordinates.length > 0
      && feature.geometry.coordinates.every((polygon) =>
        Array.isArray(polygon) && polygon.length > 0 && polygon.every(isLinearRing)
      );
  }
  return false;
}

export function validateLondonLezBoundary(value: unknown): value is LondonLezBoundary {
  if (!value || typeof value !== "object") return false;
  const collection = value as Partial<LondonLezBoundary>;
  if (
    collection.type !== "FeatureCollection"
    || !Array.isArray(collection.features)
    || collection.features.length !== londonLezBoundaryMetadata.featureCount
    || !collection.features.every(isLondonLezFeature)
  ) {
    return false;
  }
  const ids = collection.features.map((feature) => feature.properties.UNIQUE_ID);
  return new Set(ids).size === ids.length;
}

export function getLondonLezBoundary(): LondonLezBoundary {
  if (cachedBoundary) return cachedBoundary;

  const parsed: unknown = JSON.parse(fs.readFileSync(boundaryPath, "utf8"));
  if (!validateLondonLezBoundary(parsed)) {
    throw new Error("The packaged London LEZ boundary data failed validation.");
  }

  cachedBoundary = parsed;
  return cachedBoundary;
}
