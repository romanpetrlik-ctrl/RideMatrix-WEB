import {
  EARTH_RADIUS_MILES,
  isOperationalBaseVerified,
  validPoint,
  type GeoPoint,
  type OperationalBase
} from "./dead-mileage";
import {
  calculateDistanceSlabFare,
  matchLocationDiscount,
  validCalendarDate,
  validateDistanceSlabsForm,
  type AdditionalSlabTarget,
  type DistanceSlab,
  type FareSettingsConfiguration,
  type LocationDiscountJourneyEndpoint,
  type LocationDiscountRule,
  type RadiusLocationDiscountRule
} from "./fare-settings";

/**
 * Floating-point allowance when comparing a geodesic distance with a radius (about 1.6 micrometres). It only
 * absorbs rounding error so that a point exactly on the boundary is reliably included.
 */
export const RADIUS_BOUNDARY_TOLERANCE_MILES = 1e-9;

/** A journey endpoint from structured booking/location data; display labels are never used for matching. */
export type JourneyEndpoint = LocationDiscountJourneyEndpoint & {
  /** Structured coordinates of the selected address/place; never geocoded from text or a postcode centroid. */
  coordinates?: GeoPoint | null;
};

/** Straight-line great-circle (haversine) distance in miles, using the dead-mileage Earth-radius convention. */
export function geodesicDistanceMiles(from: GeoPoint, to: GeoPoint): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function roundedMiles(value: number): string {
  return (Math.round(value * 1_000_000) / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0";
}

function validCoordinates(point: GeoPoint | null | undefined): point is GeoPoint {
  return Boolean(point) && typeof point!.latitude === "number" && typeof point!.longitude === "number" && validPoint(point!);
}

function sameLocation(endpoint: JourneyEndpoint, location: AdditionalSlabTarget): boolean {
  return Boolean(endpoint.managedLocation && location.id &&
    endpoint.managedLocation.type === location.type && endpoint.managedLocation.id === location.id);
}

function effectiveOn(rule: Pick<RadiusLocationDiscountRule, "startDate" | "endDate">, serviceDate: string): boolean {
  return (!rule.startDate || rule.startDate <= serviceDate) && (!rule.endDate || serviceDate <= rule.endDate);
}

export type OperationalBaseReference = {
  operatorId: string;
  latitude: number;
  longitude: number;
  providerPlaceId: string;
  updatedAt: string;
};

export type DiscountPrecedence = {
  /** Enabled radius rules effective on the service date for a journey endpoint's managed location. */
  governingRadiusRuleIds: string[];
  /** Enabled postcode-scoped rules ignored because a radius rule governs the same managed location. */
  supersededPostcodeRuleIds: string[];
};

export type RadiusDiscountMatch = {
  status: "matched";
  source: "operational-base-radius";
  rule: RadiusLocationDiscountRule;
  direction: "base-area-to-location" | "location-to-base-area";
  discountPercentage: string;
  endpointDistanceMiles: string;
  operationalBase: OperationalBaseReference;
  precedence: DiscountPrecedence;
};

export type PostcodeDiscountMatch = {
  status: "matched";
  source: "postcode";
  rule: LocationDiscountRule;
  direction: "postcode-to-location" | "location-to-postcode";
  discountPercentage: string;
  endpointPostcode: string;
  matchedEntry: string;
  precedence: DiscountPrecedence;
};

export type JourneyDiscountUnresolvedReason =
  | "invalid-service-date"
  | "operational-base-unverified"
  | "missing-endpoint-coordinates"
  | "missing-postcode"
  | "ambiguous-rules";

export type JourneyDiscountResolution =
  | RadiusDiscountMatch
  | PostcodeDiscountMatch
  | { status: "no-match"; precedence: DiscountPrecedence }
  | { status: "unresolved"; reason: JourneyDiscountUnresolvedReason; ruleIds: string[]; message: string };

const unresolvedMessages: Record<JourneyDiscountUnresolvedReason, string> = {
  "invalid-service-date": "The location discount could not be resolved because the service date is missing or invalid.",
  "operational-base-unverified": "The operational-base radius discount could not be resolved because the operational base has no verified coordinates.",
  "missing-endpoint-coordinates": "The operational-base radius discount could not be resolved because the other journey endpoint has missing or invalid coordinates.",
  "missing-postcode": "The location-based discount could not be resolved because the other journey endpoint has no valid structured postcode.",
  "ambiguous-rules": "More than one location discount matches this journey. Discounts are never stacked or chosen automatically; correct the rules."
};

function unresolved(reason: JourneyDiscountUnresolvedReason, ruleIds: string[]): JourneyDiscountResolution {
  return { status: "unresolved", reason, ruleIds, message: unresolvedMessages[reason] };
}

/**
 * Resolves at most one location discount for a journey.
 *
 * - An enabled operational-base radius rule effective on the service date governs its managed location
 *   exclusively: within the radius (boundary inclusive) its discount applies; outside it no discount applies,
 *   and postcode-scoped rules for that same location are ignored rather than used as a fallback.
 * - Postcode-scoped rules for other locations, and for locations without a governing radius rule, are matched
 *   exactly as before by matchLocationDiscount.
 * - Missing/invalid coordinates, an unverified operational base, or more than one matching rule return
 *   "unresolved"; nothing is guessed, combined or stacked.
 */
export function resolveJourneyLocationDiscount(input: {
  postcodeRules: LocationDiscountRule[];
  radiusRules: RadiusLocationDiscountRule[];
  origin: JourneyEndpoint;
  destination: JourneyEndpoint;
  serviceDate: string;
  operationalBase: OperationalBase | null;
}): JourneyDiscountResolution {
  const { origin, destination, serviceDate } = input;
  const relevantRadius = input.radiusRules.filter((rule) =>
    rule.enabled && (sameLocation(origin, rule.location) || sameLocation(destination, rule.location)));
  if (relevantRadius.length && !validCalendarDate(serviceDate)) {
    return unresolved("invalid-service-date", relevantRadius.map((rule) => rule.id));
  }
  const governing = relevantRadius.filter((rule) => effectiveOn(rule, serviceDate));
  const governs = (location: AdditionalSlabTarget) =>
    governing.some((rule) => rule.location.type === location.type && rule.location.id === location.id);
  const precedence: DiscountPrecedence = {
    governingRadiusRuleIds: governing.map((rule) => rule.id),
    supersededPostcodeRuleIds: input.postcodeRules
      .filter((rule) => rule.enabled && governs(rule.location) &&
        (sameLocation(origin, rule.location) || sameLocation(destination, rule.location)))
      .map((rule) => rule.id)
  };

  const ambiguous = governing.filter((rule) => governing.some((other) => other.id !== rule.id &&
    other.location.type === rule.location.type && other.location.id === rule.location.id));
  if (ambiguous.length) return unresolved("ambiguous-rules", ambiguous.map((rule) => rule.id));

  const radiusMatches: RadiusDiscountMatch[] = [];
  if (governing.length) {
    const base = input.operationalBase;
    if (!base || !isOperationalBaseVerified(base)) {
      return unresolved("operational-base-unverified", governing.map((rule) => rule.id));
    }
    const centre = { latitude: base.latitude!, longitude: base.longitude! };
    const operationalBase: OperationalBaseReference = {
      operatorId: base.operatorId,
      latitude: centre.latitude,
      longitude: centre.longitude,
      providerPlaceId: base.providerPlaceId!,
      updatedAt: base.updatedAt!
    };
    const missingCoordinates: string[] = [];
    for (const rule of governing) {
      const radius = Number(rule.radiusMiles);
      const pairs: Array<[JourneyEndpoint, JourneyEndpoint, RadiusDiscountMatch["direction"]]> = [
        [destination, origin, "base-area-to-location"],
        [origin, destination, "location-to-base-area"]
      ];
      for (const [locationEndpoint, otherEndpoint, direction] of pairs) {
        if (!sameLocation(locationEndpoint, rule.location)) continue;
        if (!validCoordinates(otherEndpoint.coordinates) || !Number.isFinite(radius) || radius <= 0) {
          if (!missingCoordinates.includes(rule.id)) missingCoordinates.push(rule.id);
          continue;
        }
        const distance = geodesicDistanceMiles(centre, otherEndpoint.coordinates);
        if (distance <= radius + RADIUS_BOUNDARY_TOLERANCE_MILES && !radiusMatches.some((match) => match.rule.id === rule.id)) {
          radiusMatches.push({
            status: "matched",
            source: "operational-base-radius",
            rule,
            direction,
            discountPercentage: rule.discountPercentage,
            endpointDistanceMiles: roundedMiles(distance),
            operationalBase,
            precedence
          });
        }
      }
    }
    if (missingCoordinates.length) return unresolved("missing-endpoint-coordinates", missingCoordinates);
  }

  const postcode = matchLocationDiscount(
    input.postcodeRules.filter((rule) => !governs(rule.location)),
    origin,
    destination,
    serviceDate
  );
  if (postcode.status === "unresolved") {
    return unresolved(postcode.reason === "invalid-service-date" ? "invalid-service-date"
      : postcode.reason === "ambiguous-rules" ? "ambiguous-rules" : "missing-postcode", postcode.ruleIds);
  }
  const matches: Array<RadiusDiscountMatch | PostcodeDiscountMatch> = [...radiusMatches];
  if (postcode.status === "matched") {
    matches.push({
      status: "matched",
      source: "postcode",
      rule: postcode.rule,
      direction: postcode.direction,
      discountPercentage: postcode.discountPercentage,
      endpointPostcode: postcode.endpointPostcode,
      matchedEntry: postcode.matchedEntry,
      precedence
    });
  }
  if (matches.length > 1) return unresolved("ambiguous-rules", matches.map((match) => match.rule.id));
  return matches[0] ?? { status: "no-match", precedence };
}

export type SeparatelyItemizedChargeType = "airport-fee" | "poi-fee" | "toll" | "road-charge" | "tunnel-charge" | "dead-mileage" | "extra";

/** A charge priced elsewhere and itemized separately; location discounts never change it. */
export type SeparatelyItemizedCharge = {
  type: SeparatelyItemizedChargeType;
  label: string;
  /** Non-negative GBP amount with exactly two decimal places, e.g. "7.50". */
  amount: string;
};

export type AppliedLocationDiscount = {
  source: "operational-base-radius" | "postcode";
  ruleId: string;
  ruleName: string;
  location: AdditionalSlabTarget;
  direction: RadiusDiscountMatch["direction"] | PostcodeDiscountMatch["direction"];
  discountPercentage: string;
  appliesTo: "standard-distance-slabs-base-fare";
  /** Positive GBP amount deducted from the standard base fare. */
  amount: string;
  radius: null | { radiusMiles: string; endpointDistanceMiles: string; operationalBase: OperationalBaseReference };
  postcode: null | { endpointPostcode: string; matchedEntry: string; precision: LocationDiscountRule["postcodePrecision"] };
};

export type FareBreakdownItem =
  | { type: "base-fare"; label: "Base fare (Distance Slabs)"; distanceMiles: string; amount: string }
  | { type: "location-discount"; label: string; source: AppliedLocationDiscount["source"]; ruleId: string; discountPercentage: string; amount: string }
  | { type: SeparatelyItemizedChargeType; label: string; amount: string };

export type JourneyFareSnapshot = {
  fareSettingsVersion: number;
  serviceDate: string;
  distanceMiles: string;
  distanceSlabs: DistanceSlab[];
  standardBaseFare: string;
  discount: AppliedLocationDiscount | null;
  precedence: DiscountPrecedence;
  discountedBaseFare: string;
  separateCharges: SeparatelyItemizedCharge[];
  total: string;
};

export type JourneyFareCalculation =
  | { status: "unresolved"; reasons: string[]; discount: JourneyDiscountResolution | null }
  | {
    status: "calculated";
    standardBaseFare: string;
    discountAmount: string;
    discountedBaseFare: string;
    total: string;
    fareBreakdown: FareBreakdownItem[];
    snapshot: JourneyFareSnapshot;
  };

export type JourneyFareInput = {
  configuration: FareSettingsConfiguration;
  fareSettingsVersion: number;
  /** Passenger journey distance in decimal miles. */
  distanceMiles: string;
  /** Europe/London scheduled service date (YYYY-MM-DD). */
  serviceDate: string;
  origin: JourneyEndpoint;
  destination: JourneyEndpoint;
  operationalBase: OperationalBase | null;
  separateCharges?: SeparatelyItemizedCharge[];
};

function toPennies(amount: string): bigint | null {
  const match = /^(\d{1,9})\.(\d{2})$/.exec(amount);
  return match ? BigInt(match[1]) * 100n + BigInt(match[2]) : null;
}

function formatPennies(pennies: bigint): string {
  return `${pennies / 100n}.${String(pennies % 100n).padStart(2, "0")}`;
}

/** Percentage (up to 2 decimal places) of an amount in pennies, rounded to the nearest penny with halves up. */
function percentageOfPennies(pennies: bigint, percentage: string): bigint {
  const [whole, fraction = ""] = percentage.split(".");
  const hundredths = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return (pennies * hundredths + 5_000n) / 10_000n;
}

/**
 * Calculates a journey's standard base fare from the Distance Slabs, applies at most one location discount to
 * that base fare only, and adds separately itemized charges unchanged. The selected rule and discount amount
 * appear in both the fare breakdown and the price snapshot. Any unresolved discount makes the whole
 * calculation unresolved; no partial price is returned.
 */
export function calculateJourneyFare(input: JourneyFareInput): JourneyFareCalculation {
  const reasons: string[] = [];
  const distanceSlabs = input.configuration.distanceSlabs ?? [];
  if (Object.keys(validateDistanceSlabsForm({ distanceSlabs }).errors).length) {
    reasons.push("A valid Distance Slabs schedule is required to calculate the base fare.");
  }
  if (!/^(?:\d+(?:\.\d+)?)$/.test(input.distanceMiles)) {
    reasons.push("A valid passenger journey distance in miles is required.");
  }
  const separateCharges = input.separateCharges ?? [];
  const chargePennies = separateCharges.map((charge) => toPennies(charge.amount));
  if (chargePennies.some((pennies) => pennies === null)) {
    reasons.push("Every separately itemized charge needs a GBP amount with two decimal places.");
  }

  const discount = resolveJourneyLocationDiscount({
    postcodeRules: input.configuration.locationDiscounts ?? [],
    radiusRules: input.configuration.radiusLocationDiscounts ?? [],
    origin: input.origin,
    destination: input.destination,
    serviceDate: input.serviceDate,
    operationalBase: input.operationalBase
  });
  if (discount.status === "unresolved") reasons.push(discount.message);
  if (reasons.length) return { status: "unresolved", reasons, discount: discount.status === "unresolved" ? discount : null };

  let standardBaseFare: string;
  try {
    standardBaseFare = calculateDistanceSlabFare(distanceSlabs, input.distanceMiles);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { status: "unresolved", reasons: [error.message], discount: null };
  }
  const basePennies = toPennies(standardBaseFare)!;
  let applied: AppliedLocationDiscount | null = null;
  if (discount.status === "matched") {
    const amount = formatPennies(percentageOfPennies(basePennies, discount.discountPercentage));
    applied = {
      source: discount.source,
      ruleId: discount.rule.id,
      ruleName: discount.rule.name,
      location: { ...discount.rule.location },
      direction: discount.direction,
      discountPercentage: discount.discountPercentage,
      appliesTo: "standard-distance-slabs-base-fare",
      amount,
      radius: discount.source === "operational-base-radius"
        ? { radiusMiles: discount.rule.radiusMiles, endpointDistanceMiles: discount.endpointDistanceMiles, operationalBase: discount.operationalBase }
        : null,
      postcode: discount.source === "postcode"
        ? { endpointPostcode: discount.endpointPostcode, matchedEntry: discount.matchedEntry, precision: discount.rule.postcodePrecision }
        : null
    };
  }
  const discountPennies = applied ? toPennies(applied.amount)! : 0n;
  const discountedPennies = basePennies - discountPennies;
  const totalPennies = chargePennies.reduce<bigint>((sum, pennies) => sum + pennies!, discountedPennies);

  const fareBreakdown: FareBreakdownItem[] = [
    { type: "base-fare", label: "Base fare (Distance Slabs)", distanceMiles: input.distanceMiles, amount: standardBaseFare }
  ];
  if (applied) {
    fareBreakdown.push({
      type: "location-discount",
      label: applied.source === "operational-base-radius"
        ? `Operational-base radius discount: ${applied.ruleName} (${applied.discountPercentage}%)`
        : `Location-based discount: ${applied.ruleName} (${applied.discountPercentage}%)`,
      source: applied.source,
      ruleId: applied.ruleId,
      discountPercentage: applied.discountPercentage,
      amount: `-${applied.amount}`
    });
  }
  for (const charge of separateCharges) fareBreakdown.push({ type: charge.type, label: charge.label, amount: charge.amount });

  const precedence = discount.status === "unresolved"
    ? { governingRadiusRuleIds: [], supersededPostcodeRuleIds: [] }
    : discount.precedence;
  return {
    status: "calculated",
    standardBaseFare,
    discountAmount: formatPennies(discountPennies),
    discountedBaseFare: formatPennies(discountedPennies),
    total: formatPennies(totalPennies),
    fareBreakdown,
    snapshot: {
      fareSettingsVersion: input.fareSettingsVersion,
      serviceDate: input.serviceDate,
      distanceMiles: input.distanceMiles,
      distanceSlabs: distanceSlabs.map((slab) => ({ ...slab })),
      standardBaseFare,
      discount: applied,
      precedence,
      discountedBaseFare: formatPennies(discountedPennies),
      separateCharges: separateCharges.map((charge) => ({ ...charge })),
      total: formatPennies(totalPennies)
    }
  };
}
