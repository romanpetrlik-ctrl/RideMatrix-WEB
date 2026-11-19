import { londonCongestionChargeBoundaryMetadata } from "./london-congestion-charge-boundary";
import { londonLezBoundaryMetadata } from "./london-lez-boundary";
import { londonUlezBoundaryMetadata } from "./london-ulez-boundary";
import { TUNNEL_REFERENCE_GEOMETRY } from "./booking-routing";

/**
 * Structured, activatable road-charge schedules (payload format "road-charge-schedule-v1"). They share the
 * append-only london_fee_schedule_versions table with the legacy draft payloads; the latest version per scheme
 * is authoritative. A schedule is used for New Booking prices only while its latest version is active, its
 * effective period covers the service date, and no calculation blocker (data or code) remains.
 */
export const ROAD_CHARGE_SCHEDULE_FORMAT = "road-charge-schedule-v1";

export const ROAD_CHARGE_SCHEMES = [
  "london-lez",
  "london-ulez",
  "london-congestion-charge",
  "blackwall-silvertown-tunnels"
] as const;

export type RoadChargeScheme = (typeof ROAD_CHARGE_SCHEMES)[number];
export type DailyZoneScheme = Exclude<RoadChargeScheme, "blackwall-silvertown-tunnels">;

export type RoadChargeSource = { label: string; url: string; effectiveDate: string | null };

export type RoadChargeRate = {
  key: string;
  label: string;
  /** Two-decimal GBP amount. */
  amount: string;
  /** Only rates that represent a verified £0.00 outcome (e.g. a registered 100% discount) may be zero. */
  allowZero: boolean;
  appliesTo: string;
};

export type RoadChargeVerification = {
  verifiedOn: string;
  verifiedByEmail: string;
  verifiedByAccountId: string | null;
  recordedAt: string;
  sourcesConfirmed: true;
};

type TimeRange = { start: string; end: string };

export type DailyZoneRules = {
  /** Null when charges apply all day (midnight to midnight). */
  chargingHours: null | { weekdays: TimeRange; weekendsAndBankHolidays: TimeRange };
  /** MM-DD dates with no charge every year. */
  noChargeAnnualDates: string[];
  /** Inclusive YYYY-MM-DD ranges with no charge. */
  noChargeDateRanges: Array<{ from: string; to: string }>;
  /** England & Wales bank holidays; required when charging hours depend on them. */
  bankHolidays: string[] | null;
  /** Inclusive service-date range the calendar data is verified for; dates outside are unresolved. */
  calendarCoverage: { from: string; to: string } | null;
};

export type TunnelRules = {
  chargingHours: TimeRange;
  noChargeAnnualDates: string[];
  autoPayPeak: { days: "monday-friday"; northbound: TimeRange; southbound: TimeRange };
  /** TfL guidance does not state whether weekday peaks apply on Monday–Friday bank holidays. */
  weekdayBankHolidayAutoPayPeak: "unresolved";
  bankHolidays: string[];
  calendarCoverage: { from: string; to: string };
  vehicleClasses: Array<{ key: string; label: string }>;
};

type ScheduleCommon = {
  format: typeof ROAD_CHARGE_SCHEDULE_FORMAT;
  title: string;
  status: "inactive" | "active";
  active: boolean;
  bookingPriceUsage: "never" | "new-booking-quotes";
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  sources: RoadChargeSource[];
  research: { checkedOn: string; method: string } | null;
  verification: RoadChargeVerification | null;
  /** Data-level blockers; any entry prevents activation. */
  calculationBlockers: string[];
  operatingRules: string[];
  exemptionsAndDiscounts: string[];
  rates: RoadChargeRate[];
  supersedesLegacyDraftVersion: number | null;
};

export type DailyZoneSchedule = ScheduleCommon & { kind: "daily-zone"; scheme: DailyZoneScheme; rules: DailyZoneRules };
export type TunnelSchedule = ScheduleCommon & { kind: "tunnel-crossing"; scheme: "blackwall-silvertown-tunnels"; rules: TunnelRules };
export type RoadChargeSchedule = DailyZoneSchedule | TunnelSchedule;

export function isRoadChargeSchedule(value: unknown): value is RoadChargeSchedule {
  return Boolean(value && typeof value === "object" && (value as { format?: unknown }).format === ROAD_CHARGE_SCHEDULE_FORMAT);
}

