import { readMapConfiguration } from "./maps";

export type VerifiedOperationalPlace = {
  formattedAddress: string;
  houseNameNumber: string | null;
  addressLine1: string;
  addressLine2: string | null;
  addressLine3: string | null;
  cityTown: string;
  county: string | null;
  state: string | null;
  postcode: string;
  countryCode: string;
  countryName: string;
  latitude: number;
  longitude: number;
  providerName: "google";
  providerPlaceId: string;
};

export type OperationalPlaceVerification =
  | { status: "verified"; address: VerifiedOperationalPlace }
  | { status: "outside_uk" }
  | { status: "unverified" };

type PlacesResponse = {
  formattedAddress?: unknown;
  displayName?: { text?: unknown };
  addressComponents?: Array<{
    longText?: unknown;
    shortText?: unknown;
    types?: unknown;
  }>;
  location?: {
    latitude?: unknown;
    longitude?: unknown;
  };
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function component(response: PlacesResponse, type: string, value: "longText" | "shortText" = "longText"): string {
  const found = response.addressComponents?.find((entry) =>
    Array.isArray(entry.types) && entry.types.includes(type)
  );
  return text(found?.[value]);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const key = value.toLocaleLowerCase("en-GB");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function verifiedAddress(placeId: string, response: PlacesResponse): VerifiedOperationalPlace | null {
  const latitude = response.location?.latitude;
  const longitude = response.location?.longitude;
  const countryCode = component(response, "country", "shortText").toUpperCase();
  const countryName = component(response, "country");
  if (countryCode !== "GB" || !countryName
    || typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return null;
  }

  const streetNumber = component(response, "street_number");
  const premise = component(response, "premise");
  const subpremise = component(response, "subpremise");
  const postcode = unique([
    component(response, "postal_code"),
    component(response, "postal_code_suffix")
  ]).join(" ");
  const county = component(response, "administrative_area_level_2");

  return {
    formattedAddress: text(response.formattedAddress),
    houseNameNumber: unique([subpremise, premise, streetNumber]).join(", ") || null,
    addressLine1: component(response, "route") || premise || text(response.displayName?.text),
    addressLine2: component(response, "sublocality_level_1") || component(response, "sublocality") || null,
    addressLine3: county || null,
    cityTown: component(response, "postal_town")
      || component(response, "locality")
      || county,
    county: county || null,
    state: component(response, "administrative_area_level_1") || null,
    postcode,
    countryCode,
    countryName,
    latitude,
    longitude,
    providerName: "google",
    providerPlaceId: placeId
  };
}

export async function verifyGoogleOperationalPlace(
  placeId: string,
  options: { apiKey?: string; fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<OperationalPlaceVerification> {
  const normalizedPlaceId = text(placeId);
  const apiKey = text(options.apiKey ?? readMapConfiguration().serverApiKey);
  if (!normalizedPlaceId || !apiKey) return { status: "unverified" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? 5000));
  try {
    const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(normalizedPlaceId)}`);
    const response = await (options.fetch ?? fetch)(url, {
      signal: controller.signal,
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "formattedAddress,displayName,addressComponents,location"
      }
    });
    if (!response.ok) return { status: "unverified" };
    const place = await response.json() as PlacesResponse;
    const countryCode = component(place, "country", "shortText").toUpperCase();
    if (countryCode && countryCode !== "GB") return { status: "outside_uk" };
    const address = verifiedAddress(normalizedPlaceId, place);
    return address ? { status: "verified", address } : { status: "unverified" };
  } catch (error) {
    console.warn("[google-places] Place verification failed.", error instanceof Error ? error.message : "unknown error");
    return { status: "unverified" };
  } finally {
    clearTimeout(timeout);
  }
}
