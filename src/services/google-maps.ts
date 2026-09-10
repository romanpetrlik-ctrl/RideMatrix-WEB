import type { GeocodedAddress, GeoPoint, MapProvider } from "./maps";
import { isValidGeoPoint, normalizeAddress } from "./maps";

const GEOCODING_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const DEFAULT_TIMEOUT_MS = 5_000;

type GoogleResponse = {
  status?: string;
  results?: Array<{
    formatted_address?: unknown;
    place_id?: unknown;
    partial_match?: unknown;
    types?: unknown;
    geometry?: { location?: { lat?: unknown; lng?: unknown } };
    address_components?: Array<{ long_name?: unknown; short_name?: unknown; types?: unknown }>;
  }>;
};

function component(result: NonNullable<GoogleResponse["results"]>[number], type: string): string | undefined {
  const item = result.address_components?.find((entry) => Array.isArray(entry.types) && entry.types.includes(type));
  return typeof item?.long_name === "string" ? item.long_name : undefined;
}

function parseResult(result: NonNullable<GoogleResponse["results"]>[number]): GeocodedAddress | null {
  const formattedAddress = typeof result.formatted_address === "string" ? result.formatted_address.trim() : "";
  const latitude = result.geometry?.location?.lat;
  const longitude = result.geometry?.location?.lng;
  if (!formattedAddress || typeof latitude !== "number" || typeof longitude !== "number") {
    return null;
  }

  const point = { latitude, longitude };
  if (!isValidGeoPoint(point)) {
    return null;
  }

  const types = Array.isArray(result.types) ? result.types.filter((type): type is string => typeof type === "string") : [];
  const precise = types.some((type) => ["street_address", "premise", "subpremise"].includes(type));
  const broad = types.some((type) => ["locality", "postal_town", "administrative_area_level_1", "country"].includes(type));
  const matchQuality = result.partial_match === true ? "partial" : precise ? "exact" : broad ? "partial" : "ambiguous";
  const country = result.address_components?.find((entry) => Array.isArray(entry.types) && entry.types.includes("country"));

  return {
    formattedAddress,
    point,
    countryCode: typeof country?.short_name === "string" ? country.short_name : undefined,
    countryName: typeof country?.long_name === "string" ? country.long_name : undefined,
    city: component(result, "postal_town") || component(result, "locality"),
    postcode: component(result, "postal_code"),
    providerPlaceId: typeof result.place_id === "string" ? result.place_id : undefined,
    matchQuality
  };
}

export function createGoogleMapsProvider(
  apiKey: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; logger?: (message: string) => void } = {}
): MapProvider {
  const request = options.fetch || fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = options.logger || ((message) => console.warn(`[maps] ${message}`));
  const cache = new Map<string, GeocodedAddress | null>();

  async function requestGoogle(params: URLSearchParams): Promise<GeocodedAddress | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(`${GEOCODING_ENDPOINT}?${params.toString()}`, { signal: controller.signal });
      if (!response.ok) {
        logger(`Google geocoding request failed with HTTP ${response.status}.`);
        return null;
      }
      const body = (await response.json()) as GoogleResponse;
      if (body.status === "ZERO_RESULTS") return null;
      if (body.status !== "OK") {
        logger(`Google geocoding request returned ${body.status || "an invalid status"}.`);
        return null;
      }
      const results = Array.isArray(body.results) ? body.results : [];
      const parsed = results.map(parseResult).filter((value): value is GeocodedAddress => value !== null);
      if (parsed.length === 0) return null;
      const exactResults = parsed.filter((value) => value.matchQuality === "exact");
      if (exactResults.length > 1) return { ...exactResults[0], matchQuality: "ambiguous" };
      return exactResults[0] || parsed[0];
    } catch (error) {
      logger(error instanceof Error && error.name === "AbortError" ? "Google geocoding request timed out." : "Google geocoding request failed.");
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async geocodeAddress(address) {
      const normalized = normalizeAddress(address);
      if (!normalized) return null;
      const key = `address:${normalized.toLowerCase()}`;
      if (cache.has(key)) return cache.get(key) || null;
      const result = await requestGoogle(new URLSearchParams({ address: normalized, key: apiKey, region: "uk" }));
      cache.set(key, result);
      return result;
    },
    async reverseGeocode(point: GeoPoint) {
      if (!isValidGeoPoint(point)) return null;
      const key = `point:${point.latitude},${point.longitude}`;
      if (cache.has(key)) return cache.get(key) || null;
      const result = await requestGoogle(new URLSearchParams({ latlng: `${point.latitude},${point.longitude}`, key: apiKey }));
      cache.set(key, result);
      return result;
    }
  };
}
