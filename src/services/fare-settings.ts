import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../database/connection";
import type { AirportFeeRecord } from "./airport-fees";

export type FareSurchargeSettings = {
  enabled: boolean;
  percentage: string;
  startTime: string;
  endTime: string;
};

export type BankHolidaySurchargePeriod = {
  label: string;
  startDateTime: string;
  endDateTime: string;
  percentage: string;
};

export type BankHolidayFareSettings = {
  enabled: boolean;
  periods: BankHolidaySurchargePeriod[];
};

export type DistanceSlab = {
  startMiles: string;
  endMiles: string;
  ratePerMile: string;
};

/**
 * Legacy airport-specific slab set (one set shared by several airports). Read only: it is migrated to
 * additional distance slab sets by resolveAdditionalDistanceSlabSets() and is never written again.
 */
export type AirportDistanceSlabSet = {
  id: string;
  name: string;
  airportIds: string[];
  distanceSlabs: DistanceSlab[];
};

export type AdditionalSlabTargetType = "airport" | "poi";

/** A managed RideMatrix airport (Airport Fees record) or POI, referenced only by its internal ID. */
export type AdditionalSlabTarget = {
  type: AdditionalSlabTargetType;
  id: string;
};

export type ManagedSlabTarget = AdditionalSlabTarget & { displayName: string };

export type AdditionalDistanceSlabSet = {
  id: string;
  name: string;
  target: AdditionalSlabTarget;
  distanceSlabs: DistanceSlab[];
};

export type AdditionalDistanceSlabSetFormValues = {
  name: string;
  targetKey: string;
  distanceSlabs: DistanceSlab[];
};

export type DeadMileageSettings = {
  freeRadiusMiles: string;
};

export const MAX_DEAD_MILEAGE_RADIUS_MILES = Math.PI * (6_371_008.8 / 1609.344);

export type MinimumFareRule = {
  id: string;
  name: string;
  poiId: string;
  minimumBaseFare: string;
};

export type MinimumFareRuleFormValues = Omit<MinimumFareRule, "id">;

export type FixedFareEndpoint =
  | { type: "poi"; poiId: string }
  | { type: "postcode"; postcode: string; scope: "full" | "outward" };

export type FixedFareRule = {
  id: string;
  name: string;
  origin: FixedFareEndpoint;
  destination: FixedFareEndpoint;
  baseFare: string;
};

export type FixedFareRuleFormValues = {
  name: string;
  originType: string;
  originPoiId: string;
  originPostcode: string;
  originPostcodeScope: string;
  destinationType: string;
  destinationPoiId: string;
  destinationPostcode: string;
  destinationPostcodeScope: string;
  baseFare: string;
};

export type LocationDiscountPostcodePrecision = "full" | "outward";

/**
 * Percentage discount for journeys between one managed airport/POI (exact internal RideMatrix ID) and an
 * explicit set of UK postcode entries, in either direction. Configuration only: not applied to prices.
 */
export type LocationDiscountRule = {
  id: string;
  name: string;
  location: AdditionalSlabTarget;
  postcodePrecision: LocationDiscountPostcodePrecision;
  /** Normalized entries: full postcodes as "BH1 4RS", outward codes as "BH22". */
  postcodes: string[];
  /** Normalized decimal percentage greater than 0 and at most 100, e.g. "10" or "12.5". */
  discountPercentage: string;
  /** Inclusive Europe/London local dates (YYYY-MM-DD); "" means unbounded. */
  startDate: string;
  endDate: string;
  enabled: boolean;
  /** The future pricing basis: only the standard Distance Slabs base fare is discounted. */
  discountBasis: "standard-distance-slabs-base-fare";
};

export type LocationDiscountFormValues = {
  name: string;
  locationKey: string;
  postcodePrecision: string;
  postcodes: string;
  discountPercentage: string;
  startDate: string;
  endDate: string;
  enabled: string;
};

export type FareSettingsConfiguration = {
  timezone: "Europe/London";
  matchingBasis: "scheduled-service-time";
  interval: "start-inclusive-end-exclusive";
  precedence: "bank-holiday-over-daily";
  distanceSlabs: DistanceSlab[];
  /** Legacy key; superseded by additionalDistanceSlabSets. */
  airportDistanceSlabSets?: AirportDistanceSlabSet[];
  additionalDistanceSlabSets?: AdditionalDistanceSlabSet[];
  deadMileage: DeadMileageSettings;
  minimumFareRules: MinimumFareRule[];
  fixedFares: FixedFareRule[];
  locationDiscounts?: LocationDiscountRule[];
  dailySurcharge: FareSurchargeSettings;
  bankHolidaySurcharge: BankHolidayFareSettings;
};

export type FareSettingsHistoryEntry = {
  version: number;
  actorEmail: string | null;
  createdAt: string;
};

export type FareSettingsSnapshot = {
  configuration: FareSettingsConfiguration;
  currentVersion: number;
  history: FareSettingsHistoryEntry[];
};

export type FareSettingsActor = {
  accountId: string | null;
  email: string;
};

export type FareSettingsStore = {
  load: () => Promise<FareSettingsSnapshot>;
  save: (
    expectedVersion: number,
    configuration: FareSettingsConfiguration,
    actor: FareSettingsActor
  ) => Promise<void>;
};

export type FareSettingsValidation = {
  configuration: FareSettingsConfiguration;
  errors: Record<string, string>;
};

export const EMPTY_FARE_SETTINGS: FareSettingsConfiguration = {
  timezone: "Europe/London",
  matchingBasis: "scheduled-service-time",
  interval: "start-inclusive-end-exclusive",
  precedence: "bank-holiday-over-daily",
  distanceSlabs: [],
  additionalDistanceSlabSets: [],
  deadMileage: { freeRadiusMiles: "" },
  minimumFareRules: [],
  fixedFares: [],
  locationDiscounts: [],
  dailySurcharge: {
    enabled: false,
    percentage: "",
    startTime: "",
    endTime: ""
  },
  bankHolidaySurcharge: {
    enabled: false,
    periods: []
  }
};