export function isRoadChargeScheme(value: string): value is RoadChargeScheme {
  return (ROAD_CHARGE_SCHEMES as readonly string[]).includes(value);
}

const RESEARCH = {
  checkedOn: "2026-11-19",
  method: "Rules and rates were checked against search-engine copies of the cited TfL/GOV.UK pages (crawled 16–19 November 2026); the pages could not be opened directly from the build environment. An administrator must open every source and confirm it before enabling."
};

// England & Wales bank holidays published at https://www.gov.uk/bank-holidays (checked 2026-11-19).
const BANK_HOLIDAYS_2026_2027 = [
  "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28",
  "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28"
];

const GOV_UK_BANK_HOLIDAYS: RoadChargeSource = { label: "GOV.UK — UK bank holidays (England and Wales)", url: "https://www.gov.uk/bank-holidays", effectiveDate: null };

const rate = (key: string, label: string, amount: string, appliesTo: string, allowZero = false): RoadChargeRate =>
  ({ key, label, amount, allowZero, appliesTo });

export const TUNNEL_VEHICLE_CLASSES = [
  { key: "motorcycles-mopeds-motor-tricycles", label: "Motorcycles, mopeds, motor tricycles" },
  { key: "cars-and-small-vans", label: "Cars and small vans" },
  { key: "large-vans", label: "Large vans" },
  { key: "heavy-goods-vehicles", label: "Heavy goods vehicles" }
] as const;

export const TUNNEL_BANDS = ["autopay-offpeak", "autopay-peak", "phone-online"] as const;
export type TunnelBand = (typeof TUNNEL_BANDS)[number];

const TUNNEL_AMOUNTS: Record<string, [string, string, string]> = {
  "motorcycles-mopeds-motor-tricycles": ["1.55", "2.60", "2.60"],
  "cars-and-small-vans": ["1.55", "4.20", "4.20"],
  "large-vans": ["2.60", "6.80", "6.80"],
  "heavy-goods-vehicles": ["5.25", "10.50", "10.50"]
};

const BAND_LABELS: Record<TunnelBand, string> = {
  "autopay-offpeak": "Auto Pay off-peak",
  "autopay-peak": "Auto Pay peak",
  "phone-online": "Without Auto Pay (phone/online), all charging hours"
};

export function tunnelRateKey(vehicleClass: string, band: TunnelBand): string {
  return `tunnel-${vehicleClass}-${band}`;
}

