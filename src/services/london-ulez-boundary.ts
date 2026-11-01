import fs from "node:fs";
import path from "node:path";

type Position = [number, number];
type LinearRing = Position[];

type LondonUlezPolygon = {
  type: "Polygon";
  coordinates: LinearRing[];
};

type LondonUlezMultiPolygon = {
  type: "MultiPolygon";
  coordinates: LinearRing[][];
};

type LondonUlezFeature = {
  type: "Feature";
  properties: Record<string, string | number>;
  geometry: LondonUlezPolygon | LondonUlezMultiPolygon;
};

export type LondonUlezBoundary = {
  type: "FeatureCollection";
  features: LondonUlezFeature[];
};

export const londonUlezBoundaryMetadata = {
  title: "London Ultra Low Emission Zone boundary",
  featureCount: 22,
  sourceUrl: "Not provided",
  sourceArchive: "Not provided",
  licence: "Not provided",
  effectiveDate: "Not provided",
  verificationDate: "Unverified"
} as const;

const boundaryPath = path.join(__dirname, "../reference-data/toll-fees/london-ulez/boundary.geojson");
let cachedBoundary: LondonUlezBoundary | undefined;

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
  return Array.isArray(value)
    && value.length >= 4
    && value.every(isPosition)
    && value[0][0] === value[value.length - 1][0]
    && value[0][1] === value[value.length - 1][1];
}

function isProperties(value: unknown): value is Record<string, string | number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) =>
    typeof item === "string" || (typeof item === "number" && Number.isFinite(item))
  );
}

function isLondonUlezFeature(value: unknown): value is LondonUlezFeature {
  if (!value || typeof value !== "object") return false;
  const feature = value as Partial<LondonUlezFeature>;
  if (
    feature.type !== "Feature"
    || !isProperties(feature.properties)
    || typeof feature.properties.UNIQUE_ID !== "string"
    || typeof feature.properties["@id"] !== "string"
    || !feature.properties.UNIQUE_ID
    || !feature.properties["@id"]
    || typeof feature.properties.DATASET !== "string"
    || typeof feature.properties.DATE_CREAT !== "string"
    || !feature.geometry
  ) {
    return false;
  }

  if (feature.geometry.type === "Polygon") {
    return Array.isArray(feature.geometry.coordinates)
      && feature.geometry.coordinates.length > 0
      && feature.geometry.coordinates.every(isLinearRing);
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

export function validateLondonUlezBoundary(value: unknown): value is LondonUlezBoundary {
  if (!value || typeof value !== "object") return false;
  const collection = value as Partial<LondonUlezBoundary>;
  if (
    collection.type !== "FeatureCollection"
    || !Array.isArray(collection.features)
    || collection.features.length !== londonUlezBoundaryMetadata.featureCount
    || !collection.features.every(isLondonUlezFeature)
  ) {
    return false;
  }

  const uniqueIds = collection.features.map((feature) => feature.properties.UNIQUE_ID);
  const featureIds = collection.features.map((feature) => feature.properties["@id"]);
  return new Set(uniqueIds).size === uniqueIds.length
    && new Set(featureIds).size === featureIds.length;
}

export function parseLondonUlezBoundary(value: unknown): LondonUlezBoundary {
  if (!validateLondonUlezBoundary(value)) {
    throw new Error("The packaged London ULEZ boundary data failed validation.");
  }
  return value;
}

export function getLondonUlezBoundary(): LondonUlezBoundary {
  if (cachedBoundary) return cachedBoundary;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(boundaryPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("The packaged London ULEZ boundary data is not valid JSON.", { cause: error });
    }
    throw error;
  }

  cachedBoundary = parseLondonUlezBoundary(parsed);
  return cachedBoundary;
}
