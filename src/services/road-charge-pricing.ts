import type { PriceLine } from "./booking-pricing";
import type { BookingRoute, ResolvedBookingRoute, RoadChargeZoneDetection, TunnelCrossing } from "./booking-routing";
import {
  codeCalculationBlockers,
  NO_CHARGE,
  ROAD_CHARGE_PROFILE_OPTIONS,
  tunnelRateKey,
  ULEZ_COMPLIANT,
  type DailyZoneSchedule,
  type DailyZoneScheme,
  type RoadChargeProfile,
  type RoadChargeSchedule,
  type RoadChargeScheme,
  type TunnelBand,
  type TunnelSchedule
} from "./road-charge-schedules";

export const ROAD_CHARGE_TIMEZONE = "Europe/London";

/**
 * The route duration is an estimate, so the journey window used to test charging hours/bands is extended by
 * max(15 minutes, 25% of the route duration). A charge is resolved only when the whole window falls in one band.
 */
export const ROUTE_TIMING_BUFFER = { minimumMinutes: 15, proportion: 0.25 } as const;

export type RoadChargeScheduleRecord = {
  scheme: RoadChargeScheme;
  version: number;
  status: string;
  /** Null when the latest stored version is a legacy draft payload that cannot calculate charges. */
  schedule: RoadChargeSchedule | null;
};

export type RoadChargeScheduleSet = Partial<Record<RoadChargeScheme, RoadChargeScheduleRecord>>;

export type RoadChargeLineOptions = {
  /** Test seam only; production always uses codeCalculationBlockers so unverified geometry blocks pricing. */
  codeCalculationBlockers?: (scheme: RoadChargeScheme) => string[];
};

type LocalInstant = { date: string; minute: number };

