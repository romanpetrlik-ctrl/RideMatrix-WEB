import {
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
  type PhoneNumber
} from "libphonenumber-js";

export type ParsedPhoneNumber = PhoneNumber;

const DEFAULT_COUNTRY: CountryCode = "GB";

function parse(value: string, defaultCountry: CountryCode = DEFAULT_COUNTRY): ParsedPhoneNumber | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  return parsed && parsed.isValid() ? parsed : null;
}

export function parsePhoneNumberValue(
  value: string,
  defaultCountry: CountryCode = DEFAULT_COUNTRY
): ParsedPhoneNumber | null {
  return parse(value, defaultCountry);
}

export function normalizePhoneToE164(
  value: string,
  defaultCountry: CountryCode = DEFAULT_COUNTRY
): string | null {
  return parse(value, defaultCountry)?.number || null;
}

export function isValidPhoneNumberValue(
  value: string,
  defaultCountry: CountryCode = DEFAULT_COUNTRY
): boolean {
  return parse(value, defaultCountry) !== null;
}

function getCountryName(isoCode: CountryCode): string {
  return new Intl.DisplayNames(["en"], { type: "region" }).of(isoCode) || isoCode;
}

export function getPhoneCountry(
  value: string,
  defaultCountry: CountryCode = DEFAULT_COUNTRY
): { isoCode: string; countryName: string; callingCode: string } | null {
  const parsed = parse(value, defaultCountry);
  if (!parsed?.country) {
    return null;
  }

  return {
    isoCode: parsed.country,
    countryName: getCountryName(parsed.country),
    callingCode: `+${getCountryCallingCode(parsed.country)}`
  };
}

export function getPhoneDisplayValue(
  value: string,
  defaultCountry: CountryCode = DEFAULT_COUNTRY
): string | null {
  return parse(value, defaultCountry)?.formatInternational() || null;
}

export function getPhoneTelHref(
  value: string,
  defaultCountry: CountryCode = DEFAULT_COUNTRY
): string | null {
  const normalized = normalizePhoneToE164(value, defaultCountry);
  return normalized ? `tel:${normalized}` : null;
}

export function getWhatsAppHref(
  value: string,
  defaultCountry: CountryCode = DEFAULT_COUNTRY
): string | null {
  const normalized = normalizePhoneToE164(value, defaultCountry);
  return normalized ? `https://wa.me/${normalized.slice(1)}` : null;
}
