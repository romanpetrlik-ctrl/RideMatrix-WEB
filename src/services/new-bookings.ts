import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { query, withTransaction } from "../database/connection";
import { airportFeeStore, type AirportFeeRecord } from "./airport-fees";
import { createGoogleRoutesProvider, type BookingRoute, type BookingRouteProvider } from "./booking-routing";
import {
  priceBooking,
  type BookingPrice,
  type BookingPricingInputs,
  type BookingStop,
  type BookingStops,
  type PriceLine
} from "./booking-pricing";
import { getOperationalBase, type OperationalBase } from "./dead-mileage";
import { fareSettingsStore, normalizeUkPostcode, validCalendarDate, type FareSettingsSnapshot } from "./fare-settings";
import { verifyGoogleOperationalPlace, type OperationalPlaceVerification } from "./google-places";
import { poiManagementStore, type PoiFeeRecord, type PoiRecord } from "./poi-management";
import { createCustomer, updateCustomerLastBookingAt, type CustomerCreateInput } from "./customers";
import { londonFeeScheduleStore } from "./london-fee-schedules";
import { roadChargeScheduleReferences, type RoadChargeScheduleSet } from "./road-charge-pricing";
import { listVehicleClasses, type VehicleClass } from "./vehicles";

export const BOOKING_COUNT_MAX = 7;
export const NEW_CUSTOMER_SELECTION_VALUE = "__create_new_customer__";
export const BOOKING_COUNT_FIELDS = [
  ["adults", "Adults"],
  ["children", "Children"],
  ["sportsEquipment", "Sports items"],
  ["xlBaggage", "XL bags"],
  ["lBaggage", "L bags"],
  ["cabinHandBags", "Cabin bags"],
  ["backpacks", "Backpacks"]
] as const;
export type BookingCountField = (typeof BOOKING_COUNT_FIELDS)[number][0];
export const STOP_KEYS = ["pickup", "via1", "via2", "dropoff"] as const;
export type StopKey = (typeof STOP_KEYS)[number];
export const BOOKING_PAYMENT_METHODS = [
  { value: "invoice", label: "Invoice" },
  { value: "payment-link", label: "Payment link" }
] as const;
export type BookingPaymentMethod = (typeof BOOKING_PAYMENT_METHODS)[number]["value"];
export const BOOKING_PAYER_TYPES = [
  { value: "booking_manager", label: "Booking manager" },
  { value: "lead_passenger", label: "Lead passenger" },
  { value: "other", label: "Someone else / company" }
] as const;
export type BookingPayerType = (typeof BOOKING_PAYER_TYPES)[number]["value"];

export type BookingFieldError = { field: string; message: string };

export type BookingManagerCandidate = {
  customerId: string;
  name: string;
  phone: string;
  email: string;
  company: string | null;
  isBusiness: boolean;
  customerDiscountPercentage?: string | null;
};

export type SubmittedStop = {
  kind: string;
  managedId: string;
  placeId: string;
  label: string;
  houseNameNumber: string;
};

export type NewBookingDraft = {
  customerMode: "existing" | "new";
  customerId: string;
  newCustomerGivenName: string;
  newCustomerSurname: string;
  newCustomerPhone: string;
  newCustomerEmail: string;
  managerName: string;
  managerPhone: string;
  managerEmail: string;
  notifyBookingManager?: boolean;
  bookingManagerWhatsappOptIn: boolean;
  passengerIsManager: boolean;
  passengerName: string;
  passengerPhone: string;
  passengerEmail: string;
  passengerWhatsappOptIn: boolean;
  payerType: BookingPayerType;
  payerName: string;
  payerEmail: string;
  payerPhone: string;
  serviceDate: string;
  serviceTime: string;
  vehicleClassKey: string;
  paymentMethod: string;
  stops: Record<StopKey, SubmittedStop>;
  viaActive: { via1: boolean; via2: boolean };
  counts: Record<BookingCountField, string>;
  childSeatRequired: string;
  boosterRequired: string;
  confirmedPoiFeeIds: string[];
  saveWithUnresolvedPrice: boolean;
  quotedTotal: string;
  quotedStatus: string;
  quotedFingerprint: string;
};

export type ValidatedJourney = {
  serviceDate: string;
  serviceTime: string;
  stops: BookingStops;
  pricingInputs: BookingPricingInputs;
};

export type ValidatedBooking = ValidatedJourney & {
  customerId: string;
  newCustomer: CustomerCreateInput | null;
  paymentMethod: BookingPaymentMethod;
  managerName: string;
  managerPhone: string;
  managerEmail: string;
  notifyBookingManager: boolean;
  bookingManagerWhatsappOptIn: boolean;
  passengerIsManager: boolean;
  passengerName: string;
  passengerPhone: string;
  passengerEmail: string;
  passengerWhatsappOptIn: boolean;
  payerType: BookingPayerType;
  payerName: string;
  payerEmail: string;
  payerPhone: string;
  counts: Record<BookingCountField, number>;
  childSeatRequired: boolean;
  boosterRequired: boolean;
};

export type PricingReferenceData = {
  fareSettings: FareSettingsSnapshot;
  airports: AirportFeeRecord[];
  pois: PoiRecord[];
  poiFees: PoiFeeRecord[];
  operationalBase: OperationalBase | null;
  roadChargeSchedules: RoadChargeScheduleSet;
  vehicleClasses: VehicleClass[];
};

