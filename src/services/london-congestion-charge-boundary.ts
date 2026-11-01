import fs from "node:fs";
import path from "node:path";

type Position = [number, number];
type LinearRing = Position[];

type LondonCongestionChargeFeature = {
  type: "Feature";
  properties: Record<string, string | number>;
  geometry: {
    type: "Polygon";
    coordinates: LinearRing[];
  };
};

export type LondonCongestionChargeBoundary = {
  type: "FeatureCollection";
  features: LondonCongestionChargeFeature[];
};

export const londonCongestionChargeBoundaryMetadata = {
  title: "London Congestion Charge boundary",
  featureCount: 2,
  sourceUrl: "Not provided",
  sourceArchive: "Not provided",
  licence: "Not provided",
  effectiveDate: "Unknown (not provided)",
  verificationDate: "Unverified"
} as const;

const boundaryPath = path.join(__dirname, "../reference-data/toll-fees/london-congestion-charge/boundary.geojson");
let cachedBoundary: LondonCongestionChargeBoundary | undefined;

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

function isLondonCongestionChargeFeature(value: unknown): value is LondonCongestionChargeFeature {
  if (!value || typeof value !== "object") return false;
  const feature = value as Partial<LondonCongestionChargeFeature>;
  const properties = feature.properties;
  if (
    feature.type !== "Feature"
    || !isProperties(properties)
    || typeof properties.OBJECTID !== "number"
    || properties.BOUNDARY !== "CLoCCS"
    || properties.DESCRIPTIO !== "Central London Congestion Charging Scheme"
    || typeof properties.SHAPE_AREA !== "number"
    || typeof properties.SHAPE_LEN !== "number"
    || typeof properties["@id"] !== "string"
    || !properties["@id"]
    || !feature.geometry
    || feature.geometry.type !== "Polygon"
    || !Array.isArray(feature.geometry.coordinates)
    || feature.geometry.coordinates.length === 0
    || !feature.geometry.coordinates.every(isLinearRing)
  ) {
    return false;
  }

  return true;
}

export function validateLondonCongestionChargeBoundary(value: unknown): value is LondonCongestionChargeBoundary {
  if (!value || typeof value !== "object") return false;
  const collection = value as Partial<LondonCongestionChargeBoundary>;
  if (
    collection.type !== "FeatureCollection"
    || !Array.isArray(collection.features)
    || collection.features.length !== londonCongestionChargeBoundaryMetadata.featureCount
    || !collection.features.every(isLondonCongestionChargeFeature)
  ) {
    return false;
  }

  const objectIds = collection.features.map((feature) => feature.properties.OBJECTID);
  const featureIds = collection.features.map((feature) => feature.properties["@id"]);
  return new Set(objectIds).size === objectIds.length
    && new Set(featureIds).size === featureIds.length;
}

export function parseLondonCongestionChargeBoundary(value: unknown): LondonCongestionChargeBoundary {
  if (!validateLondonCongestionChargeBoundary(value)) {
    throw new Error("The packaged London Congestion Charge boundary data failed validation.");
  }
  return value;
}

export function parseLondonCongestionChargeBoundaryJson(source: string): LondonCongestionChargeBoundary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("The packaged London Congestion Charge boundary data is not valid JSON.", { cause: error });
    }
    throw error;
  }
  return parseLondonCongestionChargeBoundary(parsed);
}

export function getLondonCongestionChargeBoundary(): LondonCongestionChargeBoundary {
  if (cachedBoundary) return cachedBoundary;

  cachedBoundary = parseLondonCongestionChargeBoundaryJson(fs.readFileSync(boundaryPath, "utf8"));
  return cachedBoundary;
}