/** Calculation-ready schedules seeded inactive by migration 0035. Nothing here is active. */
export const roadChargeScheduleSeeds: Record<RoadChargeScheme, RoadChargeSchedule> = {
  "london-lez": {
    format: ROAD_CHARGE_SCHEDULE_FORMAT,
    kind: "daily-zone",
    scheme: "london-lez",
    title: "London LEZ",
    status: "inactive",
    active: false,
    bookingPriceUsage: "never",
    effectiveFrom: "2021-03-01",
    effectiveUntil: null,
    sources: [
      { label: "TfL — LEZ: HGVs, lorries, vans, buses/minibuses, coaches and specialist heavy vehicles", url: "https://tfl.gov.uk/modes/driving/low-emission-zone/lorries-vans-buses-and-coaches", effectiveDate: "2021-03-01" },
      { label: "TfL — Make a LEZ payment", url: "https://tfl.gov.uk/modes/driving/low-emission-zone/make-a-payment", effectiveDate: null },
      { label: "Mayor of London — New tighter LEZ standards for HGVs (press release, 1 March 2021)", url: "https://www.london.gov.uk/press-releases/mayoral/new-tighter-lez-standards-for-hgvs-in-london", effectiveDate: "2021-03-01" }
    ],
    research: RESEARCH,
    verification: null,
    calculationBlockers: [],
    operatingRules: [
      "Operates 24 hours a day, every day of the year (including Christmas Day). A charging day runs midnight to midnight.",
      "One daily charge per vehicle per charging day, however many times the zone is entered.",
      "Cars, motorcycles and vans up to and including 1.205 tonnes unladen are not subject to the LEZ.",
      "Vans/specialist diesel vehicles over 1.205 tonnes unladen up to 3.5 tonnes GVW and minibuses up to 5 tonnes GVW must meet Euro 3 (PM).",
      "Vehicles over 3.5 tonnes GVW and buses/coaches over 5 tonnes GVW must meet Euro VI (NOx and PM) since 1 March 2021."
    ],
    exemptionsAndDiscounts: [
      "RideMatrix does not record vehicle weight or Euro standard. The dispatcher must state the vehicle's LEZ position for each quote; if it is not stated the LEZ line is unresolved.",
      "Exemptions and registered discounts are applied only through the dispatcher's explicit “no LEZ charge” declaration."
    ],
    rates: [
      rate("lez-vans-specialist-minibuses", "Vans, specialist diesel vehicles and minibuses not meeting Euro 3 (PM)", "100.00", "Over 1.205 t unladen up to 3.5 t GVW, or minibuses up to 5 t GVW, not meeting Euro 3 (PM)."),
      rate("lez-heavy-euro-iv-pm", "Heavy vehicles meeting Euro IV/V (PM) but not Euro VI", "100.00", "Over 3.5 t GVW (buses/coaches over 5 t) meeting Euro IV or V (PM) but not Euro VI (NOx and PM)."),
      rate("lez-heavy-below-euro-iv-pm", "Heavy vehicles not meeting Euro IV (PM)", "300.00", "Over 3.5 t GVW (buses/coaches over 5 t) not meeting Euro IV (PM).")
    ],
    rules: { chargingHours: null, noChargeAnnualDates: [], noChargeDateRanges: [], bankHolidays: null, calendarCoverage: null },
    supersedesLegacyDraftVersion: null
  },
  "london-ulez": {
    format: ROAD_CHARGE_SCHEDULE_FORMAT,
    kind: "daily-zone",
    scheme: "london-ulez",
    title: "London ULEZ",
    status: "inactive",
    active: false,
    bookingPriceUsage: "never",
    effectiveFrom: "2023-08-29",
    effectiveUntil: null,
    sources: [
      { label: "TfL — ULEZ: where and when", url: "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/ulez-where-and-when", effectiveDate: "2023-08-29" },
      { label: "TfL — ULEZ: cars", url: "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/cars", effectiveDate: null },
      { label: "TfL — ULEZ: vans, minibuses and more", url: "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/vans-minibuses-and-more", effectiveDate: null },
      { label: "TfL — ULEZ: motorcycles, mopeds and more", url: "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/motorcycles-mopeds-and-more", effectiveDate: null },
      { label: "TfL — ULEZ: larger vehicles", url: "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/larger-vehicles", effectiveDate: null }
    ],
    research: RESEARCH,
    verification: null,
    calculationBlockers: [],
    operatingRules: [
      "£12.50 per charging day. Operates 24 hours a day, every day except Christmas Day (25 December); a charging day runs midnight to midnight, so driving across midnight can incur two charges.",
      "London-wide since 29 August 2023. One daily charge per vehicle per charging day, however many times the zone is entered.",
      "Applies to cars, motorcycles, vans and specialist vehicles up to 3.5 tonnes GVW and minibuses up to 5 tonnes GVW that do not meet the standard: petrol Euro 4 (NOx), diesel Euro 6 (NOx and PM), motorcycles Euro 3 (NOx).",
      "Heavier vehicles do not pay ULEZ; they may be subject to the LEZ instead."
    ],
    exemptionsAndDiscounts: [
      "RideMatrix does not record Euro standards. The dispatcher must state the vehicle's ULEZ position for each quote; if it is not stated the ULEZ line is unresolved.",
      "Exemptions and registered discounts are applied only through the dispatcher's explicit “no ULEZ charge” declaration."
    ],
    rates: [
      rate("ulez-cars", "Cars not meeting the ULEZ standard", "12.50", "Cars that do not meet the standard and are not exempt."),
      rate("ulez-vans-specialist-minibuses", "Vans, specialist vehicles and minibuses not meeting the ULEZ standard", "12.50", "Vans/specialist vehicles up to 3.5 t GVW and minibuses up to 5 t GVW that do not meet the standard."),
      rate("ulez-motorcycles-and-l-category", "Motorcycles, mopeds, motorised tricycles and L-category quadricycles not meeting Euro 3", "12.50", "Motorcycles and L-category vehicles that do not meet Euro 3 (NOx).")
    ],
    rules: { chargingHours: null, noChargeAnnualDates: ["12-25"], noChargeDateRanges: [], bankHolidays: null, calendarCoverage: null },
    supersedesLegacyDraftVersion: null
  },
  "london-congestion-charge": {
    format: ROAD_CHARGE_SCHEDULE_FORMAT,
    kind: "daily-zone",
    scheme: "london-congestion-charge",
    title: "London Congestion Charge",
    status: "inactive",
    active: false,
    bookingPriceUsage: "never",
    effectiveFrom: "2026-01-02",
    effectiveUntil: "2030-03-03",
    sources: [
      { label: "TfL — Congestion Charge", url: "https://tfl.gov.uk/modes/driving/congestion-charge", effectiveDate: null },
      { label: "TfL — Congestion Charge changes (£18 charge and Cleaner Vehicle Discount from 2 January 2026)", url: "https://tfl.gov.uk/modes/driving/congestion-charge/congestion-charge-changes", effectiveDate: "2026-01-02" },
      GOV_UK_BANK_HOLIDAYS
    ],
    research: RESEARCH,
    verification: null,
    calculationBlockers: [],
    operatingRules: [
      "£18 per charging day when paid in advance, on the day or by Auto Pay (from 2 January 2026). The £21 late-payment amount is never quoted.",
      "Charging hours: 07:00–18:00 Monday–Friday; 12:00–18:00 Saturday, Sunday and bank holidays. No charge from Christmas Day to the New Year's Day bank holiday inclusive.",
      "One daily charge per vehicle per charging day, however many times the zone is entered.",
      "Cleaner Vehicle Discount phase 1 (2 January 2026 – 3 March 2030), Auto Pay only: electric cars 25% (£13.50); electric vans, HGVs and quadricycles 50% (£9.00). Phase 2 rates from 4 March 2030 are not configured, so this schedule ends on 3 March 2030.",
      "Bank-holiday calendar data covers service dates to 24 December 2027; later dates are unresolved until the calendar is extended."
    ],
    exemptionsAndDiscounts: [
      "RideMatrix does not record payment registrations or exemptions. The dispatcher must state the Congestion Charge basis for each quote; if it is not stated the line is unresolved.",
      "A registered 100% discount/exemption (for example, a TfL-registered wheelchair-accessible PHV) is quoted as a configured £0.00 charge; exempt vehicle types are declared as “no charge”."
    ],
    rates: [
      rate("cc-standard", "Standard daily charge", "18.00", "Any chargeable vehicle without a registered discount, paid in advance, on the day or by Auto Pay."),
      rate("cc-cvd-electric-car-autopay", "Cleaner Vehicle Discount — electric car (incl. PHV) on Auto Pay", "13.50", "Fully electric car registered for the Cleaner Vehicle Discount and paying by Auto Pay."),
      rate("cc-cvd-electric-van-hgv-quadricycle-autopay", "Cleaner Vehicle Discount — electric van, HGV or quadricycle on Auto Pay", "9.00", "Fully electric van, HGV or quadricycle registered for the Cleaner Vehicle Discount and paying by Auto Pay."),
      rate("cc-registered-100-percent-discount", "Registered 100% discount or exemption", "0.00", "Vehicle registered with TfL for a 100% discount or exemption.", true)
    ],
    rules: {
      chargingHours: { weekdays: { start: "07:00", end: "18:00" }, weekendsAndBankHolidays: { start: "12:00", end: "18:00" } },
      noChargeAnnualDates: [],
      noChargeDateRanges: [{ from: "2025-12-25", to: "2026-01-01" }, { from: "2026-12-25", to: "2027-01-01" }],
      bankHolidays: BANK_HOLIDAYS_2026_2027,
      calendarCoverage: { from: "2026-01-01", to: "2027-12-24" }
    },
    supersedesLegacyDraftVersion: null
  },
  "blackwall-silvertown-tunnels": {
    format: ROAD_CHARGE_SCHEDULE_FORMAT,
    kind: "tunnel-crossing",
    scheme: "blackwall-silvertown-tunnels",
    title: "Blackwall and Silvertown tunnels",
    status: "inactive",
    active: false,
    bookingPriceUsage: "never",
    effectiveFrom: "2026-09-21",
    effectiveUntil: null,
    sources: [
      { label: "TfL — Paying Blackwall and Silvertown tunnel charges", url: "https://tfl.gov.uk/modes/driving/silvertown-blackwall-tunnels-charge/paying-blackwall-and-silvertown-tunnel-charges", effectiveDate: null },
      { label: "TfL — Silvertown Tunnel Statement of Charges (effective September 2026)", url: "https://tfl.gov.uk/cdn/static/cms/documents/silvertown-tunnel-charging-statement-effective-september-2026.pdf", effectiveDate: "2026-09-21" },
      GOV_UK_BANK_HOLIDAYS
    ],
    research: RESEARCH,
    verification: null,
    calculationBlockers: [],
    operatingRules: [
      "Charged per crossing, in each direction, for each tunnel (Blackwall and Silvertown), 06:00–22:00 every day except Christmas Day. Crossings 22:00–06:00 are free.",
      "Auto Pay peak: Monday–Friday, northbound 06:00–10:00 and southbound 16:00–19:00. Auto Pay off-peak applies at all other charging times, including weekends.",
      "Without Auto Pay the peak rate applies at all charging times.",
      "Whether weekday peaks apply on Monday–Friday bank holidays is not stated, so Auto Pay crossings on those days are unresolved."
    ],
    exemptionsAndDiscounts: [
      "Resident, small-business, charity and 100% discounts are not applied.",
      "RideMatrix does not record tunnel vehicle class or Auto Pay status; the dispatcher must state both or the tunnel line is unresolved. Small/large van thresholds are not interpreted — the TfL class is selected explicitly."
    ],
    rates: TUNNEL_VEHICLE_CLASSES.flatMap((vehicleClass) => TUNNEL_BANDS.map((band, index) =>
      rate(tunnelRateKey(vehicleClass.key, band), `${vehicleClass.label} — ${BAND_LABELS[band]}`, TUNNEL_AMOUNTS[vehicleClass.key][index], `${vehicleClass.label}; per crossing.`))),
    rules: {
      chargingHours: { start: "06:00", end: "22:00" },
      noChargeAnnualDates: ["12-25"],
      autoPayPeak: { days: "monday-friday", northbound: { start: "06:00", end: "10:00" }, southbound: { start: "16:00", end: "19:00" } },
      weekdayBankHolidayAutoPayPeak: "unresolved",
      bankHolidays: BANK_HOLIDAYS_2026_2027,
      calendarCoverage: { from: "2026-01-01", to: "2027-12-31" },
      vehicleClasses: TUNNEL_VEHICLE_CLASSES.map((item) => ({ ...item }))
    },
    supersedesLegacyDraftVersion: null
  }
};