export type NewBookingDependencies = {
  loadReferenceData: () => Promise<PricingReferenceData>;
  verifyPlace: (placeId: string) => Promise<OperationalPlaceVerification>;
  computeRoute: BookingRouteProvider;
  now: () => Date;
};

export const SERVICE_TIMEZONE = "Europe/London";

export async function loadPricingReferenceData(): Promise<PricingReferenceData> {
  const [fareSettings, airports, pois, poiFees, operationalBase, roadChargeSchedules, vehicleClasses] = await Promise.all([
    fareSettingsStore.load(),
    airportFeeStore.list(),
    poiManagementStore.listPois(),
    poiManagementStore.listFees(),
    getOperationalBase(),
    londonFeeScheduleStore.loadPricingSchedules(),
    listVehicleClasses()
  ]);
  return { fareSettings, airports, pois, poiFees, operationalBase, roadChargeSchedules, vehicleClasses };
}

const verificationCache = new Map<string, { at: number; result: OperationalPlaceVerification }>();

async function cachedVerifyPlace(placeId: string): Promise<OperationalPlaceVerification> {
  const cached = verificationCache.get(placeId);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.result;
  const result = await verifyGoogleOperationalPlace(placeId);
  if (result.status === "verified") {
    if (verificationCache.size > 500) verificationCache.delete(verificationCache.keys().next().value!);
    verificationCache.set(placeId, { at: Date.now(), result });
  }
  return result;
}

export const defaultNewBookingDependencies: NewBookingDependencies = {
  loadReferenceData: loadPricingReferenceData,
  verifyPlace: cachedVerifyPlace,
  computeRoute: createGoogleRoutesProvider(),
  now: () => new Date()
};

function text(body: Record<string, unknown>, key: string, max = 300): string {
  const value = body[key];
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function list(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean).slice(0, 50);
}

export function readNewBookingDraft(body: unknown): NewBookingDraft {
  const source = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const stop = (key: StopKey): SubmittedStop => {
    const kind = text(source, `${key}Kind`, 20);
    return {
      kind,
      managedId: kind === "airport" ? text(source, `${key}AirportId`, 100) : kind === "poi" ? text(source, `${key}PoiId`, 100) : "",
      placeId: kind === "address" ? text(source, `${key}PlaceId`, 300) : "",
      label: kind === "address" ? text(source, `${key}Label`, 300) : "",
      houseNameNumber: kind === "address" ? text(source, `${key}HouseNameNumber`, 120) : ""
    };
  };
  const counts = Object.fromEntries(BOOKING_COUNT_FIELDS.map(([field]) => [field, text(source, field, 5)])) as Record<BookingCountField, string>;
  const selectedCustomer = text(source, "customerId", 100);
  const customerMode = selectedCustomer === NEW_CUSTOMER_SELECTION_VALUE ? "new" : "existing";
  return {
    customerMode,
    customerId: customerMode === "new" ? "" : selectedCustomer,
    newCustomerGivenName: text(source, "newCustomerGivenName", 200),
    newCustomerSurname: text(source, "newCustomerSurname", 200),
    newCustomerPhone: text(source, "newCustomerPhone", 50),
    newCustomerEmail: text(source, "newCustomerEmail", 254),
    managerName: text(source, "managerName", 200),
    managerPhone: text(source, "managerPhone", 50),
    managerEmail: text(source, "managerEmail", 254),
    notifyBookingManager: text(source, "notifyBookingManager") === "yes",
    bookingManagerWhatsappOptIn: text(source, "bookingManagerWhatsappOptIn") === "yes",
    payerType: BOOKING_PAYER_TYPES.some(({ value }) => value === source.payerType)
      ? source.payerType as BookingPayerType : "booking_manager",
    payerName: text(source, "payerName", 200),
    payerEmail: text(source, "payerEmail", 254),
    payerPhone: text(source, "payerPhone", 50),
    passengerIsManager: text(source, "passengerIsManager") === "yes",
    passengerName: text(source, "passengerName", 200),
    passengerPhone: text(source, "passengerPhone", 50),
    passengerEmail: text(source, "passengerEmail", 254),
    passengerWhatsappOptIn: text(source, "passengerWhatsappOptIn") === "yes",
    serviceDate: text(source, "serviceDate", 20),
    serviceTime: text(source, "serviceTime", 10),
    vehicleClassKey: text(source, "vehicleClassKey", 100),
    paymentMethod: text(source, "paymentMethod", 40),
    stops: { pickup: stop("pickup"), via1: stop("via1"), via2: stop("via2"), dropoff: stop("dropoff") },
    viaActive: { via1: text(source, "via1Active") === "yes", via2: text(source, "via2Active") === "yes" },
    counts,
    childSeatRequired: text(source, "childSeatRequired", 5),
    boosterRequired: text(source, "boosterRequired", 5),
    confirmedPoiFeeIds: list(source, "confirmedPoiFeeIds"),
    saveWithUnresolvedPrice: text(source, "saveWithUnresolvedPrice") === "yes",
    quotedTotal: text(source, "quotedTotal", 20),
    quotedStatus: text(source, "quotedStatus", 20),
    quotedFingerprint: text(source, "quotedFingerprint", 64)
  };
}