type FareSettingsRow = {
  configuration: FareSettingsConfiguration;
  version: number;
};

type FareSettingsHistoryEntryRow = {
  version: number;
  actorEmail: string | null;
  createdAt: string | Date;
};

type FareSettingsSnapshotRow = FareSettingsRow & {
  history: FareSettingsHistoryEntryRow[];
};

export class FareSettingsVersionConflictError extends Error {
  constructor() {
    super("Fare settings changed after the form was opened. Review the latest settings and try again.");
    this.name = "FareSettingsVersionConflictError";
  }
}

function submittedString(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key] as string : "";
}

function validPercentage(value: string): boolean {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return false;
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

type DecimalValue = { coefficient: bigint; scale: number };

function parseNonNegativeDecimal(value: string): DecimalValue | null {
  if (value.length > 80 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.startsWith(".")
    ? ["0", value.slice(1)]
    : value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function normalizeMoney(value: string): string | null {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) return null;
  return value.includes(".") ? value.padEnd(value.indexOf(".") + 3, "0") : `${value}.00`;
}

function normalizeUkPostcode(value: string, scope: "full" | "outward"): string | null {
  const compact = value.trim().toUpperCase().replace(/\s+/g, "");
  const outwardPattern = /^(?:[A-PR-UWYZ](?:[0-9]{1,2}|[A-HK-Y][0-9]{1,2}|[0-9][A-HJKPSTUW]|[A-HK-Y][0-9][ABEHMNPRVWXY]))$/;
  if (scope === "outward") {
    return outwardPattern.test(compact) ? compact : null;
  }
  const match = /^(?:GIR0AA|(?:[A-PR-UWYZ](?:[0-9]{1,2}|[A-HK-Y][0-9]{1,2}|[0-9][A-HJKPSTUW]|[A-HK-Y][0-9][ABEHMNPRVWXY]))[0-9][ABDEFGHJLNPQRSTUWXYZ]{2})$/.exec(compact);
  if (!match) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function submittedValue(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key] as string : "";
}

export function validateMinimumFareRuleForm(
  submitted: unknown,
  pois: AirportFeeRecord[]
): { values: MinimumFareRuleFormValues; errors: Record<string, string> } {
  const body = submitted && typeof submitted === "object"
    ? submitted as Record<string, unknown>
    : {};
  const values: MinimumFareRuleFormValues = {
    name: submittedValue(body, "name"),
    poiId: submittedValue(body, "poiId"),
    minimumBaseFare: submittedValue(body, "minimumBaseFare")
  };
  const errors: Record<string, string> = {};
  const name = values.name.trim();
  const poiId = values.poiId.trim();

  if (!name || name.length > 160) {
    errors.name = "Enter a rule name no longer than 160 characters.";
  }
  if (!poiId) {
    errors.poiId = "Select a managed airport or point of interest.";
  } else {
    const poi = pois.find((item) => item.id === poiId);
    if (!poi) {
      errors.poiId = "Select an active managed airport or point of interest.";
    }
  }
  const minimumBaseFare = normalizeMoney(values.minimumBaseFare.trim());
  if (minimumBaseFare === null) {
    errors.minimumBaseFare = "Enter a GBP amount from £0.00 to £999,999.99 with up to 2 decimal places.";
  }
  if (Object.keys(errors).length === 0 && minimumBaseFare !== null) {
    values.name = name;
    values.poiId = poiId;
    values.minimumBaseFare = minimumBaseFare;
  }

  return { values, errors };
}

function parseFixedFareEndpoint(
  body: Record<string, unknown>,
  prefix: "origin" | "destination",
  pois: AirportFeeRecord[],
  errors: Record<string, string>
): FixedFareEndpoint | null {
  const type = submittedValue(body, `${prefix}Type`).trim();
  if (type === "poi") {
    const poiId = submittedValue(body, `${prefix}PoiId`).trim();
    const poi = pois.find((item) => item.id === poiId);
    if (!poiId || !poi) {
      errors[`${prefix}PoiId`] = "Select an active managed airport or point of interest.";
      return null;
    }
    return { type: "poi", poiId };
  }
  if (type === "postcode") {
    const scope = submittedValue(body, `${prefix}PostcodeScope`).trim();
    if (scope !== "full" && scope !== "outward") {
      errors[`${prefix}PostcodeScope`] = "Choose whether this is a full postcode or outward code.";
      return null;
    }
    const postcode = normalizeUkPostcode(submittedValue(body, `${prefix}Postcode`), scope);
    if (!postcode) {
      errors[`${prefix}Postcode`] = scope === "full"
        ? "Enter a valid UK full postcode."
        : "Enter a valid UK outward postcode code.";
      return null;
    }
    return { type: "postcode", postcode, scope };
  }
  errors[`${prefix}Type`] = "Choose a managed point of interest or a postcode criterion.";
  return null;
}

export function fixedFareRuleToForm(rule: FixedFareRule): FixedFareRuleFormValues {
  return {
    name: rule.name,
    originType: rule.origin.type,
    originPoiId: rule.origin.type === "poi" ? rule.origin.poiId : "",
    originPostcode: rule.origin.type === "postcode" ? rule.origin.postcode : "",
    originPostcodeScope: rule.origin.type === "postcode" ? rule.origin.scope : "",
    destinationType: rule.destination.type,
    destinationPoiId: rule.destination.type === "poi" ? rule.destination.poiId : "",
    destinationPostcode: rule.destination.type === "postcode" ? rule.destination.postcode : "",
    destinationPostcodeScope: rule.destination.type === "postcode" ? rule.destination.scope : "",
    baseFare: rule.baseFare
  };
}

export function validateFixedFareRuleForm(
  submitted: unknown,
  pois: AirportFeeRecord[]
): { values: FixedFareRuleFormValues; rule: Omit<FixedFareRule, "id"> | null; errors: Record<string, string> } {
  const body = submitted && typeof submitted === "object"
    ? submitted as Record<string, unknown>
    : {};
  const values: FixedFareRuleFormValues = {
    name: submittedValue(body, "name"),
    originType: submittedValue(body, "originType"),
    originPoiId: submittedValue(body, "originPoiId"),
    originPostcode: submittedValue(body, "originPostcode"),
    originPostcodeScope: submittedValue(body, "originPostcodeScope"),
    destinationType: submittedValue(body, "destinationType"),
    destinationPoiId: submittedValue(body, "destinationPoiId"),
    destinationPostcode: submittedValue(body, "destinationPostcode"),
    destinationPostcodeScope: submittedValue(body, "destinationPostcodeScope"),
    baseFare: submittedValue(body, "baseFare")
  };
  const errors: Record<string, string> = {};
  const name = values.name.trim();
  if (!name || name.length > 160) {
    errors.name = "Enter a rule name no longer than 160 characters.";
  }

  const origin = parseFixedFareEndpoint(body, "origin", pois, errors);
  const destination = parseFixedFareEndpoint(body, "destination", pois, errors);
  if (origin && destination &&
      origin.type === destination.type &&
      (origin.type === "poi" && destination.type === "poi"
        ? origin.poiId === destination.poiId
        : origin.type === "postcode" && destination.type === "postcode" &&
          origin.postcode === destination.postcode && origin.scope === destination.scope)) {
    errors.destinationType = "Origin and destination must identify different locations.";
  }

  const baseFare = normalizeMoney(values.baseFare.trim());
  if (baseFare === null) {
    errors.baseFare = "Enter a GBP amount from £0.00 to £999,999.99 with up to 2 decimal places.";
  }

  if (Object.keys(errors).length || !origin || !destination || baseFare === null) {
    return { values, rule: null, errors };
  }
  values.name = name;
  values.baseFare = baseFare;
  return {
    values: { ...values, name, baseFare },
    rule: { name, origin, destination, baseFare },
    errors
  };
}

export type FareRuleJourneyEndpoint = {
  poiId?: string;
};

export function matchesMinimumFareRule(
  rule: MinimumFareRule,
  origin: FareRuleJourneyEndpoint,
  destination: FareRuleJourneyEndpoint,
  poi: AirportFeeRecord
): boolean {
  return poi.id === rule.poiId &&
    (origin.poiId === rule.poiId || destination.poiId === rule.poiId);
}

function compareDecimals(left: DecimalValue, right: DecimalValue): number {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function equalDecimals(left: DecimalValue, right: DecimalValue): boolean {
  return compareDecimals(left, right) === 0;
}

function slabRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map((row) => row && typeof row === "object" && !Array.isArray(row)
      ? row as Record<string, unknown>
      : {});
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, row]) => row && typeof row === "object" && !Array.isArray(row)
        ? row as Record<string, unknown>
        : {});
  }
  return [];
}

