import type { AirportFeeRecord } from "./airport-fees";
import { formatAirportPickupTimingRule } from "./airport-fees";
import type { BookingRoute } from "./booking-routing";
import type { OperationalBase } from "./dead-mileage";
import { resolveJourneyLocationDiscount, type JourneyEndpoint } from "./fare-calculation";
import {
  calculateDistanceSlabFare,
  normalizeUkPostcode,
  validateDistanceSlabsForm,
  type FareSettingsConfiguration,
  type FixedFareEndpoint
} from "./fare-settings";
import type { PoiFeeRecord, PoiRecord } from "./poi-management";

export type BookingLocationKind = "airport" | "poi" | "address";

/** A structured journey stop. Matching always uses kind + managedId; the label is display-only. */
export type BookingStop = {
  kind: BookingLocationKind;
  managedId: string | null;
  placeId: string | null;
  label: string;
  /** Null only for a free-text address whose place could not be verified. */
  latitude: number | null;
  longitude: number | null;
  coordinatesVerified: boolean;
  /** Structured postcode (normalized "BH1 4RS"), or null when the source did not provide one. */
  postcode: string | null;
};

export type BookingStops = { pickup: BookingStop; vias: BookingStop[]; dropoff: BookingStop };

export type PriceLineStatus = "applied" | "zero" | "not-applicable" | "unresolved";

export type PriceLineType =
  | "ride-fare"
  | "location-discount"
  | "airport-pickup-fee"
  | "airport-dropoff-fee"
  | "poi-fee"
  | "toll"
  | "road-charge"
  | "parking"
  | "extra-waiting"
  | "time-surcharge"
  | "fixed-fare"
  | "dead-mileage";

export type PriceLine = {
  type: PriceLineType;
  label: string;
  status: PriceLineStatus;
  /** Two-decimal GBP amount (discounts negative) for applied/zero lines; null otherwise. */
  amount: string | null;
  basis: string;
  source: Record<string, unknown>;
};

export type BookingPricingInputs = {
  serviceDate: string;
  serviceTime: string;
  stops: BookingStops;
  /** POI fee IDs (trigger "confirmation") the dispatcher explicitly confirmed. */
  confirmedPoiFeeIds: string[];
};

export type BookingPricingContext = {
  configuration: FareSettingsConfiguration;
  fareSettingsVersion: number;
  airports: AirportFeeRecord[];
  pois: PoiRecord[];
  poiFees: PoiFeeRecord[];
  operationalBase: OperationalBase | null;
  route: BookingRoute;
};

export type BookingPrice = {
  status: "complete" | "incomplete";
  /** Sum of applied/zero lines; null whenever any line is unresolved. */
  total: string | null;
  lines: PriceLine[];
  unresolvedCount: number;
  fareSettingsVersion: number;
};

function toPennies(amount: string): bigint | null {
  const match = /^(-?)(\d{1,9})\.(\d{2})$/.exec(amount);
  if (!match) return null;
  const value = BigInt(match[2]) * 100n + BigInt(match[3]);
  return match[1] ? -value : value;
}