/** Five-minute time options in 24-hour HH:mm. */
export function serviceTimeOptions(): string[] {
  const options: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 5) {
    options.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  }
  return options;
}

export function isFiveMinuteTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5][05]$/.test(value);
}

function zonedParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Converts a local wall-clock date/time in the service timezone to a UTC instant. */
export function serviceLocalToUtc(date: string, time: string, timeZone = SERVICE_TIMEZONE): Date {
  const naive = new Date(`${date}T${time}:00Z`);
  let guess = naive.getTime();
  for (let i = 0; i < 2; i += 1) {
    const local = zonedParts(new Date(guess), timeZone);
    const offset = new Date(`${local.date}T${local.time}:00Z`).getTime() - guess;
    guess = naive.getTime() - offset;
  }
  return new Date(guess);
}

/** Default service date/time: now in the service timezone rounded up to the next five minutes. */
export function defaultServiceDateTime(now: Date, timeZone = SERVICE_TIMEZONE): { date: string; time: string } {
  const rounded = new Date(Math.ceil(now.getTime() / 300_000) * 300_000);
  return zonedParts(rounded, timeZone);
}

export function formatInServiceTimezone(value: string | Date, timeZone = SERVICE_TIMEZONE): string {
  const parts = zonedParts(new Date(value), timeZone);
  return `${parts.date} ${parts.time}`;
}

function parseCount(value: string): number | null {
  if (value === "") return 0;
  if (!/^\d$/.test(value)) return null;
  const count = Number(value);
  return count <= BOOKING_COUNT_MAX ? count : null;
}

function yesNo(value: string): boolean | null {
  if (value === "yes") return true;
  if (value === "no" || value === "") return false;
  return null;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone: string): boolean {
  return /^\+?[0-9 ()-]{7,20}$/.test(phone) && phone.replace(/\D/g, "").length >= 7;
}

const STOP_TITLES: Record<StopKey, string> = { pickup: "Pickup", via1: "Via 1", via2: "Via 2", dropoff: "Drop-off" };

function formatAddressLabel(houseNameNumber: string, address: string): string {
  const house = houseNameNumber.trim();
  const formattedAddress = address.trim();
  const normalizedAddress = formattedAddress.toLocaleLowerCase("en-GB");
  const normalizedHouse = house.toLocaleLowerCase("en-GB");
  const addressStartsWithHouse = normalizedAddress === normalizedHouse
    || normalizedAddress.startsWith(`${normalizedHouse},`)
    || normalizedAddress.startsWith(`${normalizedHouse} `);
  return house && !addressStartsWithHouse
    ? `${house}, ${formattedAddress}`
    : formattedAddress;
}

async function resolveStop(
  key: StopKey,
  submitted: SubmittedStop,
  reference: PricingReferenceData,
  verifyPlace: NewBookingDependencies["verifyPlace"],
  errors: BookingFieldError[]
): Promise<BookingStop | null> {
  const title = STOP_TITLES[key];
  const field = `${key}Kind`;
  if (submitted.kind === "airport") {
    const airport = reference.airports.find((record) => record.id === submitted.managedId);
    if (!airport) {
      errors.push({ field, message: `${title}: select an active managed airport.` });
      return null;
    }
    const pickupSide = key === "pickup";
    return {
      kind: "airport",
      managedId: airport.id,
      placeId: pickupSide ? airport.pickupPlaceId : airport.dropoffPlaceId,
      label: `${airport.displayName} — ${pickupSide ? airport.pickupLocationLabel : airport.dropoffLocationLabel}`,
      latitude: pickupSide ? airport.pickupLatitude : airport.dropoffLatitude,
      longitude: pickupSide ? airport.pickupLongitude : airport.dropoffLongitude,
      coordinatesVerified: true,
      postcode: null
    };
  }
  if (submitted.kind === "poi") {
    const poi = reference.pois.find((record) => record.id === submitted.managedId);
    if (!poi) {
      errors.push({ field, message: `${title}: select an active managed POI.` });
      return null;
    }
    return {
      kind: "poi",
      managedId: poi.id,
      placeId: poi.placeId,
      label: `${poi.displayName} — ${poi.locationLabel}`,
      latitude: poi.latitude,
      longitude: poi.longitude,
      coordinatesVerified: true,
      postcode: null
    };
  }
  if (submitted.kind === "address") {
    if (!submitted.label) {
      errors.push({ field, message: `${title}: enter or select an address.` });
      if (!submitted.houseNameNumber) {
        errors.push({ field: `${key}HouseNameNumber`, message: `${title}: enter a house name or number.` });
      }
      return null;
    }
    if (submitted.placeId) {
      const verification = await verifyPlace(submitted.placeId);
      if (verification.status === "outside_uk") {
        errors.push({ field, message: `${title}: the selected address is outside the UK.` });
        return null;
      }
      if (verification.status === "verified") {
        const houseNameNumber = submitted.houseNameNumber || verification.address.houseNameNumber || "";
        if (!houseNameNumber) {
          errors.push({ field: `${key}HouseNameNumber`, message: `${title}: enter a house name or number.` });
          return null;
        }
        return {
          kind: "address",
          managedId: null,
          placeId: verification.address.providerPlaceId,
          label: formatAddressLabel(houseNameNumber, verification.address.formattedAddress || submitted.label),
          latitude: verification.address.latitude,
          longitude: verification.address.longitude,
          coordinatesVerified: true,
          postcode: normalizeUkPostcode(verification.address.postcode, "full")
        };
      }
    }
    if (!submitted.houseNameNumber) {
      errors.push({ field: `${key}HouseNameNumber`, message: `${title}: enter a house name or number.` });
      return null;
    }
    return {
      kind: "address",
      managedId: null,
      placeId: null,
      label: formatAddressLabel(submitted.houseNameNumber, submitted.label),
      latitude: null,
      longitude: null,
      coordinatesVerified: false,
      postcode: null
    };
  }
  errors.push({ field, message: `${title} is required.` });
  return null;
}

