import { query } from "../database/connection";
import {
  calculateDistanceSlabFare,
  MAX_DEAD_MILEAGE_RADIUS_MILES,
  validateDistanceSlabsForm,
  type DistanceSlab
} from "./fare-settings";

const EARTH_RADIUS_MILES = 6_371_008.8 / 1609.344;

export type GeoPoint = { latitude: number; longitude: number };
export type DeadMileageLeg = "base-to-pickup" | "dropoff-to-base";

export type OperationalBase = {
  operatorId: string;
  latitude: number | null;
  longitude: number | null;
  providerPlaceId: string | null;
  coordinatesVerified: boolean;
  updatedAt: string | null;
};

export function isOperationalBaseVerified(base: OperationalBase | null): boolean {
  return Boolean(base?.coordinatesVerified && validPoint({
    latitude: base.latitude ?? NaN,
    longitude: base.longitude ?? NaN
  }) && base.providerPlaceId && base.updatedAt);
}

export async function getOperationalBase(): Promise<OperationalBase | null> {
  const result = await query<{
    operator_id: string;
    latitude: string | number | null;
    longitude: string | number | null;
    provider_place_id: string | null;
    coordinates_verified: boolean;
    updated_at: string | Date;
  }>(
    `SELECT address.operator_id, address.latitude, address.longitude,
            address.provider_place_id, address.coordinates_verified, address.updated_at
       FROM operator_addresses address
       JOIN system_setup_state setup ON setup.operator_id = address.operator_id
      WHERE setup.setup_key = 'initial_system_setup'
        AND address.address_type = 'operational'
      LIMIT 1`
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    operatorId: row.operator_id,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    providerPlaceId: row.provider_place_id,
    coordinatesVerified: row.coordinates_verified,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

export type RouteGeometry = {
  points: GeoPoint[];
  source: string;
  routeId: string;
};

export type DeadMileageInput = {
  base: OperationalBase | null;
  freeRadiusMiles: string;
  distanceSlabs: DistanceSlab[];
  distanceSlabsVersion: number;
  vehicleDispatchedFromBase: boolean | null;
  returnToBaseAfterDropoff: boolean | null;
  baseToPickup?: RouteGeometry | null;
  dropoffToBase?: RouteGeometry | null;
};

export type DeadMileageSnapshot = {
  freeRadiusMiles: string;
  operationalBase: null | {
    operatorId: string;
    latitude: number;
    longitude: number;
    providerPlaceId: string;
    updatedAt: string;
  };
  bookingFlags: {
    vehicleDispatchedFromBase: boolean;
    returnToBaseAfterDropoff: boolean;
  };
  routes: Partial<Record<DeadMileageLeg, {
    source: string;
    routeId: string;
    points: GeoPoint[];
    routeMiles: string;
    outsideRadiusMiles: string;
  }>>;
  distanceSlabsVersion: number;
  distanceSlabs: DistanceSlab[];
  combinedOutsideRadiusMiles: string;
  amount: string;
};

export type DeadMileageCalculation =
  | { status: "incomplete"; reasons: string[] }
  | {
    status: "complete";
    amount: string;
    combinedOutsideRadiusMiles: string;
    contributingLegs: DeadMileageLeg[];
    fareBreakdown: null | {
      label: "Dead mileage";
      legs: DeadMileageLeg[];
      outsideRadiusMiles: string;
      distanceSlabsVersion: number;
      amount: string;
    };
    snapshot: DeadMileageSnapshot;
  };

function validPoint(point: GeoPoint): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
    point.latitude >= -90 && point.latitude <= 90 &&
    point.longitude >= -180 && point.longitude <= 180;
}

function validRoutePoints(points: GeoPoint[]): boolean {
  if (points.length < 2 || !points.every(validPoint)) return false;
  for (let index = 1; index < points.length; index += 1) {
    if (dot(vector(points[index - 1]), vector(points[index])) <= -1 + 1e-12) return false;
  }
  return true;
}

function vector(point: GeoPoint): [number, number, number] {
  const latitude = point.latitude * Math.PI / 180;
  const longitude = point.longitude * Math.PI / 180;
  return [
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude)
  ];
}

