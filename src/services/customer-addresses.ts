import { isValidGeoPoint, normalizeAddress } from "./maps";

export type CustomerAddressParts = {
  address?: string | null;
  addressSearch?: string | null;
  houseNameNumber?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  cityTown?: string | null;
  county?: string | null;
  state?: string | null;
  postcode?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
};

export type CustomerAddressFormData = {
  address: string;
  addressSearch: string;
  houseNameNumber: string;
  addressLine1: string;
  addressLine2: string;
  addressLine3: string;
  cityTown: string;
  county: string;
  state: string;
  postcode: string;
  latitude: string;
  longitude: string;
};

function trimToString(value: string | number | null | undefined): string {
  return String(value || "").trim();
}

export function hasStructuredCustomerAddress(parts: CustomerAddressParts): boolean {
  return Boolean(
    trimToString(parts.houseNameNumber) ||
    trimToString(parts.addressLine1) ||
    trimToString(parts.addressLine2) ||
    trimToString(parts.addressLine3) ||
    trimToString(parts.cityTown) ||
    trimToString(parts.postcode)
  );
}

export function buildCustomerAddress(parts: CustomerAddressParts): string {
  return [
    parts.houseNameNumber,
    parts.addressLine1,
    parts.addressLine2,
    parts.addressLine3,
    parts.cityTown,
    parts.county,
    parts.state,
    parts.postcode
  ]
    .map((value) => normalizeAddress(trimToString(value)))
    .filter(Boolean)
    .join(", ");
}

export function normalizeCustomerAddressFallback(value: string | null | undefined): string {
  return normalizeAddress(trimToString(value));
}

export function buildCustomerAddressFormData(parts: CustomerAddressParts): CustomerAddressFormData {
  const structuredAddress = buildCustomerAddress(parts);
  const fallbackAddress = normalizeCustomerAddressFallback(parts.address || parts.addressSearch);
  const point = {
    latitude: parseCustomerCoordinate(parts.latitude),
    longitude: parseCustomerCoordinate(parts.longitude)
  };

  return {
    address: fallbackAddress,
    addressSearch: structuredAddress || fallbackAddress,
    houseNameNumber: hasStructuredCustomerAddress(parts) ? trimToString(parts.houseNameNumber) : "",
    addressLine1: hasStructuredCustomerAddress(parts) ? trimToString(parts.addressLine1) : "",
    addressLine2: hasStructuredCustomerAddress(parts) ? trimToString(parts.addressLine2) : "",
    addressLine3: hasStructuredCustomerAddress(parts) ? trimToString(parts.addressLine3) : "",
    cityTown: hasStructuredCustomerAddress(parts) ? trimToString(parts.cityTown) : "",
    county: trimToString(parts.county),
    state: trimToString(parts.state),
    postcode: hasStructuredCustomerAddress(parts) ? trimToString(parts.postcode) : "",
    latitude: isValidGeoPoint(point) ? String(point.latitude) : "",
    longitude: isValidGeoPoint(point) ? String(point.longitude) : ""
  };
}

export function parseCustomerCoordinate(value: unknown): number | null {
  const parsed = Number.parseFloat(trimToString(value as string | number | null | undefined));
  return Number.isFinite(parsed) ? parsed : null;
}