/** Validates date/time, ordered stops and pricing inputs; used by both the quote endpoint and save. */
export async function validateJourney(
  draft: NewBookingDraft,
  reference: PricingReferenceData,
  dependencies: Pick<NewBookingDependencies, "verifyPlace" | "now">,
  errors: BookingFieldError[]
): Promise<ValidatedJourney | null> {
  const initialErrors = errors.length;
  if (!validCalendarDate(draft.serviceDate)) {
    errors.push({ field: "serviceDate", message: "Enter a valid service date." });
  }
  if (!isFiveMinuteTime(draft.serviceTime)) {
    errors.push({ field: "serviceTime", message: "Select a service time in 24-hour HH:mm using five-minute steps." });
  }
  if (!reference.vehicleClasses.some((item) => item.key === draft.vehicleClassKey)) {
    errors.push({ field: "vehicleClassKey", message: "Select an active vehicle class." });
  }
  if (validCalendarDate(draft.serviceDate) && isFiveMinuteTime(draft.serviceTime)) {
    const serviceInstant = serviceLocalToUtc(draft.serviceDate, draft.serviceTime);
    const roundTrip = zonedParts(serviceInstant, SERVICE_TIMEZONE);
    if (roundTrip.date !== draft.serviceDate || roundTrip.time !== draft.serviceTime) {
      errors.push({ field: "serviceTime", message: `Select a valid service time in ${SERVICE_TIMEZONE}.` });
    }
    const local = defaultServiceDateTime(new Date(dependencies.now().getTime() - 300_000));
    if (`${draft.serviceDate}T${draft.serviceTime}` < `${local.date}T${local.time}`) {
      errors.push({ field: "serviceTime", message: `The service date and time must not be in the past (${SERVICE_TIMEZONE}).` });
    }
  }
  const resolved: Partial<Record<StopKey, BookingStop>> = {};
  for (const key of STOP_KEYS) {
    if ((key === "via1" || key === "via2") && !draft.viaActive[key]) continue;
    const stop = await resolveStop(key, draft.stops[key], reference, dependencies.verifyPlace, errors);
    if (stop) resolved[key] = stop;
  }
  if (draft.viaActive.via2 && !draft.viaActive.via1) {
    errors.push({ field: "via1Kind", message: "Add Via 1 before Via 2." });
  }
  const knownConfirmationFees = new Set(reference.poiFees.filter((fee) => fee.trigger === "confirmation").map((fee) => fee.id));
  if (draft.confirmedPoiFeeIds.some((id) => !knownConfirmationFees.has(id))) {
    errors.push({ field: "confirmedPoiFeeIds", message: "A confirmed POI fee is no longer configured. Refresh the price." });
  }
  if (errors.length > initialErrors || !resolved.pickup || !resolved.dropoff) return null;
  const stops: BookingStops = {
    pickup: resolved.pickup,
    vias: [resolved.via1, resolved.via2].filter((stop): stop is BookingStop => Boolean(stop)),
    dropoff: resolved.dropoff
  };
  const selectedPoiIds = new Set([stops.pickup, ...stops.vias, stops.dropoff].filter((stop) => stop.kind === "poi").map((stop) => stop.managedId));
  return {
    serviceDate: draft.serviceDate,
    serviceTime: draft.serviceTime,
    stops,
    pricingInputs: {
      serviceDate: draft.serviceDate,
      serviceTime: draft.serviceTime,
      vehicleClassKey: draft.vehicleClassKey,
      stops,
      confirmedPoiFeeIds: draft.confirmedPoiFeeIds.filter((id) =>
        reference.poiFees.some((fee) => fee.id === id && selectedPoiIds.has(fee.poiId)))
    }
  };
}

