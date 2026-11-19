import { getLondonCongestionChargeBoundary, londonCongestionChargeBoundaryMetadata } from "./london-congestion-charge-boundary";
import { getLondonLezBoundary, londonLezBoundaryMetadata } from "./london-lez-boundary";
import { getLondonUlezBoundary, londonUlezBoundaryMetadata } from "./london-ulez-boundary";
import { readMapConfiguration } from "./maps";

export type RoutePoint = { latitude: number; longitude: number };

export type RoadChargeZoneId = "london-lez" | "london-ulez" | "london-congestion-charge";

export type RoadChargeZoneDetection = {
  zone: RoadChargeZoneId;
  label: string;
  /** Where the ordered route geometry first touches the zone polygon. */
  evidence: {
    method: "route-polygon-intersection";
    /** Index of the route path segment (path[i] → path[i + 1]) or vertex where contact was first found. */
    segmentIndex: number;
    firstContact: RoutePoint;
    boundaryDataset: string;
  };
};

export type TunnelId = "blackwall" | "silvertown";

export type TunnelCrossing = {
  tunnel: TunnelId;
  label: string;
  direction: "northbound" | "southbound";
  segmentIndex: number;
  point: RoutePoint;
  /** Provenance of the reference geometry used to identify the crossing. */
  geometry: { verified: boolean; provenance: string };
};

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
  /** Blackwall/Silvertown tunnel crossings identified from the route geometry, in route order. */
  tunnelCrossings: TunnelCrossing[];
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

type EdgeGrid = Map<string, number[]>;

type ZoneShape = {
  id: RoadChargeZoneId;
  label: string;
  dataset: string;
  polygons: Polygon[];
  bbox: [number, number, number, number];
  /** Flat [lng1, lat1, lng2, lat2, ...] polygon edges, indexed by grid cell for segment intersection tests. */
  edges: number[];
  grid: EdgeGrid;
};

const GRID_CELL_DEGREES = 0.01;

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function zoneShape(
  id: RoadChargeZoneId,
  label: string,
  dataset: string,
  features: Array<{ geometry: { type: string; coordinates: unknown } }>
): ZoneShape {
  const polygons: Polygon[] = [];
  for (const feature of features) {
    if (feature.geometry.type === "Polygon") polygons.push(feature.geometry.coordinates as Polygon);
    else if (feature.geometry.type === "MultiPolygon") polygons.push(...feature.geometry.coordinates as Polygon[]);
  }
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const edges: number[] = [];
  const grid: EdgeGrid = new Map();
  for (const polygon of polygons) {
    for (const [lng, lat] of polygon[0] ?? []) {
      bbox[0] = Math.min(bbox[0], lng);
      bbox[1] = Math.min(bbox[1], lat);
      bbox[2] = Math.max(bbox[2], lng);
      bbox[3] = Math.max(bbox[3], lat);
    }
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i += 1) {
        const offset = edges.length;
        const [x1, y1] = ring[i - 1];
        const [x2, y2] = ring[i];
        edges.push(x1, y1, x2, y2);
        for (let cx = Math.floor(Math.min(x1, x2) / GRID_CELL_DEGREES); cx <= Math.floor(Math.max(x1, x2) / GRID_CELL_DEGREES); cx += 1) {
          for (let cy = Math.floor(Math.min(y1, y2) / GRID_CELL_DEGREES); cy <= Math.floor(Math.max(y1, y2) / GRID_CELL_DEGREES); cy += 1) {
            const key = cellKey(cx, cy);
            const bucket = grid.get(key);
            if (bucket) bucket.push(offset);
            else grid.set(key, [offset]);
          }
        }
      }
    }
  }
  return { id, label, dataset, polygons, bbox, edges, grid };
}

/** Builds a zone from GeoJSON features; exported for tests that need small synthetic zones. */
export function createRoadChargeZone(
  id: RoadChargeZoneId,
  label: string,
  features: Array<{ geometry: { type: string; coordinates: unknown } }>,
  dataset = "test fixture"
): ZoneShape {
  return zoneShape(id, label, dataset, features);
}

let cachedZones: ZoneShape[] | undefined;

function datasetLabel(metadata: { title: string; verificationDate: string; datasetVersion?: string }): string {
  return `${metadata.title} (${metadata.datasetVersion ? `dataset ${metadata.datasetVersion}, ` : ""}verification: ${metadata.verificationDate})`;
}