export type DistanceSlabFormValidation = {
  distanceSlabs: DistanceSlab[];
  errors: Record<string, string>;
};

export function validateDeadMileageRadius(submitted: unknown): {
  freeRadiusMiles: string;
  errors: Record<string, string>;
} {
  const body = submitted && typeof submitted === "object"
    ? submitted as Record<string, unknown>
    : {};
  const freeRadiusMiles = typeof body.freeRadiusMiles === "string" ? body.freeRadiusMiles.trim() : "";
  const radius = parseNonNegativeDecimal(freeRadiusMiles);
  const maximumRadiusMiles = MAX_DEAD_MILEAGE_RADIUS_MILES;
  const errors: Record<string, string> = {};
  if (!radius || radius.coefficient === 0n ||
      compareDecimals(radius, parseNonNegativeDecimal(maximumRadiusMiles.toFixed(6))!) > 0) {
    errors.freeRadiusMiles = `Enter a radius greater than 0 and no greater than ${maximumRadiusMiles.toFixed(3)} miles.`;
  }
  return { freeRadiusMiles, errors };
}

export function validateDistanceSlabsForm(submitted: unknown): DistanceSlabFormValidation {
  const body = submitted && typeof submitted === "object"
    ? submitted as Record<string, unknown>
    : {};
  const rows = slabRows(body.distanceSlabs);
  const distanceSlabs: DistanceSlab[] = rows.map((row) => ({
    startMiles: typeof row.startMiles === "string" ? row.startMiles.trim() : "",
    endMiles: typeof row.endMiles === "string" ? row.endMiles.trim() : "",
    ratePerMile: typeof row.ratePerMile === "string" ? row.ratePerMile.trim() : ""
  }));
  const errors: Record<string, string> = {};

  if (distanceSlabs.length === 0) {
    errors["distanceSlabs.0.startMiles"] = "Add at least one distance slab.";
    errors["distanceSlabs.0.endMiles"] = "The final slab must be open-ended.";
    errors["distanceSlabs.0.ratePerMile"] = "Enter a valid non-negative rate.";
    return { distanceSlabs, errors };
  }

  const starts = distanceSlabs.map((slab, index) => {
    const parsed = parseNonNegativeDecimal(slab.startMiles);
    if (!parsed) errors[`distanceSlabs.${index}.startMiles`] = "Enter a valid non-negative distance in miles.";
    return parsed;
  });
  const ends = distanceSlabs.map((slab, index) => {
    if (index === distanceSlabs.length - 1) {
      if (slab.endMiles !== "") {
        errors[`distanceSlabs.${index}.endMiles`] = "The final slab must be open-ended; leave its end distance blank.";
      }
      return null;
    }
    const parsed = parseNonNegativeDecimal(slab.endMiles);
    if (!parsed) errors[`distanceSlabs.${index}.endMiles`] = "Enter a valid non-negative end distance.";
    return parsed;
  });
  distanceSlabs.forEach((slab, index) => {
    const parsed = parseNonNegativeDecimal(slab.ratePerMile);
    if (!parsed) errors[`distanceSlabs.${index}.ratePerMile`] = "Enter a valid non-negative rate in GBP per mile.";
  });

  if (starts[0] && starts[0].coefficient !== 0n) {
    errors["distanceSlabs.0.startMiles"] = "The first slab must start at 0 miles.";
  }
  distanceSlabs.forEach((_slab, index) => {
    const start = starts[index];
    const end = ends[index];
    if (start && end && compareDecimals(end, start) <= 0) {
      errors[`distanceSlabs.${index}.endMiles`] = "The end distance must be greater than the start distance.";
    }
    if (index > 0) {
      const previousEnd = ends[index - 1];
      if (previousEnd && start && !equalDecimals(previousEnd, start)) {
        errors[`distanceSlabs.${index}.startMiles`] = compareDecimals(start, previousEnd) < 0
          ? "This slab overlaps the previous slab; start at the previous end distance."
          : "There is a gap after the previous slab; start at the previous end distance.";
      }
    }
  });

  return { distanceSlabs, errors };
}