/** Rate keys the calculator needs for each scheme; activation requires every one. */
export const REQUIRED_RATE_KEYS: Record<RoadChargeScheme, string[]> = {
  "london-lez": ["lez-vans-specialist-minibuses", "lez-heavy-euro-iv-pm", "lez-heavy-below-euro-iv-pm"],
  "london-ulez": ["ulez-cars", "ulez-vans-specialist-minibuses", "ulez-motorcycles-and-l-category"],
  "london-congestion-charge": ["cc-standard", "cc-cvd-electric-car-autopay", "cc-cvd-electric-van-hgv-quadricycle-autopay", "cc-registered-100-percent-discount"],
  "blackwall-silvertown-tunnels": TUNNEL_VEHICLE_CLASSES.flatMap((item) => TUNNEL_BANDS.map((band) => tunnelRateKey(item.key, band)))
};

/**
 * Blockers that come from code-level reference data rather than the stored schedule: the route geometry used to
 * detect exposure must itself be verified before the charge can be calculated.
 */
export function codeCalculationBlockers(scheme: RoadChargeScheme): string[] {
  switch (scheme) {
    case "london-lez":
      return londonLezBoundaryMetadata.verificationDate ? [] : ["The LEZ boundary dataset has no verification record."];
    case "london-ulez":
      return londonUlezBoundaryMetadata.verificationDate === "Unverified"
        ? [`ULEZ route exposure uses a boundary dataset whose source, licence and effective date are “${londonUlezBoundaryMetadata.sourceUrl}” and whose verification is “${londonUlezBoundaryMetadata.verificationDate}” (src/services/london-ulez-boundary.ts). Replace it with a verified TfL dataset before enabling.`]
        : [];
    case "london-congestion-charge":
      return londonCongestionChargeBoundaryMetadata.verificationDate === "Unverified"
        ? [`Congestion Charge route exposure uses a boundary dataset whose source, licence and effective date are “${londonCongestionChargeBoundaryMetadata.sourceUrl}” and whose verification is “${londonCongestionChargeBoundaryMetadata.verificationDate}” (src/services/london-congestion-charge-boundary.ts). Replace it with a verified TfL dataset before enabling.`]
        : [];
    case "blackwall-silvertown-tunnels":
      return TUNNEL_REFERENCE_GEOMETRY.verified
        ? []
        : [`Blackwall/Silvertown crossings are identified with unverified reference geometry: ${TUNNEL_REFERENCE_GEOMETRY.provenance} Replace TUNNEL_REFERENCE_GEOMETRY (src/services/booking-routing.ts) with verified tunnel geometry before enabling.`];
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function authoritativeUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /(^|\.)(tfl\.gov\.uk|gov\.uk)$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

function validRange(range: unknown): boolean {
  return Boolean(range && typeof range === "object"
    && TIME.test(String((range as TimeRange).start)) && TIME.test(String((range as TimeRange).end))
    && (range as TimeRange).start < (range as TimeRange).end);
}

/** Every reason the schedule cannot be enabled for booking prices; empty when activation is allowed. */
export function activationBlockers(schedule: RoadChargeSchedule): string[] {
  const blockers: string[] = [];
  if (!isRoadChargeSchedule(schedule) || !isRoadChargeScheme(schedule.scheme)) return ["The schedule is not a structured road-charge schedule."];
  if (!isCalendarDate(schedule.effectiveFrom)) blockers.push("The effective-from date is unknown.");
  if (schedule.effectiveUntil !== null && (!isCalendarDate(schedule.effectiveUntil) || (isCalendarDate(schedule.effectiveFrom) && schedule.effectiveUntil < schedule.effectiveFrom))) {
    blockers.push("The effective-until date is invalid.");
  }
  if (!schedule.sources.length) blockers.push("No source is recorded.");
  for (const source of schedule.sources) {
    if (!authoritativeUrl(source.url)) blockers.push(`Source “${source.label}” does not have an https TfL or GOV.UK URL.`);
  }
  if (!schedule.research || !isCalendarDate(schedule.research.checkedOn)) blockers.push("No research/verification date is recorded for the rules.");
  for (const blocker of schedule.calculationBlockers) blockers.push(blocker);
  const byKey = new Map(schedule.rates.map((item) => [item.key, item]));
  for (const key of REQUIRED_RATE_KEYS[schedule.scheme]) {
    const item = byKey.get(key);
    if (!item) {
      blockers.push(`Rate “${key}” is missing.`);
      continue;
    }
    if (!/^\d{1,6}\.\d{2}$/.test(item.amount)) blockers.push(`Rate “${item.label}” has an invalid amount.`);
    else if (Number(item.amount) === 0 && !item.allowZero) blockers.push(`Rate “${item.label}” is £0.00 but is not a verified zero rate.`);
  }
  if (schedule.kind === "daily-zone") {
    const rules = schedule.rules;
    if (rules.chargingHours) {
      if (!validRange(rules.chargingHours.weekdays) || !validRange(rules.chargingHours.weekendsAndBankHolidays)) blockers.push("Charging hours are incomplete.");
      if (!rules.bankHolidays || !rules.calendarCoverage || !isCalendarDate(rules.calendarCoverage.from) || !isCalendarDate(rules.calendarCoverage.to)) {
        blockers.push("Charging hours depend on bank holidays, but no verified bank-holiday calendar is recorded.");
      }
    }
  } else {
    const rules = schedule.rules;
    if (!validRange(rules.chargingHours) || !validRange(rules.autoPayPeak.northbound) || !validRange(rules.autoPayPeak.southbound)) {
      blockers.push("Tunnel charging or peak hours are incomplete.");
    }
    if (!isCalendarDate(rules.calendarCoverage?.from) || !isCalendarDate(rules.calendarCoverage?.to)) blockers.push("No verified bank-holiday calendar is recorded.");
  }
  blockers.push(...codeCalculationBlockers(schedule.scheme));
  return blockers;
}

/** Validates an administrator's rate/effective-date edit; returns normalized amounts and per-field errors. */
export function validateRoadChargeScheduleEdit(
  schedule: RoadChargeSchedule,
  submitted: unknown
): { amounts: Record<string, string>; effectiveFrom: string | null; effectiveUntil: string | null; errors: Record<string, string> } {
  const body = submitted && typeof submitted === "object" ? submitted as Record<string, unknown> : {};
  const amounts: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const item of schedule.rates) {
    const raw = body[`amount_${item.key}`];
    if (typeof raw !== "string" || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(raw)) {
      errors[item.key] = "Enter an amount in GBP with no more than 2 decimal places.";
      continue;
    }
    const [whole, fraction = ""] = raw.split(".");
    const normalized = `${whole}.${fraction.padEnd(2, "0")}`;
    if (Number(normalized) === 0 && !item.allowZero) {
      errors[item.key] = "Enter a GBP amount greater than £0.00.";
      continue;
    }
    amounts[item.key] = normalized;
  }
  const rawFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom.trim() : "";
  const rawUntil = typeof body.effectiveUntil === "string" ? body.effectiveUntil.trim() : "";
  const effectiveFrom = rawFrom === "" ? null : rawFrom;
  const effectiveUntil = rawUntil === "" ? null : rawUntil;
  if (effectiveFrom !== null && !isCalendarDate(effectiveFrom)) errors.effectiveFrom = "Enter a valid effective-from date (YYYY-MM-DD) or leave it blank if unknown.";
  if (effectiveUntil !== null && !isCalendarDate(effectiveUntil)) errors.effectiveUntil = "Enter a valid effective-until date (YYYY-MM-DD) or leave it blank.";
  else if (effectiveUntil !== null && effectiveFrom !== null && isCalendarDate(effectiveFrom) && effectiveUntil < effectiveFrom) {
    errors.effectiveUntil = "The effective-until date must not be before the effective-from date.";
  }
  return { amounts, effectiveFrom, effectiveUntil, errors };
}

// ---------------------------------------------------------------------------------------------------------------
// Vehicle-side road-charge facts (LEZ/ULEZ/Congestion Charge position, tunnel class, Auto Pay). They are not
// dispatcher inputs: they must come from the assigned vehicle's persisted record. Until such a record exists,
// quotes pass null and every vehicle-dependent charge stays unresolved.

export type RoadChargeProfile = {
  lez: string;
  ulez: string;
  congestionCharge: string;
  tunnelVehicleClass: string;
  tunnelAutoPay: string;
};

export const NO_CHARGE = "no-charge";

/** Labels for the stored vehicle-side charge attributes, used in itemized basis text. */
export const ROAD_CHARGE_PROFILE_OPTIONS: Record<keyof RoadChargeProfile, { label: string; options: Array<{ value: string; label: string }> }> = {
  lez: {
    label: "LEZ position",
    options: [
      { value: NO_CHARGE, label: "No LEZ charge — car, motorcycle, van ≤1.205 t unladen, meets LEZ standard, or exempt" },
      { value: "lez-vans-specialist-minibuses", label: "Van/specialist diesel >1.205 t to 3.5 t, or minibus ≤5 t, not meeting Euro 3 (PM)" },
      { value: "lez-heavy-euro-iv-pm", label: "Over 3.5 t (bus/coach over 5 t) meeting Euro IV/V (PM) but not Euro VI" },
      { value: "lez-heavy-below-euro-iv-pm", label: "Over 3.5 t (bus/coach over 5 t) not meeting Euro IV (PM)" }
    ]
  },
  ulez: {
    label: "ULEZ position",
    options: [
      { value: NO_CHARGE, label: "No ULEZ charge — meets ULEZ standard, exempt, or over 3.5 t (bus/coach over 5 t)" },
      { value: "ulez-cars", label: "Car not meeting the ULEZ standard" },
      { value: "ulez-vans-specialist-minibuses", label: "Van/specialist vehicle ≤3.5 t or minibus ≤5 t not meeting the ULEZ standard" },
      { value: "ulez-motorcycles-and-l-category", label: "Motorcycle/moped/L-category not meeting Euro 3" }
    ]
  },
  congestionCharge: {
    label: "Congestion Charge basis",
    options: [
      { value: "cc-standard", label: "Standard daily charge (no registered discount)" },
      { value: "cc-cvd-electric-car-autopay", label: "Electric car with Cleaner Vehicle Discount on Auto Pay" },
      { value: "cc-cvd-electric-van-hgv-quadricycle-autopay", label: "Electric van/HGV/quadricycle with Cleaner Vehicle Discount on Auto Pay" },
      { value: "cc-registered-100-percent-discount", label: "Registered 100% discount or exemption (£0.00)" },
      { value: NO_CHARGE, label: "Exempt vehicle type, no registration needed (e.g. two-wheeled motorcycle)" }
    ]
  },
  tunnelVehicleClass: {
    label: "Blackwall/Silvertown vehicle class",
    options: TUNNEL_VEHICLE_CLASSES.map((item) => ({ value: item.key, label: item.label }))
  },
  tunnelAutoPay: {
    label: "Blackwall/Silvertown Auto Pay",
    options: [
      { value: "yes", label: "Registered for TfL Auto Pay" },
      { value: "no", label: "Not on Auto Pay (pays by phone/online)" }
    ]
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Version transitions. Every change appends a new version; editing always produces an inactive, unverified
// version so a changed rate or date must be re-verified and re-enabled before it can affect prices.

export type RoadChargeActivationRequest =
  | { action: "enable"; verifiedOn: string; sourcesConfirmed: boolean }
  | { action: "disable" };

export type RoadChargeTransitionActor = { accountId: string | null; email: string };

export class RoadChargeActivationError extends Error {
  constructor(readonly blockers: string[]) {
    super(`The schedule cannot be enabled: ${blockers.join(" ")}`);
    this.name = "RoadChargeActivationError";
  }
}

function londonToday(now: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Returns the next payload for an enable/disable request, or throws RoadChargeActivationError with every blocker. */
export function applyRoadChargeActivation(
  schedule: RoadChargeSchedule,
  request: RoadChargeActivationRequest,
  actor: RoadChargeTransitionActor,
  now: Date
): RoadChargeSchedule {
  if (request.action === "disable") {
    return { ...schedule, status: "inactive", active: false, bookingPriceUsage: "never", verification: null };
  }
  const blockers = activationBlockers(schedule);
  if (!isCalendarDate(request.verifiedOn)) blockers.push("Enter the date you verified the rules and rates against the cited sources.");
  else if (request.verifiedOn > londonToday(now)) blockers.push("The verification date cannot be in the future.");
  if (request.sourcesConfirmed !== true) blockers.push("Confirm that you opened every cited source and that the rules, rates and effective dates match.");
  if (blockers.length) throw new RoadChargeActivationError(blockers);
  return {
    ...schedule,
    status: "active",
    active: true,
    bookingPriceUsage: "new-booking-quotes",
    verification: {
      verifiedOn: request.verifiedOn,
      verifiedByEmail: actor.email,
      verifiedByAccountId: actor.accountId,
      recordedAt: now.toISOString(),
      sourcesConfirmed: true
    }
  };
}

/** Applies validated amounts/effective dates; the result is always inactive and unverified. */
export function applyRoadChargeEdit(
  schedule: RoadChargeSchedule,
  edit: { amounts: Record<string, string>; effectiveFrom: string | null; effectiveUntil: string | null }
): RoadChargeSchedule {
  const validation = validateRoadChargeScheduleEdit(schedule, {
    ...Object.fromEntries(Object.entries(edit.amounts).map(([key, amount]) => [`amount_${key}`, amount])),
    effectiveFrom: edit.effectiveFrom ?? "",
    effectiveUntil: edit.effectiveUntil ?? ""
  });
  if (Object.keys(validation.errors).length) throw new Error("Invalid road-charge schedule edit reached persistence.");
  return {
    ...schedule,
    status: "inactive",
    active: false,
    bookingPriceUsage: "never",
    verification: null,
    effectiveFrom: validation.effectiveFrom,
    effectiveUntil: validation.effectiveUntil,
    rates: schedule.rates.map((item) => ({ ...item, amount: validation.amounts[item.key] }))
  } as RoadChargeSchedule;
}