function dot(left: number[], right: number[]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function pointAt(
  start: number[],
  tangent: number[],
  angle: number
): [number, number, number] {
  return [
    start[0] * Math.cos(angle) + tangent[0] * Math.sin(angle),
    start[1] * Math.cos(angle) + tangent[1] * Math.sin(angle),
    start[2] * Math.cos(angle) + tangent[2] * Math.sin(angle)
  ];
}

function roundedMiles(value: number): string {
  const scaled = Math.round(value * 1_000_000);
  return (scaled / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0";
}

function addMiles(left: string, right: string): string {
  const toMicromiles = (value: string): bigint => {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
  };
  const total = toMicromiles(left) + toMicromiles(right);
  const whole = total / 1_000_000n;
  const fraction = String(total % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function segmentOutsideMiles(startPoint: GeoPoint, endPoint: GeoPoint, centre: GeoPoint, radiusMiles: number): number {
  const start = vector(startPoint);
  const end = vector(endPoint);
  const centreVector = vector(centre);
  const cosine = Math.max(-1, Math.min(1, dot(start, end)));
  const angle = Math.acos(cosine);
  if (angle < 1e-12) {
    return Math.acos(Math.max(-1, Math.min(1, dot(centreVector, start)))) * EARTH_RADIUS_MILES > radiusMiles
      ? angle * EARTH_RADIUS_MILES
      : 0;
  }

  const sine = Math.sin(angle);
  const tangent = start.map((value, index) => (end[index] - value * cosine) / sine);
  const a = dot(centreVector, start);
  const b = dot(centreVector, tangent);
  const amplitude = Math.hypot(a, b);
  const boundary = Math.cos(radiusMiles / EARTH_RADIUS_MILES);
  const crossings: number[] = [];
  if (amplitude > 1e-14 && Math.abs(boundary / amplitude) <= 1) {
    const phase = Math.atan2(b, a);
    const offset = Math.acos(Math.max(-1, Math.min(1, boundary / amplitude)));
    for (const root of [phase + offset, phase - offset]) {
      for (let turn = -1; turn <= 1; turn += 1) {
        const candidate = root + turn * 2 * Math.PI;
        if (candidate > 1e-12 && candidate < angle - 1e-12) crossings.push(candidate);
      }
    }
  }

  const divisions = [0, ...crossings.sort((left, right) => left - right), angle];
  let outsideAngle = 0;
  for (let index = 1; index < divisions.length; index += 1) {
    const from = divisions[index - 1];
    const to = divisions[index];
    const midpoint = pointAt(start, tangent, (from + to) / 2);
    const midpointDistance = Math.acos(Math.max(-1, Math.min(1, dot(centreVector, midpoint)))) * EARTH_RADIUS_MILES;
    if (midpointDistance > radiusMiles) outsideAngle += to - from;
  }
  return outsideAngle * EARTH_RADIUS_MILES;
}

export function measureRouteOutsideRadiusMiles(
  geometry: RouteGeometry,
  centre: GeoPoint,
  radiusMiles: string
): string {
  const radius = Number(radiusMiles);
  if (!Number.isFinite(radius) || radius < 0 || !validPoint(centre) ||
      !validRoutePoints(geometry.points)) {
    throw new TypeError("Valid route geometry, centre coordinates, and radius are required.");
  }
  const maxRadius = MAX_DEAD_MILEAGE_RADIUS_MILES;
  if (radius >= maxRadius) return "0";
  const metres = geometry.points.slice(1).reduce(
    (total, point, index) => total + segmentOutsideMiles(geometry.points[index], point, centre, radius),
    0
  );
  return roundedMiles(metres);
}

export function measureRouteMiles(geometry: RouteGeometry): string {
  if (!validRoutePoints(geometry.points)) {
    throw new TypeError("Valid route geometry is required.");
  }
  const miles = geometry.points.slice(1).reduce((total, point, index) => {
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(
      vector(geometry.points[index]),
      vector(point)
    ))));
    return total + angle * EARTH_RADIUS_MILES;
  }, 0);
  return roundedMiles(miles);
}

export function calculateDeadMileage(input: DeadMileageInput): DeadMileageCalculation {
  if (typeof input.vehicleDispatchedFromBase !== "boolean" ||
      typeof input.returnToBaseAfterDropoff !== "boolean") {
    return { status: "incomplete", reasons: ["Select Yes or No for both dead-mileage booking flags."] };
  }
  const requestedLegs: Array<{ leg: DeadMileageLeg; geometry: RouteGeometry | null | undefined }> = [];
  if (input.vehicleDispatchedFromBase) requestedLegs.push({ leg: "base-to-pickup", geometry: input.baseToPickup });
  if (input.returnToBaseAfterDropoff) requestedLegs.push({ leg: "dropoff-to-base", geometry: input.dropoffToBase });
  if (requestedLegs.length === 0) {
    const snapshot: DeadMileageSnapshot = {
      freeRadiusMiles: input.freeRadiusMiles,
      operationalBase: input.base?.coordinatesVerified && validPoint({
        latitude: input.base.latitude ?? NaN,
        longitude: input.base.longitude ?? NaN
      }) && input.base.providerPlaceId && input.base.updatedAt
        ? {
          operatorId: input.base.operatorId,
          latitude: input.base.latitude!,
          longitude: input.base.longitude!,
          providerPlaceId: input.base.providerPlaceId,
          updatedAt: input.base.updatedAt
        }
        : null,
      bookingFlags: {
        vehicleDispatchedFromBase: false,
        returnToBaseAfterDropoff: false
      },
      routes: {},
      distanceSlabsVersion: input.distanceSlabsVersion,
      distanceSlabs: input.distanceSlabs,
      combinedOutsideRadiusMiles: "0",
      amount: "0.00"
    };
    return {
      status: "complete",
      amount: "0.00",
      combinedOutsideRadiusMiles: "0",
      contributingLegs: [],
      fareBreakdown: null,
      snapshot
    };
  }

  const reasons: string[] = [];
  if (!input.base?.coordinatesVerified || !validPoint({
    latitude: input.base.latitude ?? NaN,
    longitude: input.base.longitude ?? NaN
  }) || !input.base.providerPlaceId || !input.base.updatedAt) {
    reasons.push("The operational base needs verified coordinates and a saved base version.");
  }
  const radius = Number(input.freeRadiusMiles);
  if (!Number.isFinite(radius) || radius <= 0 || radius > MAX_DEAD_MILEAGE_RADIUS_MILES) {
    reasons.push("A valid configured free radius is required.");
  }
  for (const { leg, geometry } of requestedLegs) {
    if (!geometry || !validRoutePoints(geometry.points) ||
        !geometry.source || !geometry.routeId) {
      reasons.push(`Actual road-route geometry is missing for ${leg}.`);
    }
  }
  if (reasons.length) return { status: "incomplete", reasons };

  const centre = { latitude: input.base!.latitude!, longitude: input.base!.longitude! };
  const routes: DeadMileageSnapshot["routes"] = {};
  const contributingLegs: DeadMileageLeg[] = [];
  let combinedOutsideRadiusMiles = "0";
  for (const { leg, geometry } of requestedLegs) {
    const routeMiles = measureRouteMiles(geometry!);
    const outsideRadiusMiles = measureRouteOutsideRadiusMiles(geometry!, centre, input.freeRadiusMiles);
    routes[leg] = {
      source: geometry!.source,
      routeId: geometry!.routeId,
      points: geometry!.points,
      routeMiles,
      outsideRadiusMiles
    };
    if (outsideRadiusMiles !== "0") contributingLegs.push(leg);
    combinedOutsideRadiusMiles = addMiles(combinedOutsideRadiusMiles, outsideRadiusMiles);
  }
  let amount = "0.00";
  if (combinedOutsideRadiusMiles !== "0") {
    const validation = validateDistanceSlabsForm({ distanceSlabs: input.distanceSlabs });
    if (Object.keys(validation.errors).length > 0) {
      return { status: "incomplete", reasons: ["A valid Distance Slabs schedule is required to price dead mileage."] };
    }
    try {
      amount = calculateDistanceSlabFare(input.distanceSlabs, combinedOutsideRadiusMiles);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return { status: "incomplete", reasons: [error.message] };
    }
  }
  const snapshot: DeadMileageSnapshot = {
    freeRadiusMiles: input.freeRadiusMiles,
    operationalBase: {
      operatorId: input.base!.operatorId,
      latitude: centre.latitude,
      longitude: centre.longitude,
      providerPlaceId: input.base!.providerPlaceId!,
      updatedAt: input.base!.updatedAt!
    },
    bookingFlags: {
      vehicleDispatchedFromBase: input.vehicleDispatchedFromBase,
      returnToBaseAfterDropoff: input.returnToBaseAfterDropoff
    },
    routes,
    distanceSlabsVersion: input.distanceSlabsVersion,
    distanceSlabs: input.distanceSlabs,
    combinedOutsideRadiusMiles,
    amount
  };
  return {
    status: "complete",
    amount,
    combinedOutsideRadiusMiles,
    contributingLegs,
    fareBreakdown: amount === "0.00" ? null : {
      label: "Dead mileage",
      legs: contributingLegs,
      outsideRadiusMiles: combinedOutsideRadiusMiles,
      distanceSlabsVersion: input.distanceSlabsVersion,
      amount
    },
    snapshot
  };
}