export function additionalSlabTargetKey(target: AdditionalSlabTarget): string {
  return `${target.type}:${target.id}`;
}

export function parseAdditionalSlabTargetKey(value: string): AdditionalSlabTarget | null {
  const match = /^(airport|poi):(.+)$/.exec(value.trim());
  return match ? { type: match[1] as AdditionalSlabTargetType, id: match[2] } : null;
}

/**
 * Returns the saved additional distance slab sets. When only legacy airport-specific sets exist, each
 * legacy set is split into one set per airport (same name and an independent copy of its slabs) so every
 * set links exactly one airport. The first airport keeps the legacy set ID; later airports get a stable,
 * derived ID so edit links remain valid before the migrated data is first saved.
 */
export function resolveAdditionalDistanceSlabSets(configuration: FareSettingsConfiguration): AdditionalDistanceSlabSet[] {
  if (Array.isArray(configuration.additionalDistanceSlabSets)) {
    return configuration.additionalDistanceSlabSets;
  }
  return (configuration.airportDistanceSlabSets ?? []).flatMap((set) => {
    const airportIds = set.airportIds.length ? set.airportIds : [""];
    return airportIds.map((airportId, index) => ({
      id: index === 0 ? set.id : `${set.id}--${airportId}`,
      name: set.name,
      target: { type: "airport" as const, id: airportId },
      distanceSlabs: set.distanceSlabs.map((slab) => ({ ...slab }))
    }));
  });
}

/** Returns a configuration that stores additional sets under the current key and drops the legacy key. */
export function withAdditionalDistanceSlabSets(
  configuration: FareSettingsConfiguration,
  sets: AdditionalDistanceSlabSet[]
): FareSettingsConfiguration {
  const { airportDistanceSlabSets: _legacy, ...rest } = configuration;
  return { ...rest, additionalDistanceSlabSets: sets };
}

export type AdditionalDistanceSlabSetValidation = {
  values: AdditionalDistanceSlabSetFormValues;
  target: AdditionalSlabTarget | null;
  errors: Record<string, string>;
};

/**
 * Each set links exactly one managed airport or POI by internal RideMatrix ID, and each target may be
 * linked to at most one set. Slab rules are identical to the base Distance Slabs validation.
 */
export function validateAdditionalDistanceSlabSetForm(
  submitted: unknown,
  targets: ManagedSlabTarget[],
  existingSets: AdditionalDistanceSlabSet[],
  editingId = ""
): AdditionalDistanceSlabSetValidation {
  const body = submitted && typeof submitted === "object" ? submitted as Record<string, unknown> : {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const targetKey = typeof body.targetKey === "string" ? body.targetKey.trim() : "";
  const slabValidation = validateDistanceSlabsForm({ distanceSlabs: body.distanceSlabs });
  const errors: Record<string, string> = { ...slabValidation.errors };

  if (!name || name.length > 160) errors.name = "Enter a set name no longer than 160 characters.";

  let target: AdditionalSlabTarget | null = null;
  if (!targetKey) {
    errors.targetKey = "Select the POI or place to link this set to.";
  } else {
    const parsed = parseAdditionalSlabTargetKey(targetKey);
    const managed = parsed && targets.find((item) => item.type === parsed.type && item.id === parsed.id);
    if (!parsed || !managed) {
      errors.targetKey = "The selected airport or POI is missing or no longer available. Select an active managed airport or POI; no other location is substituted.";
    } else {
      const conflict = existingSets.find((set) =>
        set.id !== editingId && set.target.type === managed.type && set.target.id === managed.id);
      if (conflict) {
        errors.targetKey = `${managed.displayName} is already linked to the additional distance slab set "${conflict.name}". Each airport or POI can be linked to only one set.`;
      } else {
        target = { type: managed.type, id: managed.id };
      }
    }
  }

  return {
    values: { name, targetKey, distanceSlabs: slabValidation.distanceSlabs },
    target: Object.keys(errors).length ? null : target,
    errors
  };
}

export const MAX_LOCATION_DISCOUNT_POSTCODES = 500;

const locationDiscountDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function validCalendarDate(value: string): boolean {
  const match = locationDiscountDatePattern.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeDiscountPercentage(value: string): string | null {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value)) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 100) return null;
  return String(numeric);
}