function loadZones(): ZoneShape[] {
  cachedZones ??= [
    zoneShape("london-lez", "London Low Emission Zone (LEZ)", datasetLabel(londonLezBoundaryMetadata), getLondonLezBoundary().features),
    zoneShape("london-ulez", "London Ultra Low Emission Zone (ULEZ)", datasetLabel(londonUlezBoundaryMetadata), getLondonUlezBoundary().features),
    zoneShape(
      "london-congestion-charge",
      "London Congestion Charge zone",
      datasetLabel(londonCongestionChargeBoundaryMetadata),
      getLondonCongestionChargeBoundary().features
    )
  ];
  return cachedZones;
}

/** Returns t (0–1 along a→b) where segment a→b meets segment c→d, or null when they do not intersect. */
function segmentIntersection(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): number | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denominator = rx * sy - ry * sx;
  if (denominator === 0) return null;
  const qx = cx - ax;
  const qy = cy - ay;
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function insideZone(point: RoutePoint, zone: ZoneShape): boolean {
  return point.longitude >= zone.bbox[0] && point.longitude <= zone.bbox[2]
    && point.latitude >= zone.bbox[1] && point.latitude <= zone.bbox[3]
    && zone.polygons.some((polygon) => pointInPolygon(point, polygon));
}

/** First point along the ordered route where it is inside, or crosses the boundary of, the zone. */
function firstZoneContact(path: RoutePoint[], zone: ZoneShape): { segmentIndex: number; point: RoutePoint } | null {
  for (let i = 0; i < path.length; i += 1) {
    const a = path[i];
    if (insideZone(a, zone)) return { segmentIndex: i, point: a };
    const b = path[i + 1];
    if (!b) break;
    const minX = Math.min(a.longitude, b.longitude);
    const maxX = Math.max(a.longitude, b.longitude);
    const minY = Math.min(a.latitude, b.latitude);
    const maxY = Math.max(a.latitude, b.latitude);
    if (maxX < zone.bbox[0] || minX > zone.bbox[2] || maxY < zone.bbox[1] || minY > zone.bbox[3]) continue;
    let best: number | null = null;
    const seen = new Set<number>();
    for (let cx = Math.floor(minX / GRID_CELL_DEGREES); cx <= Math.floor(maxX / GRID_CELL_DEGREES); cx += 1) {
      for (let cy = Math.floor(minY / GRID_CELL_DEGREES); cy <= Math.floor(maxY / GRID_CELL_DEGREES); cy += 1) {
        for (const offset of zone.grid.get(cellKey(cx, cy)) ?? []) {
          if (seen.has(offset)) continue;
          seen.add(offset);
          const e = zone.edges;
          const t = segmentIntersection(a.longitude, a.latitude, b.longitude, b.latitude, e[offset], e[offset + 1], e[offset + 2], e[offset + 3]);
          if (t !== null && (best === null || t < best)) best = t;
        }
      }
    }
    if (best !== null) {
      return {
        segmentIndex: i,
        point: { latitude: a.latitude + (b.latitude - a.latitude) * best, longitude: a.longitude + (b.longitude - a.longitude) * best }
      };
    }
  }
  return null;
}

/**
 * Returns each London charging zone the ordered route geometry enters: a route vertex inside the polygon or any
 * route segment intersecting the polygon boundary. Endpoints alone are never used.
 */
export function detectRoadChargeZones(path: RoutePoint[], zones: ZoneShape[] = loadZones()): RoadChargeZoneDetection[] {
  const detections: RoadChargeZoneDetection[] = [];
  for (const zone of zones) {
    const contact = firstZoneContact(path, zone);
    if (!contact) continue;
    detections.push({
      zone: zone.id,
      label: zone.label,
      evidence: {
        method: "route-polygon-intersection",
        segmentIndex: contact.segmentIndex,
        firstContact: { latitude: Number(contact.point.latitude.toFixed(6)), longitude: Number(contact.point.longitude.toFixed(6)) },
        boundaryDataset: zone.dataset
      }
    });
  }
  return detections;
}

export type TunnelPortals = {
  tunnel: TunnelId;
  label: string;
  north: RoutePoint;
  south: RoutePoint;
};

export type TunnelReferenceGeometry = { verified: boolean; provenance: string; portals: TunnelPortals[] };

/**
 * Tunnel portal coordinates supplied by the project owner on 2026-11-19. A route is charged only when its ordered
 * geometry passes both portal locations in sequence.
 */