export async function validateNewBooking(
  draft: NewBookingDraft,
  reference: PricingReferenceData,
  dependencies: Pick<NewBookingDependencies, "verifyPlace" | "now">,
  loadManager: (customerId: string) => Promise<BookingManagerCandidate | null>
): Promise<{ errors: BookingFieldError[]; booking: ValidatedBooking | null }> {
  const errors: BookingFieldError[] = [];
  const manager = draft.customerMode === "existing" && draft.customerId ? await loadManager(draft.customerId) : null;
  let newCustomer: CustomerCreateInput | null = null;
  let managerName = draft.managerName;
  let managerPhone = draft.managerPhone;
  let managerEmail = draft.managerEmail;
  if (draft.customerMode === "existing") {
    if (!manager) errors.push({ field: "customerId", message: "Select an existing active customer as booking manager." });
    if (!managerName) errors.push({ field: "managerName", message: "Enter the booking manager's name." });
    if (!isValidPhone(managerPhone)) errors.push({ field: "managerPhone", message: "Enter a valid booking manager phone number." });
    if (managerEmail && !isValidEmail(managerEmail)) errors.push({ field: "managerEmail", message: "Enter a valid booking manager email address." });
  } else {
    if (!draft.newCustomerGivenName) errors.push({ field: "newCustomerGivenName", message: "Enter the customer's first name." });
    if (!draft.newCustomerSurname) errors.push({ field: "newCustomerSurname", message: "Enter the customer's surname." });
    if (!isValidPhone(draft.newCustomerPhone)) errors.push({ field: "newCustomerPhone", message: "Enter a valid customer phone number." });
    if (draft.newCustomerEmail && !isValidEmail(draft.newCustomerEmail)) errors.push({ field: "newCustomerEmail", message: "Enter a valid customer email address." });
    managerName = [draft.newCustomerGivenName, draft.newCustomerSurname].filter(Boolean).join(" ");
    managerPhone = draft.newCustomerPhone;
    managerEmail = draft.newCustomerEmail;
    newCustomer = {
      givenName: draft.newCustomerGivenName,
      surname: draft.newCustomerSurname,
      phone: draft.newCustomerPhone,
      email: draft.newCustomerEmail || null,
      source: "manual"
    };
  }
  if (!BOOKING_PAYMENT_METHODS.some((method) => method.value === draft.paymentMethod)) {
    errors.push({ field: "paymentMethod", message: "Select a payment method for this booking." });
  }
  const passengerName = draft.passengerIsManager ? managerName : draft.passengerName;
  const passengerPhone = draft.passengerIsManager ? managerPhone : draft.passengerPhone;
  const passengerEmail = draft.passengerIsManager ? managerEmail : draft.passengerEmail;
  if (!draft.passengerIsManager) {
    if (!passengerName) errors.push({ field: "passengerName", message: "Enter the passenger's name." });
    if (!isValidPhone(passengerPhone)) errors.push({ field: "passengerPhone", message: "Enter a valid passenger phone number." });
  }
  if (passengerEmail && !isValidEmail(passengerEmail)) {
    errors.push({ field: "passengerEmail", message: "Enter a valid passenger email address." });
  }
  const payerContact = draft.payerType === "booking_manager"
    ? { name: managerName, email: managerEmail, phone: managerPhone }
    : draft.payerType === "lead_passenger"
      ? { name: passengerName, email: passengerEmail, phone: passengerPhone }
      : { name: "", email: "", phone: "" };
  const payerName = draft.payerName || payerContact.name;
  const payerEmail = draft.payerEmail || payerContact.email;
  const payerPhone = draft.payerPhone || payerContact.phone;
  if (!payerName) errors.push({ field: "payerName", message: "Enter the payer's name." });
  if (!isValidEmail(payerEmail)) errors.push({ field: "payerEmail", message: "Enter a valid payer email address." });
  if (payerPhone && !isValidPhone(payerPhone)) errors.push({ field: "payerPhone", message: "Enter a valid payer phone number." });
  const counts = {} as Record<BookingCountField, number>;
  for (const [field, label] of BOOKING_COUNT_FIELDS) {
    const count = parseCount(draft.counts[field]);
    if (count === null) errors.push({ field, message: `${label} must be a whole number from 0 to ${BOOKING_COUNT_MAX}.` });
    else counts[field] = count;
  }
  if (!errors.some((error) => error.field === "adults" || error.field === "children") && counts.adults + counts.children < 1) {
    errors.push({ field: "adults", message: "At least one adult or child passenger is required." });
  }
  const childSeat = yesNo(draft.childSeatRequired);
  const booster = yesNo(draft.boosterRequired);
  if (childSeat === null) errors.push({ field: "childSeatRequired", message: "Select whether a child seat is required." });
  if (booster === null) errors.push({ field: "boosterRequired", message: "Select whether a booster is required." });
  const journey = await validateJourney(draft, reference, dependencies, errors);
  if (errors.length || !journey || (draft.customerMode === "existing" && !manager)) return { errors, booking: null };
  const pricingInputs = {
    ...journey.pricingInputs,
    customerId: manager?.customerId ?? null,
    customerDiscountPercentage: manager?.customerDiscountPercentage ?? null
  };
  return {
    errors,
    booking: {
      ...journey,
      pricingInputs,
      customerId: manager?.customerId ?? "",
      newCustomer,
      paymentMethod: draft.paymentMethod as BookingPaymentMethod,
      managerName,
      managerPhone,
      managerEmail,
      notifyBookingManager: Boolean(draft.notifyBookingManager),
      bookingManagerWhatsappOptIn: Boolean(draft.bookingManagerWhatsappOptIn),
      passengerIsManager: draft.passengerIsManager,
      passengerName,
      passengerPhone,
      passengerEmail,
      passengerWhatsappOptIn: Boolean(draft.passengerWhatsappOptIn),
      payerType: draft.payerType,
      payerName,
      payerEmail,
      payerPhone,
      counts,
      childSeatRequired: childSeat === true,
      boosterRequired: booster === true
    }
  };
}

export function routeStops(stops: BookingStops) {
  const ordered = [stops.pickup, ...stops.vias, stops.dropoff];
  return ordered.every((stop) => stop.latitude !== null && stop.longitude !== null)
    ? ordered.map((stop) => ({ latitude: stop.latitude!, longitude: stop.longitude! }))
    : null;
}

