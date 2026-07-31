export const CABCHER_SOURCE_TYPE = "cabcher_cleaned_bookings" as const;

const REQUIRED_COLUMNS = ["Name", "Email", "Date & Time", "Pick Up", "Drop Off"] as const;

type BatchStatus = "uploaded" | "parsed" | "imported" | "failed";

type TemporalStatus = "past" | "upcoming";

type RowRejection = {
  rowNumber: number;
  reason: string;
};

export type ImportBatchRecord = {
  id: string;
  sourceType: typeof CABCHER_SOURCE_TYPE;
  originalFilename: string;
  uploadedBy: string | null;
  uploadedAt: string;
  status: BatchStatus;
  totalRows: number;
  importedRows: number;
  rejectedRows: number;
  notes: string | null;
};

export type BookingImportRecord = {
  id: string;
  importBatchId: string;
  sourceSystem: "cabcher";
  sourceReferenceRaw: string | null;
  sourceAccountRaw: string | null;
  customerEmail: string;
  customerPhone: string | null;
  customerNameRaw: string;
  customerGivenName: string | null;
  customerSurname: string | null;
  serviceDateTime: string;
  pickupText: string;
  dropoffText: string;
  vehicleClassRaw: string | null;
  paymentMethodRaw: string | null;
  totalFareAmount: number | null;
  currency: string | null;
  isFuture: boolean;
  inferredTemporalStatus: TemporalStatus;
  customerId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DerivedCustomerRecord = {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  givenName: string | null;
  surname: string | null;
  bookingCountTotal: number;
  bookingCountPast: number;
  bookingCountUpcoming: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  nextBookingAt: string | null;
  lastPickupText: string | null;
  lastDropoffText: string | null;
  preferredVehicleRaw: string | null;
  lastPaymentMethodRaw: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CabcherImportSummary = {
  totalRowsParsed: number;
  bookingsImported: number;
  customersCreated: number;
  customersUpdated: number;
  rejectedRows: number;
  distinctVehicleRawValues: string[];
  distinctPaymentRawValues: string[];
  failures: string[];
  rejectedRowSamples: RowRejection[];
};

export type CabcherImportResult = {
  batch: ImportBatchRecord;
  summary: CabcherImportSummary;
};

export class MissingRequiredColumnsError extends Error {
  readonly missingColumns: string[];

  constructor(missingColumns: string[]) {
    super(`Missing required columns: ${missingColumns.join(", ")}`);
    this.name = "MissingRequiredColumnsError";
    this.missingColumns = missingColumns;
  }
}

type ImportInput = {
  csvContent: string;
  originalFilename: string;
  uploadedBy: string | null;
  now?: Date;
};

type ParsedRow = {
  rowNumber: number;
  values: string[];
};

type HeaderResolution = {
  indexByKey: Record<string, number>;
};

let importBatchSequence = 1;
let bookingSequence = 1;
let customerSequence = 1;

const importBatches: ImportBatchRecord[] = [];
const bookings: BookingImportRecord[] = [];
const customersByEmail = new Map<string, DerivedCustomerRecord>();

const COLUMN_ALIASES: Record<string, string[]> = {
  name: ["Name"],
  email: ["Email", "E-mail"],
  dateTime: ["Date & Time", "Date and Time", "Date Time"],
  pickup: ["Pick Up", "Pickup", "Pick-up"],
  dropoff: ["Drop Off", "Dropoff", "Drop-off"],
  contactNo: ["Contact No.", "Contact No", "Phone", "Contact Number"],
  vehicle: ["Vehicle"],
  payment: ["Payment", "Payment Method"],
  totalFare: ["Total Fare", "Fare", "Total"],
  account: ["Account"],
  orderNo: ["Order No.", "Order No", "Order", "Reference"]
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const hasLeadingPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");

  if (!digits) {
    return null;
  }

  return hasLeadingPlus ? `+${digits}` : digits;
}

function splitName(fullName: string): { givenName: string | null; surname: string | null } {
  const normalized = fullName.trim().replace(/\s+/g, " ");

  if (!normalized) {
    return { givenName: null, surname: null };
  }

  const parts = normalized.split(" ");

  if (parts.length === 1) {
    return { givenName: parts[0], surname: null };
  }

  return {
    givenName: parts.slice(0, -1).join(" "),
    surname: parts[parts.length - 1]
  };
}

function parseDateTime(value: string): Date | null {
  const input = value.trim();

  if (!input) {
    return null;
  }

  const isoDate = new Date(input);
  if (!Number.isNaN(isoDate.getTime())) {
    return isoDate;
  }

  const ukPattern = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  const match = input.match(ukPattern);

  if (!match) {
    return null;
  }

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const hours = Number.parseInt(match[4] || "0", 10);
  const minutes = Number.parseInt(match[5] || "0", 10);
  const seconds = Number.parseInt(match[6] || "0", 10);

  const parsed = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function parseFare(value: string): { amount: number | null; currency: string | null } {
  const trimmed = value.trim();

  if (!trimmed) {
    return { amount: null, currency: null };
  }

  const normalized = trimmed.replace(/,/g, "").replace(/[£]/g, "").trim();
  const parsed = Number.parseFloat(normalized);

  if (!Number.isFinite(parsed)) {
    return { amount: null, currency: null };
  }

  return {
    amount: parsed,
    currency: "GBP"
  };
}

function parseCsvRows(csvContent: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentValue = "";
  let inQuotes = false;

  for (let index = 0; index < csvContent.length; index += 1) {
    const char = csvContent[index];
    const next = csvContent[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentValue += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }

      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = "";
      continue;
    }

    currentValue += char;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  return rows;
}

function resolveHeaders(headers: string[]): HeaderResolution {
  const normalizedIndex = new Map<string, number>();

  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (!normalizedIndex.has(normalized)) {
      normalizedIndex.set(normalized, index);
    }
  });

  const resolve = (aliases: string[]): number => {
    for (const alias of aliases) {
      const hit = normalizedIndex.get(normalizeHeader(alias));
      if (typeof hit === "number") {
        return hit;
      }
    }

    return -1;
  };

  const indexByKey: Record<string, number> = {
    name: resolve(COLUMN_ALIASES.name),
    email: resolve(COLUMN_ALIASES.email),
    dateTime: resolve(COLUMN_ALIASES.dateTime),
    pickup: resolve(COLUMN_ALIASES.pickup),
    dropoff: resolve(COLUMN_ALIASES.dropoff),
    contactNo: resolve(COLUMN_ALIASES.contactNo),
    vehicle: resolve(COLUMN_ALIASES.vehicle),
    payment: resolve(COLUMN_ALIASES.payment),
    totalFare: resolve(COLUMN_ALIASES.totalFare),
    account: resolve(COLUMN_ALIASES.account),
    orderNo: resolve(COLUMN_ALIASES.orderNo)
  };

  const missingRequired = REQUIRED_COLUMNS.filter((column) => {
    const key = column === "Date & Time"
      ? "dateTime"
      : column === "Pick Up"
        ? "pickup"
        : column === "Drop Off"
          ? "dropoff"
          : normalizeHeader(column);

    return indexByKey[key] < 0;
  });

  if (missingRequired.length > 0) {
    throw new MissingRequiredColumnsError(missingRequired as string[]);
  }

  return { indexByKey };
}

function getCell(values: string[], index: number): string {
  if (index < 0 || index >= values.length) {
    return "";
  }

  return String(values[index] || "").trim();
}

function isRowEmpty(values: string[]): boolean {
  return values.every((value) => !String(value || "").trim());
}

function mostCommonNonEmpty(values: Array<string | null>): string | null {
  const score = new Map<string, number>();

  values.forEach((value) => {
    if (!value) {
      return;
    }

    score.set(value, (score.get(value) || 0) + 1);
  });

  let winner: string | null = null;
  let bestCount = 0;

  score.forEach((count, value) => {
    if (count > bestCount) {
      winner = value;
      bestCount = count;
    }
  });

  return winner;
}

function deriveCustomerFromBookings(email: string, groupedBookings: BookingImportRecord[], nowIso: string): DerivedCustomerRecord {
  const sortedAsc = [...groupedBookings].sort((left, right) => left.serviceDateTime.localeCompare(right.serviceDateTime));
  const sortedDesc = [...sortedAsc].reverse();

  const existing = customersByEmail.get(email);
  const mostRecentWithName = sortedDesc.find((booking) => booking.customerNameRaw)?.customerNameRaw || email;
  const mostRecentWithPhone = sortedDesc.find((booking) => booking.customerPhone)?.customerPhone || null;
  const { givenName, surname } = splitName(mostRecentWithName);

  const pastBookings = sortedAsc.filter((booking) => booking.inferredTemporalStatus === "past");
  const upcomingBookings = sortedAsc.filter((booking) => booking.inferredTemporalStatus === "upcoming");
  const lastPast = pastBookings.length > 0 ? pastBookings[pastBookings.length - 1] : null;

  const preferredVehicle = mostCommonNonEmpty(sortedAsc.map((booking) => booking.vehicleClassRaw));
  const firstSeen = sortedAsc[0]?.serviceDateTime || null;
  const lastSeen = lastPast?.serviceDateTime || null;
  const nextBooking = upcomingBookings[0]?.serviceDateTime || null;
  const lastPaymentMethod = sortedDesc.find((booking) => booking.paymentMethodRaw)?.paymentMethodRaw || null;

  const id = existing?.id || `imp-cust-${customerSequence++}`;

  return {
    id,
    email,
    phone: mostRecentWithPhone,
    fullName: mostRecentWithName,
    givenName,
    surname,
    bookingCountTotal: sortedAsc.length,
    bookingCountPast: pastBookings.length,
    bookingCountUpcoming: upcomingBookings.length,
    firstSeenAt: firstSeen,
    lastSeenAt: lastSeen,
    nextBookingAt: nextBooking,
    lastPickupText: lastPast?.pickupText || null,
    lastDropoffText: lastPast?.dropoffText || null,
    preferredVehicleRaw: preferredVehicle,
    lastPaymentMethodRaw: lastPaymentMethod,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso
  };
}

function deriveCustomersByEmail(emails: Set<string>, nowIso: string): { created: number; updated: number } {
  let created = 0;
  let updated = 0;

  for (const email of emails) {
    const groupedBookings = bookings.filter((booking) => booking.customerEmail === email);

    if (groupedBookings.length === 0) {
      continue;
    }

    const existed = customersByEmail.has(email);
    const derived = deriveCustomerFromBookings(email, groupedBookings, nowIso);
    customersByEmail.set(email, derived);

    groupedBookings.forEach((booking) => {
      booking.customerId = derived.id;
      booking.updatedAt = nowIso;
    });

    if (existed) {
      updated += 1;
    } else {
      created += 1;
    }
  }

  return { created, updated };
}

export function importCabcherBookings(input: ImportInput): CabcherImportResult {
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const batch: ImportBatchRecord = {
    id: `imp-batch-${importBatchSequence++}`,
    sourceType: CABCHER_SOURCE_TYPE,
    originalFilename: input.originalFilename,
    uploadedBy: input.uploadedBy,
    uploadedAt: nowIso,
    status: "uploaded",
    totalRows: 0,
    importedRows: 0,
    rejectedRows: 0,
    notes: null
  };

  importBatches.unshift(batch);

  const parsedRows = parseCsvRows(input.csvContent).filter((row) => row.length > 0);

  if (parsedRows.length === 0) {
    batch.status = "failed";
    batch.notes = "Uploaded file is empty.";

    return {
      batch,
      summary: {
        totalRowsParsed: 0,
        bookingsImported: 0,
        customersCreated: 0,
        customersUpdated: 0,
        rejectedRows: 0,
        distinctVehicleRawValues: [],
        distinctPaymentRawValues: [],
        failures: ["Uploaded file is empty."],
        rejectedRowSamples: []
      }
    };
  }

  const headerRow = parsedRows[0].map((value) => String(value || "").trim());
  const dataRows: ParsedRow[] = parsedRows.slice(1).map((values, index) => ({
    rowNumber: index + 2,
    values
  }));

  let headerResolution: HeaderResolution;

  try {
    headerResolution = resolveHeaders(headerRow);
  } catch (error) {
    if (error instanceof MissingRequiredColumnsError) {
      batch.status = "failed";
      batch.notes = error.message;
      throw error;
    }

    throw error;
  }

  batch.status = "parsed";

  const importedEmails = new Set<string>();
  const rejectedRows: RowRejection[] = [];
  const distinctVehicles = new Set<string>();
  const distinctPayments = new Set<string>();
  const duplicateGuard = new Set<string>();

  for (const row of dataRows) {
    if (isRowEmpty(row.values)) {
      continue;
    }

    const nameRaw = getCell(row.values, headerResolution.indexByKey.name);
    const emailRaw = getCell(row.values, headerResolution.indexByKey.email);
    const dateTimeRaw = getCell(row.values, headerResolution.indexByKey.dateTime);
    const pickupRaw = getCell(row.values, headerResolution.indexByKey.pickup);
    const dropoffRaw = getCell(row.values, headerResolution.indexByKey.dropoff);

    const email = normalizeEmail(emailRaw);

    if (!nameRaw || !email || !pickupRaw || !dropoffRaw || !dateTimeRaw) {
      rejectedRows.push({
        rowNumber: row.rowNumber,
        reason: "Missing required field value(s) in row."
      });
      continue;
    }

    const serviceDate = parseDateTime(dateTimeRaw);

    if (!serviceDate) {
      rejectedRows.push({
        rowNumber: row.rowNumber,
        reason: `Invalid Date & Time value: ${dateTimeRaw}`
      });
      continue;
    }

    const serviceDateTime = serviceDate.toISOString();
    const sourceReferenceRaw = getCell(row.values, headerResolution.indexByKey.orderNo) || null;
    const sourceAccountRaw = getCell(row.values, headerResolution.indexByKey.account) || null;
    const customerPhone = normalizePhone(getCell(row.values, headerResolution.indexByKey.contactNo));
    const vehicleClassRaw = getCell(row.values, headerResolution.indexByKey.vehicle) || null;
    const paymentMethodRaw = getCell(row.values, headerResolution.indexByKey.payment) || null;
    const fare = parseFare(getCell(row.values, headerResolution.indexByKey.totalFare));
    const nameSplit = splitName(nameRaw);
    const isFuture = serviceDate.getTime() > now.getTime();
    const inferredTemporalStatus: TemporalStatus = isFuture ? "upcoming" : "past";

    const dedupeKey = [
      email,
      serviceDateTime,
      pickupRaw.toLowerCase(),
      dropoffRaw.toLowerCase(),
      sourceReferenceRaw || ""
    ].join("|");

    if (duplicateGuard.has(dedupeKey)) {
      rejectedRows.push({
        rowNumber: row.rowNumber,
        reason: "Duplicate row detected in this batch."
      });
      continue;
    }

    duplicateGuard.add(dedupeKey);

    const booking: BookingImportRecord = {
      id: `imp-book-${bookingSequence++}`,
      importBatchId: batch.id,
      sourceSystem: "cabcher",
      sourceReferenceRaw,
      sourceAccountRaw,
      customerEmail: email,
      customerPhone,
      customerNameRaw: nameRaw,
      customerGivenName: nameSplit.givenName,
      customerSurname: nameSplit.surname,
      serviceDateTime,
      pickupText: pickupRaw,
      dropoffText: dropoffRaw,
      vehicleClassRaw,
      paymentMethodRaw,
      totalFareAmount: fare.amount,
      currency: fare.currency,
      isFuture,
      inferredTemporalStatus,
      customerId: null,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    bookings.push(booking);
    importedEmails.add(email);

    if (vehicleClassRaw) {
      distinctVehicles.add(vehicleClassRaw);
    }

    if (paymentMethodRaw) {
      distinctPayments.add(paymentMethodRaw);
    }
  }

  const totalRowsParsed = dataRows.filter((row) => !isRowEmpty(row.values)).length;
  const importedRows = totalRowsParsed - rejectedRows.length;

  batch.totalRows = totalRowsParsed;
  batch.importedRows = importedRows;
  batch.rejectedRows = rejectedRows.length;

  const customerStats = deriveCustomersByEmail(importedEmails, nowIso);

  batch.status = "imported";
  batch.notes = importedRows > 0
    ? `Imported ${importedRows} bookings and derived ${customerStats.created + customerStats.updated} customer aggregates.`
    : "No rows were imported from this file.";

  return {
    batch,
    summary: {
      totalRowsParsed,
      bookingsImported: importedRows,
      customersCreated: customerStats.created,
      customersUpdated: customerStats.updated,
      rejectedRows: rejectedRows.length,
      distinctVehicleRawValues: [...distinctVehicles].sort((left, right) => left.localeCompare(right)),
      distinctPaymentRawValues: [...distinctPayments].sort((left, right) => left.localeCompare(right)),
      failures: [],
      rejectedRowSamples: rejectedRows.slice(0, 20)
    }
  };
}

export function listImportBatches(): ImportBatchRecord[] {
  return [...importBatches];
}

export function listImportedBookingsForCustomer(customerId: string): BookingImportRecord[] {
  return bookings
    .filter((booking) => booking.customerId === customerId)
    .sort((left, right) => right.serviceDateTime.localeCompare(left.serviceDateTime));
}

export function listDerivedCustomers(): DerivedCustomerRecord[] {
  return [...customersByEmail.values()]
    .sort((left, right) => left.email.localeCompare(right.email));
}

export function getDerivedCustomerById(customerId: string): DerivedCustomerRecord | undefined {
  return listDerivedCustomers().find((customer) => customer.id === customerId);
}