/** Outward code of a normalized full postcode ("BH1 4RS" → "BH1"). */
function outwardCodeOf(fullPostcode: string): string {
  return fullPostcode.slice(0, fullPostcode.indexOf(" "));
}

function datePeriodsOverlap(
  left: Pick<LocationDiscountRule, "startDate" | "endDate">,
  right: Pick<LocationDiscountRule, "startDate" | "endDate">
): boolean {
  return (!left.startDate || !right.endDate || left.startDate <= right.endDate) &&
    (!right.startDate || !left.endDate || right.startDate <= left.endDate);
}

function describeValidity(rule: Pick<LocationDiscountRule, "startDate" | "endDate">): string {
  if (!rule.startDate && !rule.endDate) return "with no date limits";
  if (rule.startDate && rule.endDate) return `valid ${rule.startDate} to ${rule.endDate}`;
  return rule.startDate ? `valid from ${rule.startDate}` : `valid until ${rule.endDate}`;
}

export function locationDiscountRuleToForm(rule: LocationDiscountRule): LocationDiscountFormValues {
  return {
    name: rule.name,
    locationKey: rule.location.id ? additionalSlabTargetKey(rule.location) : "",
    postcodePrecision: rule.postcodePrecision,
    postcodes: rule.postcodes.join("\n"),
    discountPercentage: rule.discountPercentage,
    startDate: rule.startDate,
    endDate: rule.endDate,
    enabled: rule.enabled ? "yes" : "no"
  };
}

/**
 * Finds the first conflict between a candidate rule and other saved rules. Rules conflict when they target
 * the same managed location, their validity periods overlap, and a postcode entry is identical at the same
 * precision or a full postcode falls inside an outward-code entry. Disabled rules are included so that
 * enabling a rule can never create ambiguous (stacked) discounts.
 */
export function findLocationDiscountConflict(
  candidate: Omit<LocationDiscountRule, "id"> & { id?: string },
  rules: LocationDiscountRule[]
): { rule: LocationDiscountRule; postcode: string; conflictingEntry: string } | null {
  for (const rule of rules) {
    if (candidate.id && rule.id === candidate.id) continue;
    if (rule.location.type !== candidate.location.type || rule.location.id !== candidate.location.id) continue;
    if (!datePeriodsOverlap(candidate, rule)) continue;
    const existing = new Set(rule.postcodes);
    for (const postcode of candidate.postcodes) {
      if (candidate.postcodePrecision === rule.postcodePrecision) {
        if (existing.has(postcode)) return { rule, postcode, conflictingEntry: postcode };
      } else if (candidate.postcodePrecision === "full") {
        const outward = outwardCodeOf(postcode);
        if (existing.has(outward)) return { rule, postcode, conflictingEntry: outward };
      } else {
        const covered = rule.postcodes.find((full) => outwardCodeOf(full) === postcode);
        if (covered) return { rule, postcode, conflictingEntry: covered };
      }
    }
  }
  return null;
}

export type LocationDiscountValidation = {
  values: LocationDiscountFormValues;
  rule: Omit<LocationDiscountRule, "id"> | null;
  errors: Record<string, string>;
};

/**
 * Validates a location-based discount rule. Errors are keyed by form field name. The location must be an
 * active managed airport or POI identified by its internal ID; postcode entries are normalized for the
 * explicitly selected precision and stored without duplicates; overlapping rules are rejected.
 */