export const TUNNEL_REFERENCE_GEOMETRY: TunnelReferenceGeometry = {
  verified: true,
  provenance: "Corrected north and south portal coordinates supplied by the project owner on 2026-11-19.",
  portals: [
    {
      tunnel: "silvertown",
      label: "Silvertown Tunnel",
      south: { latitude: 51.497144847933576, longitude: 0.0032492881290614325 },
      north: { latitude: 51.50670017765821, longitude: 0.01454039191106224 }
    },
    {
      tunnel: "blackwall",
      label: "Blackwall Tunnel",
      south: { latitude: 51.49893792969339, longitude: 0.0014513865548262928 },
      north: { latitude: 51.509278165764364, longitude: -0.006665498889019285 }
    }
  ]
};

const PORTAL_MATCH_TOLERANCE_METERS = 50;
const MAX_TUNNEL_PORTAL_TRAVEL_METERS = 5_000;
const PORTAL_EVENT_MERGE_METERS = 75;

type PortalEvent = { side: "north" | "south"; alongRoute: number; segmentIndex: number; distance: number };

function routePositionsNearPortal(path: RoutePoint[], portal: RoutePoint, side: PortalEvent["side"]): PortalEvent[] {
  let distanceAlongRoute = 0;
  const events: PortalEvent[] = [];
  const metersPerDegree = 111_320;

  for (let index = 0; index + 1 < path.length; index += 1) {
    const start = path[index];
    const end = path[index + 1];
    const latitude = (start.latitude + end.latitude + portal.latitude) / 3;
    const longitudeScale = Math.cos(latitude * Math.PI / 180);
    const dx = (end.longitude - start.longitude) * metersPerDegree * longitudeScale;
    const dy = (end.latitude - start.latitude) * metersPerDegree;
    const px = (portal.longitude - start.longitude) * metersPerDegree * longitudeScale;
    const py = (portal.latitude - start.latitude) * metersPerDegree;
    const segmentLength = Math.hypot(dx, dy);
    const projection = segmentLength === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / (segmentLength * segmentLength)));
    const distance = Math.hypot(px - projection * dx, py - projection * dy);
    if (distance <= PORTAL_MATCH_TOLERANCE_METERS) {
      const event = { side, alongRoute: distanceAlongRoute + segmentLength * projection, segmentIndex: index, distance };
      const previous = events.at(-1);
      if (previous && event.alongRoute - previous.alongRoute <= PORTAL_EVENT_MERGE_METERS) {
        if (event.distance < previous.distance) events[events.length - 1] = event;
      } else {
        events.push(event);
      }
    }
    distanceAlongRoute += segmentLength;
  }

  return events;
}

/** Identifies each Blackwall/Silvertown crossing (and its direction) along the ordered route geometry. */
export function detectTunnelCrossings(path: RoutePoint[], reference: TunnelReferenceGeometry = TUNNEL_REFERENCE_GEOMETRY): TunnelCrossing[] {
  const crossings: TunnelCrossing[] = [];
  if (path.length < 2) return crossings;

  for (const tunnel of reference.portals) {
    const north = routePositionsNearPortal(path, tunnel.north, "north");
    const south = routePositionsNearPortal(path, tunnel.south, "south");
    const events = [
      ...north,
      ...south
    ].sort((a, b) => a.alongRoute - b.alongRoute);
    if (events.length < 2) continue;

    for (let index = 0; index + 1 < events.length; index += 1) {
      const first = events[index];
      const second = events[index + 1];
      const travelDistance = second.alongRoute - first.alongRoute;
      if (first.side === second.side || travelDistance > MAX_TUNNEL_PORTAL_TRAVEL_METERS) continue;
      const fromSouth = first.side === "south";
      crossings.push({
        tunnel: tunnel.tunnel,
        label: tunnel.label,
        direction: fromSouth ? "northbound" : "southbound",
        segmentIndex: Math.max(first.segmentIndex, second.segmentIndex),
        point: {
          latitude: Number(((tunnel.north.latitude + tunnel.south.latitude) / 2).toFixed(6)),
          longitude: Number(((tunnel.north.longitude + tunnel.south.longitude) / 2).toFixed(6))
        },
        geometry: { verified: reference.verified, provenance: reference.provenance }
      });
    }
  }
  return crossings.sort((a, b) => a.segmentIndex - b.segmentIndex);
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
  tunnels?: TunnelReferenceGeometry;
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
        tunnelCrossings: detectTunnelCrossings(path, options.tunnels),
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