export function formatPennies(pennies: bigint): string {
  const sign = pennies < 0n ? "-" : "";
  const absolute = pennies < 0n ? -pennies : pennies;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function percentageOfPennies(pennies: bigint, percentage: string): bigint {
  const [whole, fraction = ""] = percentage.split(".");
  const hundredths = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return (pennies * hundredths + 5_000n) / 10_000n;
}

function money(pennies: bigint): string {
  const value = formatPennies(pennies < 0n ? -pennies : pennies);
  return `${pennies < 0n ? "-" : ""}£${value}`;
}

function feeLine(
  type: PriceLineType,
  label: string,
  amount: string,
  basis: string,
  source: Record<string, unknown>
): PriceLine {
  const pennies = toPennies(amount);
  if (pennies === null || pennies < 0n) {
    return { type, label, status: "unresolved", amount: null, basis: `Configured amount "${amount}" is not a valid GBP amount. ${basis}`, source };
  }
  return { type, label, status: pennies === 0n ? "zero" : "applied", amount: formatPennies(pennies), basis, source };
}

function endpoint(stop: BookingStop): JourneyEndpoint {
  return {
    managedLocation: stop.kind === "address" || !stop.managedId ? null : { type: stop.kind, id: stop.managedId },
    postcode: stop.postcode,
    coordinates: stop.latitude === null || stop.longitude === null ? null : { latitude: stop.latitude, longitude: stop.longitude }
  };
}

function rideFareLine(inputs: BookingPricingInputs, context: BookingPricingContext): PriceLine {
  const label = "Ride fare";
  const slabs = context.configuration.distanceSlabs ?? [];
  const pickupAirport = inputs.stops.pickup.kind === "airport" ? inputs.stops.pickup.managedId : null;
  const dropoffAirport = inputs.stops.dropoff.kind === "airport" ? inputs.stops.dropoff.managedId : null;
  const activeAirportIds = new Set(context.airports.map((airport) => airport.id));
  const minimumRules = (context.configuration.minimumFareRules ?? []).filter((rule) =>
    activeAirportIds.has(rule.poiId) && (rule.poiId === pickupAirport || rule.poiId === dropoffAirport));
  const source: Record<string, unknown> = {
    fareSettingsVersion: context.fareSettingsVersion,
    distanceSlabs: slabs.map((slab) => ({ ...slab })),
    minimumFareRules: minimumRules.map((rule) => ({ ...rule }))
  };
  if (context.route.status !== "resolved") {
    return { type: "ride-fare", label, status: "unresolved", amount: null, basis: `Route distance unavailable: ${context.route.message}`, source };
  }
  source.distanceMiles = context.route.distanceMiles;
  if (!slabs.length || Object.keys(validateDistanceSlabsForm({ distanceSlabs: slabs }).errors).length) {
    return { type: "ride-fare", label, status: "unresolved", amount: null, basis: "No valid Distance Slabs schedule is configured in Fare Settings.", source };
  }
  let slabFare: string;
  try {
    slabFare = calculateDistanceSlabFare(slabs, context.route.distanceMiles);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { type: "ride-fare", label, status: "unresolved", amount: null, basis: error.message, source };
  }
  source.distanceSlabsFare = slabFare;
  let pennies = toPennies(slabFare)!;
  const parts = [`${Number(context.route.distanceMiles).toFixed(2)} mi on standard Distance Slabs = £${slabFare}`];
  let governing: (typeof minimumRules)[number] | null = null;
  for (const rule of minimumRules) {
    const minimum = toPennies(rule.minimumBaseFare);
    if (minimum === null) {
      return { type: "ride-fare", label, status: "unresolved", amount: null, basis: `Minimum fare rule "${rule.name}" has an invalid amount.`, source };
    }
    if (minimum > pennies) {
      pennies = minimum;
      governing = rule;
    }
  }
  if (governing) {
    parts.push(`minimum fare rule "${governing.name}" (£${governing.minimumBaseFare}) applies`);
  } else if (minimumRules.length) {
    parts.push(`minimum fare ${minimumRules.map((rule) => `"${rule.name}" £${rule.minimumBaseFare}`).join(", ")} not reached`);
  }
  source.minimumFareRuleApplied = governing?.id ?? null;
  return {
    type: "ride-fare",
    label,
    status: pennies === 0n ? "zero" : "applied",
    amount: formatPennies(pennies),
    basis: parts.join("; ") + ".",
    source
  };
}

function discountLine(inputs: BookingPricingInputs, context: BookingPricingContext, ride: PriceLine): PriceLine {
  const resolution = resolveJourneyLocationDiscount({
    postcodeRules: context.configuration.locationDiscounts ?? [],
    radiusRules: context.configuration.radiusLocationDiscounts ?? [],
    origin: endpoint(inputs.stops.pickup),
    destination: endpoint(inputs.stops.dropoff),
    serviceDate: inputs.serviceDate,
    operationalBase: context.operationalBase
  });
  const label = "Location discount";
  if (resolution.status === "unresolved") {
    return { type: "location-discount", label, status: "unresolved", amount: null, basis: resolution.message, source: { ruleIds: resolution.ruleIds, reason: resolution.reason } };
  }
  if (resolution.status === "no-match") {
    const superseded = resolution.precedence.supersededPostcodeRuleIds.length
      ? " A radius rule governs this location and the other endpoint is outside its radius, so postcode rules are not used."
      : "";
    return {
      type: "location-discount",
      label,
      status: "not-applicable",
      amount: null,
      basis: `No active location discount matches this journey.${superseded}`,
      source: { precedence: resolution.precedence }
    };
  }
  const describe = resolution.source === "operational-base-radius"
    ? `Operational-base radius discount "${resolution.rule.name}" (${resolution.discountPercentage}%, within ${resolution.rule.radiusMiles} mi; endpoint ${resolution.endpointDistanceMiles} mi from base)`
    : `Location-based discount "${resolution.rule.name}" (${resolution.discountPercentage}%, postcode ${resolution.endpointPostcode} matched ${resolution.matchedEntry})`;
  const source = {
    source: resolution.source,
    ruleId: resolution.rule.id,
    direction: resolution.direction,
    discountPercentage: resolution.discountPercentage,
    precedence: resolution.precedence,
    ...(resolution.source === "operational-base-radius"
      ? { radiusMiles: resolution.rule.radiusMiles, endpointDistanceMiles: resolution.endpointDistanceMiles, operationalBase: resolution.operationalBase }
      : { endpointPostcode: resolution.endpointPostcode, matchedEntry: resolution.matchedEntry })
  };
  if (ride.status === "unresolved" || ride.amount === null) {
    return { type: "location-discount", label: `${label}: ${resolution.rule.name}`, status: "unresolved", amount: null, basis: `${describe} matches, but the ride fare it applies to is unresolved.`, source };
  }
  const pennies = percentageOfPennies(toPennies(ride.amount)!, resolution.discountPercentage);
  return {
    type: "location-discount",
    label: `${label}: ${resolution.rule.name}`,
    status: pennies === 0n ? "zero" : "applied",
    amount: formatPennies(-pennies),
    basis: `${describe} applied to the ride fare (£${ride.amount}) only; fees are never discounted.`,
    source
  };
}

function airportLines(inputs: BookingPricingInputs, context: BookingPricingContext): PriceLine[] {
  const lines: PriceLine[] = [];
  const entries: Array<["airport-pickup-fee" | "airport-dropoff-fee", BookingStop, string]> = [
    ["airport-pickup-fee", inputs.stops.pickup, "Airport pick-up fee"],
    ["airport-dropoff-fee", inputs.stops.dropoff, "Airport drop-off fee"]
  ];
  for (const [type, stop, label] of entries) {
    if (stop.kind !== "airport" || !stop.managedId) {
      lines.push({ type, label, status: "not-applicable", amount: null, basis: `The ${type === "airport-pickup-fee" ? "pickup" : "drop-off"} is not a managed airport.`, source: {} });
      continue;
    }
    const airport = context.airports.find((record) => record.id === stop.managedId);
    if (!airport) {
      lines.push({ type, label, status: "unresolved", amount: null, basis: "The selected airport has no active Airport Fees record.", source: { airportId: stop.managedId } });
      continue;
    }
    const pickup = type === "airport-pickup-fee";
    const amount = pickup ? airport.pickupFee : airport.dropoffFee;
    const basis = pickup
      ? `Airport Fees record "${airport.displayName}" pick-up fee. ${formatAirportPickupTimingRule(airport)}`
      : `Airport Fees record "${airport.displayName}" drop-off fee.`;
    lines.push(feeLine(type, `${label} — ${airport.displayName}`, amount, basis, {
      airportId: airport.id,
      airportUpdatedAt: airport.updatedAt,
      configuredAmount: amount,
      ...(pickup ? {
        pickupTimeReference: airport.pickupTimeReference,
        pickupDeferredMinutes: airport.pickupDeferredMinutes,
        pickupFeeCoveredMinutes: airport.pickupFeeCoveredMinutes
      } : {})
    }));
  }
  return lines;
}

function poiLines(inputs: BookingPricingInputs, context: BookingPricingContext): PriceLine[] {
  const lines: PriceLine[] = [];
  const ordered = [inputs.stops.pickup, ...inputs.stops.vias, inputs.stops.dropoff];
  const seen = new Set<string>();
  for (const stop of ordered) {
    if (stop.kind !== "poi" || !stop.managedId || seen.has(stop.managedId)) continue;
    seen.add(stop.managedId);
    const poi = context.pois.find((record) => record.id === stop.managedId);
    const name = poi?.displayName ?? stop.label;
    if (!poi) {
      lines.push({ type: "poi-fee", label: `POI fee — ${name}`, status: "unresolved", amount: null, basis: "The selected POI is no longer an active managed POI.", source: { poiId: stop.managedId } });
      continue;
    }
    const fees = context.poiFees.filter((fee) => fee.poiId === poi.id);
    if (!fees.length) {
      lines.push({ type: "poi-fee", label: `POI fee — ${name}`, status: "not-applicable", amount: null, basis: "No POI fee is configured for this POI.", source: { poiId: poi.id } });
      continue;
    }
    for (const fee of fees) {
      const label = `POI fee — ${name}: ${fee.action}`;
      const source = { poiId: poi.id, poiFeeId: fee.id, action: fee.action, trigger: fee.trigger, configuredAmount: fee.amount, feeUpdatedAt: fee.updatedAt };
      const basis = `${fee.feeBasis || "Configured POI fee"} (trigger: ${fee.trigger === "selection" ? "on POI selection" : "on dispatcher confirmation"}).`;
      if (fee.trigger === "confirmation" && !inputs.confirmedPoiFeeIds.includes(fee.id)) {
        lines.push({ type: "poi-fee", label, status: "not-applicable", amount: null, basis: `Not confirmed by the dispatcher. ${basis}`, source });
        continue;
      }
      lines.push(feeLine("poi-fee", label, fee.amount, basis, source));
    }
  }
  return lines;
}

function routeChargeLines(context: BookingPricingContext): PriceLine[] {
  const route = context.route;
  if (route.status !== "resolved") {
    return [
      { type: "toll", label: "Toll charges", status: "unresolved", amount: null, basis: "Route unresolved; tolls cannot be assessed.", source: {} },
      { type: "road-charge", label: "Road / zone charges", status: "unresolved", amount: null, basis: "Route unresolved; ULEZ and Congestion Charge exposure cannot be assessed.", source: {} }
    ];
  }
  const lines: PriceLine[] = [];
  if (route.tollsReported) {
    lines.push({
      type: "toll",
      label: "Toll charges",
      status: "unresolved",
      amount: null,
      basis: "The routing provider reports tolls on this route. No active toll schedule is configured for booking prices, so the amount cannot be calculated.",
      source: { provider: route.provider }
    });
  } else {
    lines.push({ type: "toll", label: "Toll charges", status: "not-applicable", amount: null, basis: "No tolls reported on this route.", source: { provider: route.provider } });
  }
  if (route.zones.length) {
    for (const zone of route.zones) {
      lines.push({
        type: "road-charge",
        label: `Road charge — ${zone.label}`,
        status: "unresolved",
        amount: null,
        basis: "The route enters this charging zone. The London fee schedules are draft/inactive and not approved for booking prices, so the amount cannot be calculated.",
        source: { zone: zone.zone }
      });
    }
  } else {
    lines.push({ type: "road-charge", label: "Road / zone charges", status: "not-applicable", amount: null, basis: "The route does not enter the London ULEZ or Congestion Charge boundaries.", source: {} });
  }
  return lines;
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function surchargeLine(inputs: BookingPricingInputs, context: BookingPricingContext): PriceLine {
  const label = "Time-based fare surcharge";
  const local = `${inputs.serviceDate}T${inputs.serviceTime}`;
  const bankHoliday = context.configuration.bankHolidaySurcharge;
  const period = bankHoliday?.enabled
    ? bankHoliday.periods.find((entry) => entry.startDateTime <= local && local < entry.endDateTime)
    : undefined;
  if (period) {
    return { type: "time-surcharge", label: `${label} — ${period.label}`, status: "unresolved", amount: null, basis: `Bank-holiday surcharge ${period.percentage}% is configured for this service time, but its booking-price basis has not been defined, so it cannot be calculated.`, source: { period } };
  }
  const daily = context.configuration.dailySurcharge;
  if (daily?.enabled && /^\d{2}:\d{2}$/.test(daily.startTime) && /^\d{2}:\d{2}$/.test(daily.endTime)) {
    const start = minutesOf(daily.startTime);
    const end = minutesOf(daily.endTime);
    const at = minutesOf(inputs.serviceTime);
    const within = start <= end ? at >= start && at < end : at >= start || at < end;
    if (within) {
      return { type: "time-surcharge", label: `${label} — daily ${daily.startTime}–${daily.endTime}`, status: "unresolved", amount: null, basis: `Daily surcharge ${daily.percentage}% is configured for this service time, but its booking-price basis has not been defined, so it cannot be calculated.`, source: { daily } };
    }
  }
  return { type: "time-surcharge", label, status: "not-applicable", amount: null, basis: "No enabled daily or bank-holiday surcharge covers this service time.", source: {} };
}

function fixedEndpointMatches(rule: FixedFareEndpoint, stop: BookingStop): boolean | "unknown" {
  if (rule.type === "poi") return Boolean(stop.managedId) && stop.kind !== "address" && stop.managedId === rule.poiId;
  if (!stop.postcode) return "unknown";
  const full = normalizeUkPostcode(stop.postcode, "full");
  if (!full) return "unknown";
  return rule.scope === "full" ? full === rule.postcode : full.slice(0, full.indexOf(" ")) === rule.postcode;
}

function fixedFareLine(inputs: BookingPricingInputs, context: BookingPricingContext): PriceLine {
  const matches: NonNullable<typeof context.configuration.fixedFares> = [];
  let unknownMatch = false;
  for (const rule of context.configuration.fixedFares ?? []) {
    const originMatches = fixedEndpointMatches(rule.origin, inputs.stops.pickup);
    const destinationMatches = fixedEndpointMatches(rule.destination, inputs.stops.dropoff);
    if (originMatches === false || destinationMatches === false) continue;
    if (originMatches === true && destinationMatches === true) matches.push(rule);
    else unknownMatch = true;
  }
  if (unknownMatch) {
    return {
      type: "fixed-fare",
      label: matches.length ? `Fixed fare rule — ${matches.map((rule) => rule.name).join(", ")}` : "Fixed fare rule — postcode match unknown",
      status: "unresolved",
      amount: null,
      basis: "A configured fixed fare rule may match this journey, but a required endpoint postcode is unavailable, so the fixed fare cannot be ruled out.",
      source: { fixedFareRuleIds: matches.map((rule) => rule.id), postcodeMatchUnknown: true }
    };
  }
  if (!matches.length) {
    return { type: "fixed-fare", label: "Fixed fare rule", status: "not-applicable", amount: null, basis: "No fixed fare rule matches this pickup → drop-off.", source: {} };
  }
  return {
    type: "fixed-fare",
    label: `Fixed fare rule — ${matches.map((rule) => rule.name).join(", ")}`,
    status: "unresolved",
    amount: null,
    basis: "A fixed fare rule matches this journey, but how fixed fares replace Distance Slabs pricing has not been defined; the quote cannot be confirmed.",
    source: { fixedFareRuleIds: matches.map((rule) => rule.id) }
  };
}

/**
 * Prices a booking as separately itemized lines. The ride fare is the standard Distance Slabs fare raised to any
 * minimum fare rule for the exact pickup/drop-off airport ID; at most one location discount is applied to the
 * ride fare only; every fee and charge is its own line. A total is returned only when no line is unresolved.
 */
export function priceBooking(inputs: BookingPricingInputs, context: BookingPricingContext): BookingPrice {
  const ride = rideFareLine(inputs, context);
  const lines: PriceLine[] = [
    ride,
    discountLine(inputs, context, ride),
    ...airportLines(inputs, context),
    ...poiLines(inputs, context),
    ...routeChargeLines(context),
    surchargeLine(inputs, context),
    fixedFareLine(inputs, context),
    {
      type: "dead-mileage",
      label: "Dead mileage",
      status: "not-applicable",
      amount: null,
      basis: "Dispatch-from-base and return-to-base flags are recorded on the assignment screen after saving; dead mileage is not part of this quote.",
      source: {}
    }
  ];
  const unresolvedCount = lines.filter((line) => line.status === "unresolved").length;
  const total = unresolvedCount
    ? null
    : formatPennies(lines.reduce((sum, line) => sum + (line.amount === null ? 0n : toPennies(line.amount)!), 0n));
  if (total !== null && toPennies(total)! < 0n) {
    throw new Error("Booking total cannot be negative.");
  }
  return { status: unresolvedCount ? "incomplete" : "complete", total, lines, unresolvedCount, fareSettingsVersion: context.fareSettingsVersion };
}

export function describeMoney(amount: string | null): string {
  if (amount === null) return "—";
  return money(toPennies(amount) ?? 0n);
}