export function validateLocationDiscountForm(
  submitted: unknown,
  targets: ManagedSlabTarget[],
  existingRules: LocationDiscountRule[],
  editingId = ""
): LocationDiscountValidation {
  const body = submitted && typeof submitted === "object" ? submitted as Record<string, unknown> : {};
  const values: LocationDiscountFormValues = {
    name: submittedValue(body, "name"),
    locationKey: submittedValue(body, "locationKey"),
    postcodePrecision: submittedValue(body, "postcodePrecision"),
    postcodes: submittedValue(body, "postcodes"),
    discountPercentage: submittedValue(body, "discountPercentage"),
    startDate: submittedValue(body, "startDate"),
    endDate: submittedValue(body, "endDate"),
    enabled: submittedValue(body, "enabled")
  };
  const errors: Record<string, string> = {};

  const name = values.name.trim();
  if (!name || name.length > 160) errors.name = "Enter a rule name or description no longer than 160 characters.";

  let location: AdditionalSlabTarget | null = null;
  const locationKey = values.locationKey.trim();
  const parsedLocation = locationKey ? parseAdditionalSlabTargetKey(locationKey) : null;
  const managed = parsedLocation && targets.find((item) => item.type === parsedLocation.type && item.id === parsedLocation.id);
  if (!locationKey) {
    errors.locationKey = "Select a managed airport or POI.";
  } else if (!parsedLocation || !managed) {
    errors.locationKey = "The selected airport or POI is missing or no longer available. Select an active managed airport or POI; no other location is substituted.";
  } else {
    location = { type: managed.type, id: managed.id };
  }

  const precision = values.postcodePrecision.trim();
  const validPrecision = precision === "full" || precision === "outward";
  if (!validPrecision) errors.postcodePrecision = "Choose whether the entries are full postcodes or outward codes.";

  const entries = values.postcodes.split(/[\n\r,;]+/).map((entry) => entry.trim()).filter(Boolean);
  const postcodes: string[] = [];
  if (values.postcodes.length > 20_000 || entries.length > MAX_LOCATION_DISCOUNT_POSTCODES) {
    errors.postcodes = `Enter no more than ${MAX_LOCATION_DISCOUNT_POSTCODES} postcode entries.`;
  } else if (entries.length === 0) {
    errors.postcodes = "Enter at least one UK postcode entry.";
  } else if (validPrecision) {
    const invalid: string[] = [];
    const duplicates: string[] = [];
    for (const entry of entries) {
      const normalized = normalizeUkPostcode(entry, precision);
      if (!normalized) {
        if (precision === "full" && normalizeUkPostcode(entry, "outward")) {
          invalid.push(`${entry} is an outward code, not a full postcode; choose Outward code precision to match the whole area`);
        } else if (precision === "outward" && normalizeUkPostcode(entry, "full")) {
          invalid.push(`${entry} is a full postcode, not an outward code; choose Full postcode precision for exact postcodes`);
        } else {
          invalid.push(`${entry} is not a valid UK ${precision === "full" ? "full postcode" : "outward code"}`);
        }
      } else if (postcodes.includes(normalized)) {
        if (!duplicates.includes(normalized)) duplicates.push(normalized);
      } else {
        postcodes.push(normalized);
      }
    }
    if (invalid.length) {
      errors.postcodes = `${invalid.slice(0, 5).join("; ")}${invalid.length > 5 ? `; and ${invalid.length - 5} more` : ""}.`;
    } else if (duplicates.length) {
      errors.postcodes = `Remove duplicate postcode entries: ${duplicates.join(", ")}.`;
    }
  }

  const discountPercentage = normalizeDiscountPercentage(values.discountPercentage.trim());
  if (discountPercentage === null) {
    errors.discountPercentage = "Enter a percentage greater than 0 and no more than 100, with up to 2 decimal places.";
  }

  const startDate = values.startDate.trim();
  const endDate = values.endDate.trim();
  if (startDate && !validCalendarDate(startDate)) errors.startDate = "Enter a valid start date or leave it blank.";
  if (endDate && !validCalendarDate(endDate)) errors.endDate = "Enter a valid end date or leave it blank.";
  if (!errors.startDate && !errors.endDate && startDate && endDate && endDate < startDate) {
    errors.endDate = "The end date cannot be before the start date.";
  }

  const enabled = values.enabled.trim();
  if (enabled !== "yes" && enabled !== "no") errors.enabled = "Choose whether this rule is enabled or disabled.";

  if (Object.keys(errors).length || !location || !validPrecision || discountPercentage === null) {
    return { values, rule: null, errors };
  }
  const rule: Omit<LocationDiscountRule, "id"> = {
    name,
    location,
    postcodePrecision: precision,
    postcodes,
    discountPercentage,
    startDate,
    endDate,
    enabled: enabled === "yes",
    discountBasis: "standard-distance-slabs-base-fare"
  };
  const conflict = findLocationDiscountConflict({ ...rule, id: editingId }, existingRules);
  if (conflict) {
    const precisionLabel = conflict.rule.postcodePrecision === "full" ? "full postcode" : "outward code";
    errors.postcodes = `${conflict.postcode} overlaps the ${precisionLabel} entry ${conflict.conflictingEntry} in the rule "${conflict.rule.name}" ` +
      `(${describeValidity(conflict.rule)}${conflict.rule.enabled ? "" : ", currently disabled"}) for the same ${managed!.displayName} location and an overlapping validity period. ` +
      "Location-based discounts cannot be stacked or combined; remove the overlapping entry or change the validity dates.";
    return { values, rule: null, errors };
  }
  return {
    values: { ...values, name, locationKey, postcodePrecision: precision, postcodes: postcodes.join("\n"), discountPercentage, startDate, endDate, enabled },
    rule,
    errors
  };
}

/** A journey endpoint as it would be supplied by future pricing. */
export type LocationDiscountJourneyEndpoint = {
  /** Set only when the endpoint is a selected managed airport/POI record. */
  managedLocation?: AdditionalSlabTarget | null;
  /** Structured postcode from the selected address / Google Places address components; never parsed from text. */
  postcode?: string | null;
};

export type LocationDiscountMatch =
  | {
    status: "matched";
    rule: LocationDiscountRule;
    direction: "postcode-to-location" | "location-to-postcode";
    endpointPostcode: string;
    matchedEntry: string;
    discountPercentage: string;
  }
  | { status: "no-match" }
  | { status: "unresolved"; reason: "missing-postcode" | "invalid-service-date" | "ambiguous-rules"; ruleIds: string[] };

/**
 * Evaluates enabled location-based discount rules for one journey. Not connected to booking prices.
 * A rule matches only when one endpoint is the exact managed location ID and the other endpoint's structured
 * postcode equals a configured entry (full precision) or its outward code equals one (outward precision).
 * If a relevant endpoint has no valid structured full postcode, the result is unresolved rather than guessed.
 * More than one matching rule is reported as unresolved; discounts are never stacked or selected.
 */
export function matchLocationDiscount(
  rules: LocationDiscountRule[],
  origin: LocationDiscountJourneyEndpoint,
  destination: LocationDiscountJourneyEndpoint,
  serviceDate: string
): LocationDiscountMatch {
  const sameLocation = (endpoint: LocationDiscountJourneyEndpoint, rule: LocationDiscountRule) =>
    Boolean(endpoint.managedLocation && rule.location.id &&
      endpoint.managedLocation.type === rule.location.type && endpoint.managedLocation.id === rule.location.id);
  const relevant = rules.filter((rule) => rule.enabled && (sameLocation(origin, rule) || sameLocation(destination, rule)));
  if (!relevant.length) return { status: "no-match" };
  if (!validCalendarDate(serviceDate)) {
    return { status: "unresolved", reason: "invalid-service-date", ruleIds: relevant.map((rule) => rule.id) };
  }
  const active = relevant.filter((rule) =>
    (!rule.startDate || rule.startDate <= serviceDate) && (!rule.endDate || serviceDate <= rule.endDate));

  const matches: Extract<LocationDiscountMatch, { status: "matched" }>[] = [];
  const unresolved: string[] = [];
  for (const rule of active) {
    const pairs: Array<[LocationDiscountJourneyEndpoint, LocationDiscountJourneyEndpoint, "postcode-to-location" | "location-to-postcode"]> = [
      [destination, origin, "postcode-to-location"],
      [origin, destination, "location-to-postcode"]
    ];
    for (const [locationEndpoint, otherEndpoint, direction] of pairs) {
      if (!sameLocation(locationEndpoint, rule)) continue;
      const postcode = typeof otherEndpoint.postcode === "string"
        ? normalizeUkPostcode(otherEndpoint.postcode, "full")
        : null;
      if (!postcode) {
        if (!unresolved.includes(rule.id)) unresolved.push(rule.id);
        continue;
      }
      const candidate = rule.postcodePrecision === "full" ? postcode : outwardCodeOf(postcode);
      if (rule.postcodes.includes(candidate) && !matches.some((match) => match.rule.id === rule.id)) {
        matches.push({ status: "matched", rule, direction, endpointPostcode: postcode, matchedEntry: candidate, discountPercentage: rule.discountPercentage });
      }
    }
  }
  if (unresolved.length) return { status: "unresolved", reason: "missing-postcode", ruleIds: unresolved };
  if (matches.length > 1) return { status: "unresolved", reason: "ambiguous-rules", ruleIds: matches.map((match) => match.rule.id) };
  return matches[0] ?? { status: "no-match" };
}

