export type GeoPoint = {
  latitude: number;
  longitude: number;
};

export type GeocodedAddress = {
  formattedAddress: string;
  point: GeoPoint;
  countryCode?: string;
  countryName?: string;
  city?: string;
  postcode?: string;
  providerPlaceId?: string;
  matchQuality?: "exact" | "partial" | "ambiguous";
};

export type MapView = {
  latitude: number;
  longitude: number;
  label: string;
  zoom: number;
};

export interface MapProvider {
  geocodeAddress(address: string): Promise<GeocodedAddress | null>;
  reverseGeocode(point: GeoPoint): Promise<GeocodedAddress | null>;
}

export type MapConfiguration = {
  enabled: boolean;
  provider: "google" | "";
  serverApiKey?: string;
  browserApiKey?: string;
  mapId?: string;
  geocodingEnabled: boolean;
  defaultPoint?: GeoPoint;
};

export type MapService = MapProvider & {
  enabled: boolean;
  configuration: MapConfiguration;
};

const DEFAULT_ZOOM = 14;

export function isValidGeoPoint(point: unknown): point is GeoPoint {
  if (!point || typeof point !== "object") {
    return false;
  }

  const candidate = point as Partial<GeoPoint>;
  return (
    typeof candidate.latitude === "number" &&
    Number.isFinite(candidate.latitude) &&
    candidate.latitude >= -90 &&
    candidate.latitude <= 90 &&
    typeof candidate.longitude === "number" &&
    Number.isFinite(candidate.longitude) &&
    candidate.longitude >= -180 &&
    candidate.longitude <= 180
  );
}

export function normalizeAddress(address: string): string {
  return String(address || "").trim().replace(/\s+/g, " ");
}

export function readMapConfiguration(env: NodeJS.ProcessEnv = process.env): MapConfiguration {
  return {
    enabled: String(env.GOOGLE_MAPS_ENABLED || "").trim().toLowerCase() === "true",
    provider: "google",
    serverApiKey: String(env.GOOGLE_MAPS_SERVER_API_KEY || "").trim() || undefined,
    browserApiKey: String(env.GOOGLE_MAPS_BROWSER_API_KEY || "").trim() || undefined,
    mapId: String(env.GOOGLE_MAPS_MAP_ID || "").trim() || undefined,
    geocodingEnabled: String(env.GOOGLE_MAPS_ENABLED || "").trim().toLowerCase() === "true"
  };
}

class DisabledMapProvider implements MapProvider {
  async geocodeAddress(_address: string): Promise<GeocodedAddress | null> {
    return null;
  }

  async reverseGeocode(_point: GeoPoint): Promise<GeocodedAddress | null> {
    return null;
  }
}

function validGeocodedAddress(value: GeocodedAddress | null): GeocodedAddress | null {
  if (
    !value ||
    typeof value.formattedAddress !== "string" ||
    !value.formattedAddress.trim() ||
    !isValidGeoPoint(value.point)
  ) {
    return null;
  }

  return {
    ...value,
    formattedAddress: value.formattedAddress.trim()
  };
}

export function createMapService(
  provider: MapProvider = new DisabledMapProvider(),
  configuration: MapConfiguration = readMapConfiguration()
): MapService {
  const enabled = Boolean(
    !(provider instanceof DisabledMapProvider) &&
      configuration.enabled &&
      configuration.provider === "google" &&
      configuration.serverApiKey &&
      configuration.geocodingEnabled
  );

  return {
    enabled,
    configuration,
    async geocodeAddress(address: string): Promise<GeocodedAddress | null> {
      const normalized = normalizeAddress(address);
      if (!enabled || !normalized) {
        return null;
      }

      try {
        return validGeocodedAddress(await provider.geocodeAddress(normalized));
      } catch (error) {
        console.warn("[maps] Geocoding failed.", error instanceof Error ? error.message : "unknown error");
        return null;
      }
    },
    async reverseGeocode(point: GeoPoint): Promise<GeocodedAddress | null> {
      if (!enabled || !isValidGeoPoint(point)) {
        return null;
      }

      try {
        return validGeocodedAddress(await provider.reverseGeocode(point));
      } catch (error) {
        console.warn("[maps] Reverse geocoding failed.", error instanceof Error ? error.message : "unknown error");
        return null;
      }
    }
  };
}

export function toMapView(address: GeocodedAddress, label = "Customer address", zoom = DEFAULT_ZOOM): MapView | null {
  return validGeocodedAddress(address)
    ? { latitude: address.point.latitude, longitude: address.point.longitude, label, zoom }
    : null;
}

export function getMapService(): MapService {
  const configuration = readMapConfiguration();
  const provider = configuration.serverApiKey
    ? createGoogleMapsProvider(configuration.serverApiKey)
    : new DisabledMapProvider();
  return createMapService(provider, configuration);
}
import { createGoogleMapsProvider } from "./google-maps";
