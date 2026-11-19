import { getLondonCongestionChargeBoundary } from "./london-congestion-charge-boundary";
import { getLondonUlezBoundary } from "./london-ulez-boundary";
import { readMapConfiguration } from "./maps";

export type RoutePoint = { latitude: number; longitude: number };

export type RoadChargeZoneId = "london-ulez" | "london-congestion-charge";

export type RoadChargeZoneDetection = { zone: RoadChargeZoneId; label: string };

export type ResolvedBookingRoute = {
  status: "resolved";
  provider: "google-routes";
  distanceMeters: number;
  /** Passenger route distance in decimal miles, six decimal places. */
  distanceMiles: string;
  durationSeconds: number;
  trafficModel: "traffic-aware" | "traffic-unaware";
  /** Ordered points decoded from the provider polyline. */
  path: RoutePoint[];
  /** Whether the provider reported tolls on this route; null when the provider did not say. */
  tollsReported: boolean | null;
  zones: RoadChargeZoneDetection[];
  computedAt: string;
};

export type UnresolvedBookingRoute = {
  status: "unresolved";
  reason: "routing-not-configured" | "missing-stops" | "provider-error" | "no-route";
  message: string;
};

export type BookingRoute = ResolvedBookingRoute | UnresolvedBookingRoute;

export type BookingRouteProvider = (stops: RoutePoint[], options: { departureTime?: Date }) => Promise<BookingRoute>;

const METERS_PER_MILE = 1609.344;

export function metersToMiles(distanceMeters: number): string {
  return (distanceMeters / METERS_PER_MILE).toFixed(6);
}

/** Decodes a Google encoded polyline (precision 5). */
export function decodePolyline(encoded: string): RoutePoint[] {
  const points: RoutePoint[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    const latDelta = next();
    const lngDelta = next();
    if (latDelta === null || lngDelta === null) break;
    latitude += latDelta;
    longitude += lngDelta;
    points.push({ latitude: latitude / 1e5, longitude: longitude / 1e5 });
  }
  return points;
}

type Ring = Array<[number, number]>;
type Polygon = Ring[];

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: RoutePoint, polygon: Polygon): boolean {
  if (!polygon.length || !pointInRing(point.longitude, point.latitude, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(point.longitude, point.latitude, hole));
}

type ZoneShape = { id: RoadChargeZoneId; label: string; polygons: Polygon[]; bbox: [number, number, number, number] };

function zoneShape(id: RoadChargeZoneId, label: string, features: Array<{ geometry: { type: string; coordinates: unknown } }>): ZoneShape {
  const polygons: Polygon[] = [];
  for (const feature of features) {
    if (feature.geometry.type === "Polygon") polygons.push(feature.geometry.coordinates as Polygon);
    else if (feature.geometry.type === "MultiPolygon") polygons.push(...feature.geometry.coordinates as Polygon[]);
  }
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of polygons) {
    for (const [lng, lat] of polygon[0] ?? []) {
      bbox[0] = Math.min(bbox[0], lng);
      bbox[1] = Math.min(bbox[1], lat);
      bbox[2] = Math.max(bbox[2], lng);
      bbox[3] = Math.max(bbox[3], lat);
    }
  }
  return { id, label, polygons, bbox };
}

let cachedZones: ZoneShape[] | undefined;

function loadZones(): ZoneShape[] {
  cachedZones ??= [
    zoneShape("london-ulez", "London Ultra Low Emission Zone (ULEZ)", getLondonUlezBoundary().features),
    zoneShape("london-congestion-charge", "London Congestion Charge zone", getLondonCongestionChargeBoundary().features)
  ];
  return cachedZones;
}

/** Splits each segment so consecutive points are at most ~0.001° apart (about 100 m) before zone tests. */
function densify(path: RoutePoint[]): RoutePoint[] {
  const result: RoutePoint[] = [];
  for (let i = 0; i < path.length; i += 1) {
    const point = path[i];
    if (i > 0) {
      const previous = path[i - 1];
      const steps = Math.min(500, Math.ceil(Math.max(
        Math.abs(point.latitude - previous.latitude),
        Math.abs(point.longitude - previous.longitude)
      ) / 0.001));
      for (let step = 1; step < steps; step += 1) {
        result.push({
          latitude: previous.latitude + (point.latitude - previous.latitude) * step / steps,
          longitude: previous.longitude + (point.longitude - previous.longitude) * step / steps
        });
      }
    }
    result.push(point);
  }
  return result;
}