export function calculateDistanceSlabFare(distanceSlabs: DistanceSlab[], distanceMiles: string): string {
  const distance = parseNonNegativeDecimal(distanceMiles);
  const validation = validateDistanceSlabsForm({ distanceSlabs });
  if (!distance || Object.keys(validation.errors).length > 0) {
    throw new TypeError("A valid distance and contiguous distance-slab schedule are required.");
  }

  const products: DecimalValue[] = [];
  for (const slab of distanceSlabs) {
    const start = parseNonNegativeDecimal(slab.startMiles);
    const end = slab.endMiles === "" ? null : parseNonNegativeDecimal(slab.endMiles);
    const rate = parseNonNegativeDecimal(slab.ratePerMile);
    if (!start || !rate || (slab.endMiles !== "" && !end)) {
      throw new TypeError("A valid distance and contiguous distance-slab schedule are required.");
    }
    if (compareDecimals(distance, start) <= 0) continue;

    const portionEnd = end && compareDecimals(distance, end) < 0 ? distance : end ?? distance;
    const commonScale = Math.max(start.scale, portionEnd.scale);
    const portion = portionEnd.coefficient * 10n ** BigInt(commonScale - portionEnd.scale) -
      start.coefficient * 10n ** BigInt(commonScale - start.scale);
    if (portion <= 0n) continue;
    products.push({
      coefficient: portion * rate.coefficient,
      scale: commonScale + rate.scale
    });
  }

  const totalScale = Math.max(0, ...products.map((product) => product.scale));
  const total = products.reduce(
    (sum, product) => sum + product.coefficient * 10n ** BigInt(totalScale - product.scale),
    0n
  );
  const pennyScale = totalScale - 2;
  const pennies = pennyScale <= 0
    ? total * 10n ** BigInt(-pennyScale)
    : (() => {
      const divisor = 10n ** BigInt(pennyScale);
      const quotient = total / divisor;
      return total % divisor * 2n >= divisor ? quotient + 1n : quotient;
    })();
  return `${pennies / 100n}.${String(pennies % 100n).padStart(2, "0")}`;
}

function validTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validLocalDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return false;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute;
}

function periodRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, row]) => row)
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  }
  return [];
}