export async function quoteJourney(
  journey: ValidatedJourney,
  reference: PricingReferenceData,
  computeRoute: BookingRouteProvider
): Promise<{ route: BookingRoute; price: BookingPrice; fingerprint: string; roadChargeSchedules: ReturnType<typeof roadChargeScheduleReferences> }> {
  const points = routeStops(journey.stops);
  const route: BookingRoute = points
    ? await computeRoute(points, { departureTime: serviceLocalToUtc(journey.serviceDate, journey.serviceTime) })
    : { status: "unresolved", reason: "missing-stops", message: "One or more stops is an unverified address without coordinates, so the route cannot be calculated." };
  const price = priceBooking(journey.pricingInputs, {
    configuration: reference.fareSettings.configuration,
    fareSettingsVersion: reference.fareSettings.currentVersion,
    airports: reference.airports,
    pois: reference.pois,
    poiFees: reference.poiFees,
    operationalBase: reference.operationalBase,
    route,
    roadChargeSchedules: reference.roadChargeSchedules
  });
  const roadChargeSchedules = roadChargeScheduleReferences(reference.roadChargeSchedules);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    pricingInputs: journey.pricingInputs,
    price: {
      status: price.status,
      total: price.total,
      fareSettingsVersion: price.fareSettingsVersion,
      lines: price.lines
    },
    roadChargeSchedules
  })).digest("hex");
  return { route, price, fingerprint, roadChargeSchedules };
}

type ManagerRow = {
  id: string;
  given_name: string;
  surname: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  customer_discount_percentage: string | number | null;
  booker_full_name: string | null;
  booker_email: string | null;
  booker_phone: string | null;
  registered_name: string | null;
};

function managerFromRow(row: ManagerRow): BookingManagerCandidate {
  const business = Boolean(row.booker_full_name);
  return {
    customerId: row.id,
    name: business ? row.booker_full_name! : [row.given_name, row.surname].filter(Boolean).join(" ").trim(),
    phone: (business ? row.booker_phone : row.phone) ?? "",
    email: (business ? row.booker_email : row.email) ?? "",
    company: row.registered_name ?? row.company,
    isBusiness: business,
    customerDiscountPercentage: row.customer_discount_percentage === null
      ? null
      : Number(row.customer_discount_percentage).toFixed(2)
  };
}

const MANAGER_SELECT = `
  SELECT c.id, c.given_name, c.surname, c.email, c.phone, c.company, c.customer_discount_percentage,
         b.booker_full_name, b.booker_email, b.booker_phone, b.registered_name
    FROM customers c
    LEFT JOIN business_customers b ON b.customer_id = c.id
   WHERE c.deleted_at IS NULL AND c.inactive_at IS NULL AND c.anonymized_at IS NULL
     AND c.erasure_requested_at IS NULL AND c.status = 'Active'`;

/** Active customers usable as booking manager (business customers use their booker contact). */
export async function listBookingManagerCandidates(limit = 500): Promise<BookingManagerCandidate[]> {
  const result = await query<ManagerRow>(`${MANAGER_SELECT}
   ORDER BY lower(c.surname), lower(c.given_name), c.id
   LIMIT $1`, [limit]);
  return result.rows.map(managerFromRow);
}

export async function getBookingManagerCandidate(customerId: string): Promise<BookingManagerCandidate | null> {
  const result = await query<ManagerRow>(`${MANAGER_SELECT} AND c.id = $1`, [customerId]);
  return result.rows[0] ? managerFromRow(result.rows[0]) : null;
}

export type BookingActor = { accountId: string; email: string };

export class BookingPriceChangedError extends Error {
  constructor() {
    super("The price changed since it was last shown. Review the updated breakdown before saving.");
  }
}

export class UnresolvedPriceNotAcknowledgedError extends Error {
  constructor() {
    super("The price is incomplete. Tick “Save with price unresolved” to save this booking without a confirmed total.");
  }
}

async function nextBookingReference(client: pg.PoolClient): Promise<string> {
  await client.query("INSERT INTO id_sequences (name, value) VALUES ('new_booking_reference', 0) ON CONFLICT (name) DO NOTHING");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await client.query<{ value: string | number }>(
      "UPDATE id_sequences SET value = value + 1 WHERE name = 'new_booking_reference' RETURNING value"
    );
    const reference = `RMB-${String(result.rows[0].value).padStart(6, "0")}`;
    const exists = await client.query("SELECT 1 FROM customer_bookings WHERE reference = $1 LIMIT 1", [reference]);
    if (!exists.rowCount) return reference;
  }
  throw new Error("Could not allocate a unique booking reference.");
}

function stopRow(stop: BookingStop) {
  return [stop.kind, stop.managedId, stop.placeId, stop.label, stop.latitude, stop.longitude, stop.postcode, stop.coordinatesVerified];
}

function routeForSnapshot(route: BookingRoute) {
  return route.status === "resolved"
    ? { ...route, path: route.path.map((point) => [Number(point.latitude.toFixed(5)), Number(point.longitude.toFixed(5))]) }
    : route;
}