/** Returns the London charging zones that any point of the route geometry enters. */
export function detectRoadChargeZones(path: RoutePoint[], zones: ZoneShape[] = loadZones()): RoadChargeZoneDetection[] {
  const dense = densify(path);
  return zones.filter((zone) => dense.some((point) =>
    point.longitude >= zone.bbox[0] && point.longitude <= zone.bbox[2] &&
    point.latitude >= zone.bbox[1] && point.latitude <= zone.bbox[3] &&
    zone.polygons.some((polygon) => pointInPolygon(point, polygon))
  )).map((zone) => ({ zone: zone.id, label: zone.label }));
}

type RoutesResponse = {
  routes?: Array<{
    distanceMeters?: unknown;
    duration?: unknown;
    polyline?: { encodedPolyline?: unknown };
    travelAdvisory?: { tollInfo?: unknown };
  }>;
};

function waypoint(point: RoutePoint) {
  return { location: { latLng: { latitude: point.latitude, longitude: point.longitude } } };
}

/**
 * Server-side Google Routes API adapter. Returns "unresolved" whenever routing is not configured, the provider
 * fails, or the response lacks distance/duration/geometry; distances and durations are never estimated.
 */
export function createGoogleRoutesProvider(options: {
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  zones?: () => ZoneShape[];
} = {}): BookingRouteProvider {
  return async (stops, { departureTime } = {}) => {
    const configuration = readMapConfiguration();
    const apiKey = options.apiKey ?? (configuration.enabled ? configuration.serverApiKey : undefined);
    if (!apiKey) {
      return { status: "unresolved", reason: "routing-not-configured", message: "Road routing is not configured (Google Maps server key unavailable). Distance, time on road and route charges cannot be calculated." };
    }
    if (stops.length < 2) {
      return { status: "unresolved", reason: "missing-stops", message: "Pickup and drop-off with coordinates are required to calculate the route." };
    }
    const now = (options.now ?? (() => new Date()))();
    const trafficAware = Boolean(departureTime && departureTime.getTime() > now.getTime() + 60_000);
    const body = {
      origin: waypoint(stops[0]),
      destination: waypoint(stops[stops.length - 1]),
      intermediates: stops.slice(1, -1).map(waypoint),
      travelMode: "DRIVE",
      routingPreference: trafficAware ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE",
      ...(trafficAware ? { departureTime: departureTime!.toISOString() } : {}),
      extraComputations: ["TOLLS"],
      units: "IMPERIAL",
      regionCode: "GB"
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? 8000));
    try {
      const response = await (options.fetch ?? fetch)("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.travelAdvisory.tollInfo"
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        return { status: "unresolved", reason: "provider-error", message: `The routing provider returned an error (HTTP ${response.status}). The route is unresolved.` };
      }
      const payload = await response.json() as RoutesResponse;
      const route = payload.routes?.[0];
      const distanceMeters = route?.distanceMeters;
      const durationMatch = typeof route?.duration === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(route.duration) : null;
      const encoded = route?.polyline?.encodedPolyline;
      if (!route || typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters) || distanceMeters <= 0
        || !durationMatch || typeof encoded !== "string" || !encoded) {
        return { status: "unresolved", reason: "no-route", message: "No drivable route with distance, duration and geometry was returned for these stops." };
      }
      const path = decodePolyline(encoded);
      if (path.length < 2) {
        return { status: "unresolved", reason: "no-route", message: "The routing provider returned unusable route geometry." };
      }
      const advisory = route.travelAdvisory;
      const tollsReported = advisory && typeof advisory === "object" && "tollInfo" in advisory ? true : false;
      return {
        status: "resolved",
        provider: "google-routes",
        distanceMeters,
        distanceMiles: metersToMiles(distanceMeters),
        durationSeconds: Math.round(Number(durationMatch[1])),
        trafficModel: trafficAware ? "traffic-aware" : "traffic-unaware",
        path,
        tollsReported,
        zones: detectRoadChargeZones(path, options.zones?.()),
        computedAt: now.toISOString()
      };
    } catch (error) {
      console.warn("[booking-routing] Route request failed.", error instanceof Error ? error.message : "unknown error");
      return { status: "unresolved", reason: "provider-error", message: "The routing provider could not be reached. The route is unresolved." };
    } finally {
      clearTimeout(timeout);
    }
  };
}