export function validateFareSettingsForm(
  submitted: unknown,
  current: FareSettingsConfiguration = EMPTY_FARE_SETTINGS
): FareSettingsValidation {
  const body = submitted && typeof submitted === "object"
    ? submitted as Record<string, unknown>
    : {};
  const errors: Record<string, string> = {};
  const hasDailySettings = Object.prototype.hasOwnProperty.call(body, "dailyEnabled");
  const hasBankHolidaySettings = Object.prototype.hasOwnProperty.call(body, "bankHolidayEnabled");
  const hasPeriods = Object.prototype.hasOwnProperty.call(body, "periods") || body.periodsSubmitted === "yes";
  const dailyEnabled = hasDailySettings
    ? submittedString(body, "dailyEnabled")
    : current.dailySurcharge.enabled ? "yes" : "no";
  const bankHolidayEnabled = hasBankHolidaySettings
    ? submittedString(body, "bankHolidayEnabled")
    : current.bankHolidaySurcharge.enabled ? "yes" : "no";

  if (hasDailySettings && dailyEnabled !== "yes" && dailyEnabled !== "no") {
    errors.dailyEnabled = "Select Yes or No for the daily fare surcharge.";
  }
  if (hasBankHolidaySettings && bankHolidayEnabled !== "yes" && bankHolidayEnabled !== "no") {
    errors.bankHolidayEnabled = "Select Yes or No for the bank holiday fare surcharge.";
  }

  let dailySurcharge: FareSurchargeSettings;
  if (!hasDailySettings) {
    dailySurcharge = { ...current.dailySurcharge };
  } else if (dailyEnabled === "no") {
    dailySurcharge = { ...current.dailySurcharge, enabled: false };
  } else {
    dailySurcharge = {
      enabled: dailyEnabled === "yes",
      percentage: submittedString(body, "dailyPercentage").trim(),
      startTime: submittedString(body, "dailyStartTime").trim(),
      endTime: submittedString(body, "dailyEndTime").trim()
    };
  }

  if (dailySurcharge.enabled) {
    if (!dailySurcharge.percentage || !validPercentage(dailySurcharge.percentage)) {
      errors.dailyPercentage = "Enter a valid non-negative percentage.";
    }
    if (!dailySurcharge.startTime || !validTime(dailySurcharge.startTime)) {
      errors.dailyStartTime = "Enter a valid start time.";
    }
    if (!dailySurcharge.endTime || !validTime(dailySurcharge.endTime)) {
      errors.dailyEndTime = "Enter a valid end time.";
    }
    if (validTime(dailySurcharge.startTime) &&
        validTime(dailySurcharge.endTime) &&
        dailySurcharge.startTime === dailySurcharge.endTime) {
      errors.dailyEndTime = "The end time must differ from the start time.";
    }
  }

  const periods: BankHolidaySurchargePeriod[] = [];
  (hasPeriods ? periodRows(body.periods) : current.bankHolidaySurcharge.periods)
    .filter((row) => !("remove" in row) || row.remove !== "yes")
    .forEach((row) => {
      const index = periods.length;
      const period = {
        label: typeof row.label === "string" ? row.label.trim() : "",
        startDateTime: typeof row.startDateTime === "string" ? row.startDateTime.trim() : "",
        endDateTime: typeof row.endDateTime === "string" ? row.endDateTime.trim() : "",
        percentage: typeof row.percentage === "string" ? row.percentage.trim() : ""
      };
      if (!period.label && !period.startDateTime && !period.endDateTime && !period.percentage) return;

      periods.push(period);
      if (!period.label || period.label.length > 160) {
        errors[`periods.${index}.label`] = "Enter a descriptive label no longer than 160 characters.";
      }
      if (!validLocalDateTime(period.startDateTime)) {
        errors[`periods.${index}.startDateTime`] = "Enter a valid local start date and time.";
      }
      if (!validLocalDateTime(period.endDateTime)) {
        errors[`periods.${index}.endDateTime`] = "Enter a valid local end date and time.";
      }
      if (!period.percentage || !validPercentage(period.percentage)) {
        errors[`periods.${index}.percentage`] = "Enter a valid non-negative percentage.";
      }
      if (validLocalDateTime(period.startDateTime) &&
          validLocalDateTime(period.endDateTime) &&
          period.endDateTime <= period.startDateTime) {
        errors[`periods.${index}.endDateTime`] = "The end date and time must be after the start.";
      }
    });

  const validPeriods = periods
    .filter((period) => validLocalDateTime(period.startDateTime) && validLocalDateTime(period.endDateTime) &&
      period.endDateTime > period.startDateTime)
    .sort((left, right) => left.startDateTime.localeCompare(right.startDateTime));
  for (let index = 1; index < validPeriods.length; index += 1) {
    if (validPeriods[index].startDateTime < validPeriods[index - 1].endDateTime) {
      errors.bankHolidayPeriods = "Bank holiday surcharge periods cannot overlap. Adjust the dates and times before saving.";
      break;
    }
  }

  const bankHolidaySurcharge: BankHolidayFareSettings = {
    enabled: bankHolidayEnabled === "yes",
    periods
  };
  if (bankHolidaySurcharge.enabled && periods.length === 0) {
    errors.bankHolidayPeriods = "Add at least one bank holiday surcharge period before enabling this setting.";
  }

  return {
    configuration: {
      timezone: "Europe/London",
      matchingBasis: "scheduled-service-time",
      interval: "start-inclusive-end-exclusive",
      precedence: "bank-holiday-over-daily",
      distanceSlabs: current.distanceSlabs ?? [],
      ...(current.airportDistanceSlabSets ? { airportDistanceSlabSets: current.airportDistanceSlabSets } : {}),
      ...(current.additionalDistanceSlabSets ? { additionalDistanceSlabSets: current.additionalDistanceSlabSets } : {}),
      deadMileage: current.deadMileage ?? { freeRadiusMiles: "" },
      minimumFareRules: current.minimumFareRules ?? [],
      fixedFares: current.fixedFares ?? [],
      ...(current.locationDiscounts ? { locationDiscounts: current.locationDiscounts } : {}),
      dailySurcharge,
      bankHolidaySurcharge
    },
    errors
  };
}

export const fareSettingsStore: FareSettingsStore = {
  async load() {
    const result = await query<FareSettingsSnapshotRow>(
      `SELECT state.configuration, state.version,
              COALESCE(
                (SELECT json_agg(
                    json_build_object(
                      'version', history.version,
                      'actorEmail', history.actor_email,
                      'createdAt', history.occurred_at
                    ) ORDER BY history.version DESC
                  )
                   FROM fare_settings_history AS history),
                '[]'::json
              ) AS history
         FROM fare_settings_current AS state
        WHERE state.id = 1`
    );
    const row = result.rows[0];
    if (!row) throw new Error("Fare settings configuration is missing.");
    return {
      configuration: row.configuration,
      currentVersion: row.version,
      history: row.history.map((item) => ({
        version: item.version,
        actorEmail: item.actorEmail,
        createdAt: new Date(item.createdAt).toISOString()
      }))
    };
  },

  async save(expectedVersion, configuration, actor) {
    await withTransaction(async (client) => {
      const current = await client.query<FareSettingsRow>(
        `SELECT configuration, version
           FROM fare_settings_current
          WHERE id = 1
          FOR UPDATE`
      );
      const latest = current.rows[0];
      if (!latest || latest.version !== expectedVersion) {
        throw new FareSettingsVersionConflictError();
      }

      const nextVersion = latest.version + 1;
      await client.query(
        `UPDATE fare_settings_current
            SET configuration = $1::jsonb, version = $2, updated_by_account_id = $3,
                updated_by_email = $4, updated_at = CURRENT_TIMESTAMP
          WHERE id = 1`,
        [JSON.stringify(configuration), nextVersion, actor.accountId, actor.email]
      );
      await client.query(
        `INSERT INTO fare_settings_history
          (id, version, configuration, actor_account_id, actor_email)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [randomUUID(), nextVersion, JSON.stringify(configuration), actor.accountId, actor.email]
      );
    });
  }
};