function londonParts(instant: Date): LocalInstant {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: ROAD_CHARGE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function londonLocalToUtc(date: string, time: string): Date {
  const naive = new Date(`${date}T${time}:00Z`).getTime();
  let guess = naive;
  for (let i = 0; i < 2; i += 1) {
    const local = londonParts(new Date(guess));
    const [hours, minutes] = [Math.floor(local.minute / 60), local.minute % 60];
    const asUtc = new Date(`${local.date}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00Z`).getTime();
    guess = naive - (asUtc - guess);
  }
  return new Date(guess);
}

function nextDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function minutes(time: string): number {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + mins;
}

export type JourneyWindow = {
  startUtc: string;
  endUtc: string;
  start: LocalInstant;
  end: LocalInstant;
  bufferMinutes: number;
  /** Local-date segments [startMinute, endMinute) covered by the window. */
  segments: Array<{ date: string; from: number; to: number }>;
};

/** The service-time window in Europe/London: service start to start + route duration + timing buffer. */
export function journeyWindow(serviceDate: string, serviceTime: string, durationSeconds: number): JourneyWindow {
  const start = londonLocalToUtc(serviceDate, serviceTime);
  const durationMinutes = Math.max(0, durationSeconds) / 60;
  const bufferMinutes = Math.ceil(Math.max(ROUTE_TIMING_BUFFER.minimumMinutes, durationMinutes * ROUTE_TIMING_BUFFER.proportion));
  const end = new Date(start.getTime() + Math.ceil(durationMinutes + bufferMinutes) * 60_000);
  const startLocal = londonParts(start);
  const endLocal = londonParts(end);
  const segments: JourneyWindow["segments"] = [];
  for (let date = startLocal.date; date <= endLocal.date; date = nextDate(date)) {
    const from = date === startLocal.date ? startLocal.minute : 0;
    const to = date === endLocal.date ? endLocal.minute : 1440;
    if (to > from) segments.push({ date, from, to });
  }
  return { startUtc: start.toISOString(), endUtc: end.toISOString(), start: startLocal, end: endLocal, bufferMinutes, segments };
}

function windowSource(window: JourneyWindow) {
  const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return {
    timezone: ROAD_CHARGE_TIMEZONE,
    from: `${window.start.date} ${time(window.start.minute)}`,
    to: `${window.end.date} ${time(window.end.minute)}`,
    bufferMinutes: window.bufferMinutes
  };
}

function scheduleSource(record: RoadChargeScheduleRecord | undefined) {
  if (!record) return null;
  const schedule = record.schedule;
  return {
    scheme: record.scheme,
    version: record.version,
    status: record.status,
    effectiveFrom: schedule?.effectiveFrom ?? null,
    effectiveUntil: schedule?.effectiveUntil ?? null,
    verifiedOn: schedule?.verification?.verifiedOn ?? null,
    verifiedBy: schedule?.verification?.verifiedByEmail ?? null
  };
}

function inEffectivePeriod(schedule: RoadChargeSchedule, date: string): boolean {
  return schedule.effectiveFrom !== null && date >= schedule.effectiveFrom
    && (schedule.effectiveUntil === null || date <= schedule.effectiveUntil);
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" })
    .format(new Date(`${date}T00:00:00Z`));
}

function optionLabel(key: keyof RoadChargeProfile, value: string): string {
  return ROAD_CHARGE_PROFILE_OPTIONS[key].options.find((option) => option.value === value)?.label ?? value;
}

/** Reason the stored schedule cannot be used for this quote, or null when it is active and calculable. */
function scheduleUnavailable(record: RoadChargeScheduleRecord | undefined, title: string, options: RoadChargeLineOptions): string | null {
  if (!record) return `No ${title} fee schedule is configured.`;
  if (!record.schedule) return `The ${title} fee schedule (version ${record.version}) is a legacy draft and is not used for booking prices.`;
  if (record.status !== "active" || !record.schedule.active || record.schedule.bookingPriceUsage !== "new-booking-quotes") {
    return `The ${title} fee schedule (version ${record.version}) is not active for booking prices.`;
  }
  const blockers = [...record.schedule.calculationBlockers, ...(options.codeCalculationBlockers ?? codeCalculationBlockers)(record.scheme)];
  if (blockers.length) return `The ${title} fee schedule cannot be used: ${blockers.join(" ")}`;
  return null;
}

const ZONE_TITLES: Record<DailyZoneScheme, string> = {
  "london-lez": "London LEZ",
  "london-ulez": "London ULEZ",
  "london-congestion-charge": "London Congestion Charge"
};

const ZONE_PROFILE_KEY: Record<DailyZoneScheme, "lez" | "ulez" | "congestionCharge"> = {
  "london-lez": "lez",
  "london-ulez": "ulez",
  "london-congestion-charge": "congestionCharge"
};

type DayIntervals = { intervals: Array<[number, number]> } | { unresolved: string };

function dailyIntervals(schedule: DailyZoneSchedule, date: string): DayIntervals {
  const rules = schedule.rules;
  if (rules.noChargeAnnualDates.includes(date.slice(5))) return { intervals: [] };
  if (rules.noChargeDateRanges.some((range) => date >= range.from && date <= range.to)) return { intervals: [] };
  if (!rules.chargingHours) return { intervals: [[0, 1440]] };
  const coverage = rules.calendarCoverage;
  if (!coverage || !rules.bankHolidays || date < coverage.from || date > coverage.to) {
    return { unresolved: `Charging hours on ${formatDate(date)} depend on the bank-holiday calendar, which is only recorded for ${coverage ? `${coverage.from} to ${coverage.to}` : "no dates"}.` };
  }
  const day = weekday(date);
  const range = day === 0 || day === 6 || rules.bankHolidays.includes(date)
    ? rules.chargingHours.weekendsAndBankHolidays
    : rules.chargingHours.weekdays;
  return { intervals: [[minutes(range.start), minutes(range.end)]] };
}

type ZoneOutcome =
  | { kind: "charge"; date: string }
  | { kind: "none"; reason: string }
  | { kind: "unresolved"; reason: string };

/** One charging day is resolved only if the whole journey window lies inside one charging interval. */
function zoneChargingDay(schedule: DailyZoneSchedule, window: JourneyWindow): ZoneOutcome {
  for (const segment of window.segments) {
    if (!inEffectivePeriod(schedule, segment.date)) {
      return { kind: "unresolved", reason: `${formatDate(segment.date)} is outside the schedule's effective period (${schedule.effectiveFrom ?? "unknown"} to ${schedule.effectiveUntil ?? "open-ended"}).` };
    }
  }
  const overlapping: string[] = [];
  let contained: string | null = null;
  for (const segment of window.segments) {
    const day = dailyIntervals(schedule, segment.date);
    if ("unresolved" in day) return { kind: "unresolved", reason: day.unresolved };
    for (const [from, to] of day.intervals) {
      if (segment.from < to && from < segment.to) {
        overlapping.push(segment.date);
        if (window.segments.length === 1 && from <= segment.from && segment.to <= to) contained = segment.date;
      }
    }
  }
  if (!overlapping.length) return { kind: "none", reason: "The journey window falls entirely outside charging hours/days." };
  if (contained) return { kind: "charge", date: contained };
  return {
    kind: "unresolved",
    reason: window.segments.length > 1
      ? "The journey window crosses midnight, so whether one or two charging days apply depends on when the vehicle is in the zone."
      : "The journey window crosses the start or end of charging hours, so whether the zone is entered during charging hours cannot be determined."
  };
}

/** Quotes have no assigned vehicle, so vehicle-dependent charges stay unresolved rather than being guessed. */
const NO_VEHICLE_BASIS = "No vehicle is assigned at quote time and RideMatrix does not record this vehicle's LEZ, ULEZ, Congestion Charge, tunnel class or Auto Pay attributes, so the charge cannot be calculated.";

function zoneLine(
  scheme: DailyZoneScheme,
  detection: RoadChargeZoneDetection | null,
  profile: RoadChargeProfile | null,
  record: RoadChargeScheduleRecord | undefined,
  window: JourneyWindow,
  options: RoadChargeLineOptions
): PriceLine {
  const title = ZONE_TITLES[scheme];
  const profileKey = ZONE_PROFILE_KEY[scheme];
  const declared = profile?.[profileKey] ?? "";
  const label = `${title} daily charge`;
  const geometryBlockers = (options.codeCalculationBlockers ?? codeCalculationBlockers)(scheme);
  const source: Record<string, unknown> = {
    scheme,
    schedule: scheduleSource(record),
    matchingBasis: detection ? detection.evidence : { method: "route-polygon-intersection", detected: false, boundaryBlockers: geometryBlockers },
    journeyWindow: windowSource(window),
    vehicleInput: { field: profileKey, value: declared || null, vehicleAssigned: profile !== null }
  };
  const entry = detection ? `The route enters the ${detection.label}.` : `The route was not detected inside the ${title} boundary.`;
  const unresolved = (basis: string): PriceLine => ({ type: "road-charge", label, status: "unresolved", amount: null, basis: `${entry} ${basis}`, source });
  const notApplicable = (basis: string): PriceLine => ({ type: "road-charge", label, status: "not-applicable", amount: null, basis: `${entry} ${basis}`, source });

  if (!profile) return unresolved(NO_VEHICLE_BASIS);
  if (!declared) return unresolved(`The vehicle's ${ROAD_CHARGE_PROFILE_OPTIONS[profileKey].label} is not recorded, so whether and how much it is charged cannot be determined.`);
  if (declared === ULEZ_COMPLIANT && scheme === "london-ulez") {
    source.rate = { key: ULEZ_COMPLIANT, amount: "0.00" };
    const compliance = "The vehicle meets the ULEZ standard (approved default for a standard passenger car, or a recorded compliance), so no daily charge applies";
    return {
      type: "road-charge",
      label: `${title} daily charge — ULEZ-compliant`,
      status: "zero",
      amount: "0.00",
      basis: detection ? `${entry} ${compliance}.` : `${compliance} whether or not the route enters the zone.`,
      source
    };
  }
  if (declared === NO_CHARGE) {
    return notApplicable(`The vehicle is not charged: ${optionLabel(profileKey, declared)}.`);
  }
  if (!detection) {
    if (geometryBlockers.length) return unresolved(`Whether the route enters the ${title} cannot be confirmed: ${geometryBlockers.join(" ")}`);
    return notApplicable(`The route does not enter the ${title} boundary.`);
  }
  const unavailable = scheduleUnavailable(record, title, options);
  if (unavailable) return unresolved(unavailable);
  const schedule = record!.schedule as DailyZoneSchedule;
  const outcome = zoneChargingDay(schedule, window);
  if (outcome.kind === "unresolved") return unresolved(outcome.reason);
  if (outcome.kind === "none") return notApplicable(outcome.reason);
  const rate = schedule.rates.find((item) => item.key === declared);
  if (!rate || !/^\d{1,6}\.\d{2}$/.test(rate.amount) || (Number(rate.amount) === 0 && !rate.allowZero)) {
    return unresolved(`No valid ${title} rate is configured for “${optionLabel(profileKey, declared)}”.`);
  }
  source.rate = { key: rate.key, label: rate.label, amount: rate.amount };
  source.chargingDay = outcome.date;
  return {
    type: "road-charge",
    label: `${title} daily charge — ${formatDate(outcome.date)}`,
    status: Number(rate.amount) === 0 ? "zero" : "applied",
    amount: rate.amount,
    basis: `The route enters the ${detection.label} on charging day ${formatDate(outcome.date)} (${ROAD_CHARGE_TIMEZONE}). ${rate.label}: one daily charge per charging day (schedule version ${record!.version}).`,
    source
  };
}

type BandResult = { band: TunnelBand | "free" } | { unresolved: string };

function tunnelBandAt(schedule: TunnelSchedule, crossing: TunnelCrossing, autoPay: boolean, date: string, minute: number): BandResult {
  const rules = schedule.rules;
  if (!inEffectivePeriod(schedule, date)) {
    return { unresolved: `${formatDate(date)} is outside the schedule's effective period (${schedule.effectiveFrom ?? "unknown"} to ${schedule.effectiveUntil ?? "open-ended"}).` };
  }
  if (rules.noChargeAnnualDates.includes(date.slice(5))) return { band: "free" };
  if (minute < minutes(rules.chargingHours.start) || minute >= minutes(rules.chargingHours.end)) return { band: "free" };
  if (!autoPay) return { band: "phone-online" };
  const day = weekday(date);
  if (day === 0 || day === 6) return { band: "autopay-offpeak" };
  if (date < rules.calendarCoverage.from || date > rules.calendarCoverage.to) {
    return { unresolved: `Auto Pay peak/off-peak on ${formatDate(date)} depends on the bank-holiday calendar, which is only recorded for ${rules.calendarCoverage.from} to ${rules.calendarCoverage.to}.` };
  }
  if (rules.bankHolidays.includes(date)) {
    return { unresolved: `${formatDate(date)} is a weekday bank holiday; TfL guidance does not state whether Auto Pay peak rates apply.` };
  }
  const peak = rules.autoPayPeak[crossing.direction];
  return { band: minute >= minutes(peak.start) && minute < minutes(peak.end) ? "autopay-peak" : "autopay-offpeak" };
}

/** The crossing time is unknown within the window, so the band must be the same throughout it. */
function tunnelBand(schedule: TunnelSchedule, crossing: TunnelCrossing, autoPay: boolean, window: JourneyWindow): BandResult & { date?: string } {
  const rules = schedule.rules;
  const breakpoints = [
    rules.chargingHours.start, rules.chargingHours.end,
    rules.autoPayPeak.northbound.start, rules.autoPayPeak.northbound.end,
    rules.autoPayPeak.southbound.start, rules.autoPayPeak.southbound.end
  ].map(minutes);
  let found: TunnelBand | "free" | null = null;
  let foundDate: string | undefined;
  for (const segment of window.segments) {
    const samples = [segment.from, ...breakpoints.filter((point) => point > segment.from && point < segment.to)];
    for (const minute of samples) {
      const result = tunnelBandAt(schedule, crossing, autoPay, segment.date, minute);
      if ("unresolved" in result) return result;
      if (found !== null && found !== result.band) {
        return { unresolved: "The journey window spans a change in tunnel charging period, so the rate for this crossing cannot be determined." };
      }
      found = result.band;
      foundDate ??= segment.date;
    }
  }
  return { band: found ?? "free", date: foundDate };
}

const DIRECTION_LABEL = { northbound: "northbound", southbound: "southbound" } as const;

function tunnelLine(
  crossing: TunnelCrossing,
  ordinal: number,
  profile: RoadChargeProfile | null,
  record: RoadChargeScheduleRecord | undefined,
  window: JourneyWindow,
  options: RoadChargeLineOptions
): PriceLine {
  const label = `${crossing.label} — ${DIRECTION_LABEL[crossing.direction]} crossing ${ordinal}`;
  const source: Record<string, unknown> = {
    scheme: "blackwall-silvertown-tunnels",
    tunnel: crossing.tunnel,
    direction: crossing.direction,
    crossing: ordinal,
    schedule: scheduleSource(record),
    matchingBasis: { method: "route-gate-crossing", segmentIndex: crossing.segmentIndex, point: crossing.point, geometry: crossing.geometry },
    journeyWindow: windowSource(window),
    vehicleInput: { tunnelVehicleClass: profile?.tunnelVehicleClass || null, tunnelAutoPay: profile?.tunnelAutoPay || null, vehicleAssigned: profile !== null }
  };
  const unresolved = (basis: string): PriceLine => ({ type: "tunnel-charge", label, status: "unresolved", amount: null, basis: `The route crosses the ${crossing.label} ${crossing.direction}. ${basis}`, source });
  const unavailable = scheduleUnavailable(record, "Blackwall and Silvertown tunnels", options);
  if (unavailable) return unresolved(unavailable);
  if (!crossing.geometry.verified) return unresolved("The tunnel was identified with unverified reference geometry.");
  if (!profile) return unresolved(NO_VEHICLE_BASIS);
  const schedule = record!.schedule as TunnelSchedule;
  if (!profile.tunnelVehicleClass) return unresolved("The assigned vehicle's tunnel vehicle class is not recorded.");
  if (profile.tunnelAutoPay !== "yes" && profile.tunnelAutoPay !== "no") return unresolved("Whether the assigned vehicle pays by Auto Pay is not recorded.");
  const band = tunnelBand(schedule, crossing, profile.tunnelAutoPay === "yes", window);
  if ("unresolved" in band) return unresolved(band.unresolved);
  if (band.band === "free") {
    return { type: "tunnel-charge", label, status: "not-applicable", amount: null, basis: `The route crosses the ${crossing.label} ${crossing.direction} outside charging hours/days.`, source };
  }
  const rate = schedule.rates.find((item) => item.key === tunnelRateKey(profile.tunnelVehicleClass, band.band as TunnelBand));
  if (!rate || !/^\d{1,6}\.\d{2}$/.test(rate.amount) || Number(rate.amount) === 0) {
    return unresolved(`No valid tunnel rate is configured for ${optionLabel("tunnelVehicleClass", profile.tunnelVehicleClass)}.`);
  }
  source.rate = { key: rate.key, label: rate.label, amount: rate.amount };
  return {
    type: "tunnel-charge",
    label,
    status: "applied",
    amount: rate.amount,
    basis: `Per-crossing charge: ${rate.label} (schedule version ${record!.version}).`,
    source
  };
}

function tollLine(route: ResolvedBookingRoute): PriceLine {
  const crossings = route.tunnelCrossings.length;
  const source = { provider: route.provider, tollsReported: route.tollsReported, identifiedTunnelCrossings: crossings, tunnelCrossingsExcluded: crossings > 0 };
  if (!route.tollsReported) {
    return { type: "toll", label: "Other tolls", status: "not-applicable", amount: null, basis: "No tolls reported by the routing provider.", source };
  }
  return {
    type: "toll",
    label: "Other tolls",
    status: "unresolved",
    amount: null,
    basis: crossings
      ? `The routing provider reports tolls. The ${crossings} identified Blackwall/Silvertown crossing(s) are itemized separately and not counted here, but the provider does not identify individual toll facilities, so other tolls on this route cannot be ruled out.`
      : "The routing provider reports tolls that are not attributable to an identified, configured scheme, so the amount cannot be calculated.",
    source
  };
}

/**
 * Road-charge lines for a quote, always in the same order: one line each for LEZ, ULEZ and the Congestion Charge
 * (whether or not the route enters the zone), one line per identified tunnel crossing (or one line when none is
 * identified), and one line for any remaining provider-reported tolls. Charges are never folded into the ride
 * fare, merged across schemes, or discounted.
 */
export function roadChargeLines(
  serviceDate: string,
  serviceTime: string,
  /** Vehicle-side facts used for the quote; null when no vehicle profile is available (every charge unresolved). */
  profile: RoadChargeProfile | null,
  route: BookingRoute,
  schedules: RoadChargeScheduleSet,
  options: RoadChargeLineOptions = {}
): PriceLine[] {
  const zoneSchemes: DailyZoneScheme[] = ["london-lez", "london-ulez", "london-congestion-charge"];
  if (route.status !== "resolved") {
    const reason = "Route unresolved; the road-charge exposure cannot be assessed.";
    return [
      ...zoneSchemes.map((scheme): PriceLine => ({ type: "road-charge", label: `${ZONE_TITLES[scheme]} daily charge`, status: "unresolved", amount: null, basis: reason, source: { scheme } })),
      { type: "tunnel-charge", label: "Blackwall and Silvertown tunnels", status: "unresolved", amount: null, basis: "Route unresolved; tunnel crossings cannot be assessed.", source: {} },
      { type: "toll", label: "Other tolls", status: "unresolved", amount: null, basis: "Route unresolved; tolls cannot be assessed.", source: {} }
    ];
  }
  const window = journeyWindow(serviceDate, serviceTime, route.durationSeconds);
  const lines: PriceLine[] = zoneSchemes.map((scheme) => {
    // A route is listed once per zone however often it enters it, so a charging day is never charged twice.
    const detection = route.zones.find((zone) => zone.zone === scheme) ?? null;
    return zoneLine(scheme, detection, profile, schedules[scheme], window, options);
  });
  route.tunnelCrossings.forEach((crossing, index) => {
    lines.push(tunnelLine(crossing, index + 1, profile, schedules["blackwall-silvertown-tunnels"], window, options));
  });
  if (!route.tunnelCrossings.length) {
    const tunnelBlockers = (options.codeCalculationBlockers ?? codeCalculationBlockers)("blackwall-silvertown-tunnels");
    lines.push(tunnelBlockers.length
      ? { type: "tunnel-charge", label: "Blackwall and Silvertown tunnels", status: "unresolved", amount: null, basis: `No Blackwall or Silvertown crossing was identified, but crossings cannot be ruled out: ${tunnelBlockers.join(" ")}`, source: {} }
      : { type: "tunnel-charge", label: "Blackwall and Silvertown tunnels", status: "not-applicable", amount: null, basis: "No Blackwall or Silvertown crossing identified on the route geometry.", source: {} });
  }
  lines.push(tollLine(route));
  return lines;
}


/** Compact schedule references stored with the booking price snapshot. */
export function roadChargeScheduleReferences(schedules: RoadChargeScheduleSet) {
  return Object.fromEntries(Object.entries(schedules).map(([scheme, record]) => [scheme, scheduleSource(record)]));
}