/** Rejects a save unless the dispatcher saw this exact server price (and acknowledged it if incomplete). */
export function assertQuoteAcknowledged(
  price: BookingPrice,
  fingerprint: string,
  draft: Pick<NewBookingDraft, "quotedTotal" | "quotedStatus" | "quotedFingerprint" | "saveWithUnresolvedPrice">
): void {
  const shownTotal = draft.quotedStatus === "complete" ? draft.quotedTotal : "";
  if (draft.quotedStatus !== price.status || (price.status === "complete" && shownTotal !== price.total) || draft.quotedFingerprint !== fingerprint) {
    throw new BookingPriceChangedError();
  }
  if (price.status === "incomplete" && !draft.saveWithUnresolvedPrice) throw new UnresolvedPriceNotAcknowledgedError();
}

/**
 * Persists the booking, its ordered stops, the price snapshot and every line item in one transaction. The
 * snapshot is recalculated server-side; a quote the dispatcher has not seen is never saved silently.
 */
export async function createNewBooking(
  booking: ValidatedBooking,
  quote: { route: BookingRoute; price: BookingPrice; fingerprint: string; roadChargeSchedules?: Record<string, unknown> },
  draft: Pick<NewBookingDraft, "quotedTotal" | "quotedStatus" | "quotedFingerprint" | "saveWithUnresolvedPrice">,
  actor: BookingActor,
  now: Date
): Promise<{ id: string; reference: string; customerId: string }> {
  const { price, route } = quote;
  assertQuoteAcknowledged(price, quote.fingerprint, draft);
  const id = randomUUID();
  const snapshotId = randomUUID();
  const createdAt = now.toISOString();
  return withTransaction(async (client) => {
    const newCustomer = booking.newCustomer
      ? await createCustomer(booking.newCustomer, client)
      : null;
    const customerId = newCustomer?.id ?? booking.customerId;
    if (!customerId) throw new Error("A booking requires a valid existing or new customer.");
    const reference = await nextBookingReference(client);
    await client.query(
      `INSERT INTO customer_bookings (
         id, customer_id, reference, service_date, pickup, dropoff, status, created_at,
         total_fare_amount, service_time, service_timezone, created_by_account_id, created_by_email,
         booking_manager_name, booking_manager_phone, booking_manager_email, passenger_is_booking_manager,
         passenger_name, passenger_phone, adults, children, sports_equipment, xl_baggage, l_baggage,
         cabin_hand_bags, backpacks, child_seat_required, booster_required, price_status,
         vehicle_class_key, payment_method, notify_booking_manager, booking_manager_whatsapp_opt_in,
         passenger_email, passenger_whatsapp_opt_in,
         payer_type, payer_name, payer_email, payer_phone
       ) VALUES ($1,$2,$3,$4,$5,$6,'New',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)`,
      [
        id, customerId, reference, booking.serviceDate, booking.stops.pickup.label, booking.stops.dropoff.label, createdAt,
        price.total, booking.serviceTime, SERVICE_TIMEZONE, actor.accountId, actor.email,
        booking.managerName, booking.managerPhone, booking.managerEmail || null, booking.passengerIsManager,
        booking.passengerName, booking.passengerPhone, booking.counts.adults, booking.counts.children,
        booking.counts.sportsEquipment, booking.counts.xlBaggage, booking.counts.lBaggage,
        booking.counts.cabinHandBags, booking.counts.backpacks, booking.childSeatRequired, booking.boosterRequired,
        price.status, booking.pricingInputs.vehicleClassKey, booking.paymentMethod, booking.notifyBookingManager,
        booking.bookingManagerWhatsappOptIn, booking.passengerEmail || null, booking.passengerWhatsappOptIn, booking.payerType,
        booking.payerName, booking.payerEmail, booking.payerPhone || null
      ]
    );
    const ordered: Array<["pickup" | "via" | "dropoff", BookingStop]> = [
      ["pickup", booking.stops.pickup],
      ...booking.stops.vias.map((stop) => ["via", stop] as ["via", BookingStop]),
      ["dropoff", booking.stops.dropoff]
    ];
    for (const [position, [type, stop]] of ordered.entries()) {
      await client.query(
        `INSERT INTO booking_journey_stops (booking_id, position, stop_type, location_kind, managed_location_id,
           provider_place_id, label, latitude, longitude, postcode, coordinates_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, position, type, ...stopRow(stop)]
      );
    }
    await client.query(
      `INSERT INTO booking_price_snapshots (id, booking_id, status, total_amount, fare_settings_version, inputs, route,
         calculation, unresolved_acknowledged, created_at, created_by_account_id, created_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        snapshotId, id, price.status, price.total, price.fareSettingsVersion,
        JSON.stringify(booking.pricingInputs), JSON.stringify(routeForSnapshot(route)),
        JSON.stringify({ unresolvedCount: price.unresolvedCount, method: "booking-pricing-v2", roadChargeSchedules: quote.roadChargeSchedules ?? {} }),
        price.status === "incomplete", createdAt, actor.accountId, actor.email
      ]
    );
    for (const [position, line] of price.lines.entries()) {
      await client.query(
        `INSERT INTO booking_price_line_items (snapshot_id, position, line_type, label, status, amount, basis, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [snapshotId, position, line.type, line.label, line.status, line.amount, line.basis, JSON.stringify(line.source)]
      );
    }
    await updateCustomerLastBookingAt(customerId, serviceLocalToUtc(booking.serviceDate, booking.serviceTime).toISOString(), client);
    return { id, reference, customerId };
  });
}

export type SavedBookingStop = BookingStop & { position: number; stopType: "pickup" | "via" | "dropoff" };

export type SavedNewBooking = {
  id: string;
  customerId: string;
  reference: string;
  createdAt: string;
  createdByEmail: string | null;
  serviceDate: string;
  serviceTime: string | null;
  serviceTimezone: string | null;
  status: string;
  managerName: string | null;
  managerPhone: string | null;
  managerEmail: string | null;
  vehicleClassKey: string | null;
  vehicleClassLabel: string | null;
  paymentMethod: BookingPaymentMethod | null;
  passengerIsManager: boolean | null;
  passengerName: string | null;
  passengerPhone: string | null;
  counts: Record<BookingCountField, number | null>;
  childSeatRequired: boolean | null;
  boosterRequired: boolean | null;
  stops: SavedBookingStop[];
  price: null | {
    status: "complete" | "incomplete";
    total: string | null;
    fareSettingsVersion: number | null;
    route: BookingRoute | (Record<string, unknown> & { status: string });
    createdAt: string;
    createdByEmail: string;
    lines: PriceLine[];
  };
};

function amountText(value: string | number | null): string | null {
  return value === null ? null : Number(value).toFixed(2);
}

export async function getNewBooking(id: string): Promise<SavedNewBooking | null> {
  const bookingResult = await query(
    `SELECT b.*, vc.label AS vehicle_class_label
       FROM customer_bookings b
       LEFT JOIN vehicle_classes vc ON vc.key = b.vehicle_class_key
      WHERE b.id = $1`,
    [id]
  );
  const row = bookingResult.rows[0];
  if (!row) return null;
  const [stopsResult, snapshotResult] = await Promise.all([
    query(`SELECT * FROM booking_journey_stops WHERE booking_id = $1 ORDER BY position`, [id]),
    query(`SELECT * FROM booking_price_snapshots WHERE booking_id = $1`, [id])
  ]);
  const snapshot = snapshotResult.rows[0];
  const lines = snapshot
    ? (await query(`SELECT * FROM booking_price_line_items WHERE snapshot_id = $1 ORDER BY position`, [snapshot.id])).rows
    : [];
  return {
    id: row.id,
    customerId: row.customer_id,
    reference: row.reference,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
    serviceDate: row.service_date,
    serviceTime: row.service_time,
    serviceTimezone: row.service_timezone,
    status: row.status,
    managerName: row.booking_manager_name,
    managerPhone: row.booking_manager_phone,
    managerEmail: row.booking_manager_email,
    vehicleClassKey: row.vehicle_class_key,
    vehicleClassLabel: row.vehicle_class_label,
    paymentMethod: row.payment_method,
    passengerIsManager: row.passenger_is_booking_manager,
    passengerName: row.passenger_name,
    passengerPhone: row.passenger_phone,
    counts: {
      adults: row.adults,
      children: row.children,
      sportsEquipment: row.sports_equipment,
      xlBaggage: row.xl_baggage,
      lBaggage: row.l_baggage,
      cabinHandBags: row.cabin_hand_bags,
      backpacks: row.backpacks
    },
    childSeatRequired: row.child_seat_required,
    boosterRequired: row.booster_required,
    stops: stopsResult.rows.map((stop) => ({
      position: stop.position,
      stopType: stop.stop_type,
      kind: stop.location_kind,
      managedId: stop.managed_location_id,
      placeId: stop.provider_place_id,
      label: stop.label,
      latitude: stop.latitude,
      longitude: stop.longitude,
      postcode: stop.postcode,
      coordinatesVerified: stop.coordinates_verified
    })),
    price: snapshot ? {
      status: snapshot.status,
      total: amountText(snapshot.total_amount),
      fareSettingsVersion: snapshot.fare_settings_version,
      route: snapshot.route,
      createdAt: new Date(snapshot.created_at).toISOString(),
      createdByEmail: snapshot.created_by_email,
      lines: lines.map((line) => ({
        type: line.line_type,
        label: line.label,
        status: line.status,
        amount: amountText(line.amount),
        basis: line.basis,
        source: line.source
      }))
    } : null
  };
}

/** Plain-language cargo/passenger summary shared by the server view and client script. */
export function cargoSummary(counts: Record<BookingCountField, number>, childSeat: boolean, booster: boolean): string {
  const passengers = counts.adults + counts.children;
  const bagTypes: [string, number][] = [
    ["XL", counts.xlBaggage],
    ["L", counts.lBaggage],
    ["Cabin", counts.cabinHandBags],
    ["Backpack", counts.backpacks]
  ];
  const bags = bagTypes.reduce((sum, [, count]) => sum + count, 0);
  const parts = [
    `${passengers} passenger${passengers === 1 ? "" : "s"} (${counts.adults} adult${counts.adults === 1 ? "" : "s"}, ${counts.children} child${counts.children === 1 ? "" : "ren"})`,
    ...(bags ? [`${bags} bag${bags === 1 ? "" : "s"} (${bagTypes.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`).join(", ")})`] : []),
    `${counts.sportsEquipment} sports item${counts.sportsEquipment === 1 ? "" : "s"}`
  ];
  const seats = [childSeat ? "child seat" : "", booster ? "booster" : ""].filter(Boolean);
  parts.push(seats.length ? `Requires ${seats.join(" and ")}` : "No child seat or booster");
  return parts.join(" · ");
}
