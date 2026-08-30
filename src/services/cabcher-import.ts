import type { Pool, PoolClient } from "pg";
import { getPool, withTransaction } from "../database/connection";

type Queryable = Pool | PoolClient;

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

type ImportBatchRow = {
  id: string;
  source_type: string;
  original_filename: string;
  uploaded_by: string | null;
  uploaded_at: string;
  status: string;
  total_rows: number;
  imported_rows: number;
  rejected_rows: number;
  notes: string | null;
};

type BookingRow = {
  id: string;
  import_batch_id: string;
  source_system: string;
  source_reference_raw: string | null;
  source_account_raw: string | null;
  customer_email: string;
  customer_phone: string | null;
  customer_name_raw: string;
  customer_given_name: string | null;
  customer_surname: string | null;
  service_date_time: string;
  pickup_text: string;
  dropoff_text: string;
  vehicle_class_raw: string | null;
  payment_method_raw: string | null;
  total_fare_amount: number | null;
  currency: string | null;
  is_future: number;
  inferred_temporal_status: string;
  customer_id: string | null;
  created_at: string;
  updated_at: string;
};

type DerivedCustomerRow = {
  id: string;
  email: string;
  phone: string | null;
  full_name: string;
  given_name: string | null;
  surname: string | null;
  booking_count_total: number;
  booking_count_past: number;
  booking_count_upcoming: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  next_booking_at: string | null;
  last_pickup_text: string | null;
  last_dropoff_text: string | null;
  preferred_vehicle_raw: string | null;
  last_payment_method_raw: string | null;
  created_at: string;
  updated_at: string;
};

async function nextSequenceValue(client: Queryable, name: string): Promise<number> {
  await client.query(
    "INSERT INTO id_sequences (name, value) VALUES ($1, 0) ON CONFLICT (name) DO NOTHING",
    [name]
  );
  const res = await client.query<{ value: string | number }>(
    "UPDATE id_sequences SET value = value + 1 WHERE name = $1 RETURNING value",
    [name]
  );

  return Number(res.rows[0].value);
}

function mapBatchRow(row: ImportBatchRow): ImportBatchRecord {
  return {
    id: row.id,
    sourceType: CABCHER_SOURCE_TYPE,
    originalFilename: row.original_filename,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    status: row.status as BatchStatus,
    totalRows: Number(row.total_rows),
    importedRows: Number(row.imported_rows),
    rejectedRows: Number(row.rejected_rows),
    notes: row.notes
  };
}

function mapBookingRow(row: BookingRow): BookingImportRecord {
  return {
    id: row.id,
    importBatchId: row.import_batch_id,
    sourceSystem: "cabcher",
    sourceReferenceRaw: row.source_reference_raw,
    sourceAccountRaw: row.source_account_raw,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    customerNameRaw: row.customer_name_raw,
    customerGivenName: row.customer_given_name,
    customerSurname: row.customer_surname,
    serviceDateTime: row.service_date_time,
    pickupText: row.pickup_text,
    dropoffText: row.dropoff_text,
    vehicleClassRaw: row.vehicle_class_raw,
    paymentMethodRaw: row.payment_method_raw,
    totalFareAmount: row.total_fare_amount !== null ? Number(row.total_fare_amount) : null,
    currency: row.currency,
    isFuture: Number(row.is_future) === 1,
    inferredTemporalStatus: row.inferred_temporal_status as TemporalStatus,
    customerId: row.customer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDerivedCustomerRow(row: DerivedCustomerRow): DerivedCustomerRecord {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    fullName: row.full_name,
    givenName: row.given_name,
    surname: row.surname,
    bookingCountTotal: Number(row.booking_count_total),
    bookingCountPast: Number(row.booking_count_past),
    bookingCountUpcoming: Number(row.booking_count_upcoming),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    nextBookingAt: row.next_booking_at,
    lastPickupText: row.last_pickup_text,
    lastDropoffText: row.last_dropoff_text,
    preferredVehicleRaw: row.preferred_vehicle_raw,
    lastPaymentMethodRaw: row.last_payment_method_raw,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function isBookingAlreadyImported(client: Queryable, dedupeKey: string): Promise<boolean> {
  const res = await client.query(
    "SELECT 1 FROM imported_bookings WHERE dedupe_key = $1 LIMIT 1",
    [dedupeKey]
  );

  return res.rows.length > 0;
}

async function insertBooking(
  client: Queryable,
  booking: BookingImportRecord,
  dedupeKey: string
): Promise<void> {
  await client.query(
    `INSERT INTO imported_bookings (
      id, import_batch_id, source_system, source_reference_raw, source_account_raw,
      customer_email, customer_phone, customer_name_raw, customer_given_name, customer_surname,
      service_date_time, pickup_text, dropoff_text, vehicle_class_raw, payment_method_raw,
      total_fare_amount, currency, is_future, inferred_temporal_status, customer_id,
      dedupe_key, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20,
      $21, $22, $23
    )`,
    [
      booking.id,
      booking.importBatchId,
      booking.sourceSystem,
      booking.sourceReferenceRaw,
      booking.sourceAccountRaw,
      booking.customerEmail,
      booking.customerPhone,
      booking.customerNameRaw,
      booking.customerGivenName,
      booking.customerSurname,
      booking.serviceDateTime,
      booking.pickupText,
      booking.dropoffText,
      booking.vehicleClassRaw,
      booking.paymentMethodRaw,
      booking.totalFareAmount,
      booking.currency,
      booking.isFuture ? 1 : 0,
      booking.inferredTemporalStatus,
      booking.customerId,
      dedupeKey,
      booking.createdAt,
      booking.updatedAt
    ]
  );
}

async function persistBatch(client: Queryable, batch: ImportBatchRecord): Promise<void> {
  await client.query(
    `INSERT INTO import_batches (
      id, source_type, original_filename, uploaded_by, uploaded_at,
      status, total_rows, imported_rows, rejected_rows, notes
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10
    )
    ON CONFLICT(id) DO UPDATE SET
      status = EXCLUDED.status,
      total_rows = EXCLUDED.total_rows,
      imported_rows = EXCLUDED.imported_rows,
      rejected_rows = EXCLUDED.rejected_rows,
      notes = EXCLUDED.notes`,
    [
      batch.id,
      batch.sourceType,
      batch.originalFilename,
      batch.uploadedBy,
      batch.uploadedAt,
      batch.status,
      batch.totalRows,
      batch.importedRows,
      batch.rejectedRows,
      batch.notes
    ]
  );
}

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

function deriveCustomerFromBookings(
  email: string,
  groupedBookings: BookingImportRecord[],
  nowIso: string,
  existing: DerivedCustomerRecord | undefined,
  resolveId: () => string
): DerivedCustomerRecord {
  const sortedAsc = [...groupedBookings].sort((left, right) => left.serviceDateTime.localeCompare(right.serviceDateTime));
  const sortedDesc = [...sortedAsc].reverse();

  const mostRecentWithName = sortedDesc.find((booking) => booking.customerNameRaw)?.customerNameRaw || email;
  const mostRecentWithPhone = sortedDesc.find((booking) => booking.customerPhone)?.customerPhone || null;
  const { givenName, surname } = splitName(mostRecentWithName);

  // Recomputed against the current run instead of the status stored at import
  // time, so aggregates stay correct once a service date has passed.
  const pastBookings = sortedAsc.filter((booking) => booking.serviceDateTime <= nowIso);
  const upcomingBookings = sortedAsc.filter((booking) => booking.serviceDateTime > nowIso);
  const lastPast = pastBookings.length > 0 ? pastBookings[pastBookings.length - 1] : null;

  const preferredVehicle = mostCommonNonEmpty(sortedAsc.map((booking) => booking.vehicleClassRaw));
  const firstSeen = sortedAsc[0]?.serviceDateTime || null;
  const lastSeen = lastPast?.serviceDateTime || null;
  const nextBooking = upcomingBookings[0]?.serviceDateTime || null;
  const lastPaymentMethod = sortedDesc.find((booking) => booking.paymentMethodRaw)?.paymentMethodRaw || null;

  const id = existing?.id || resolveId();

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

async function persistDerivedCustomer(
  client: Queryable,
  derived: DerivedCustomerRecord
): Promise<void> {
  await client.query(
    `INSERT INTO imported_customers (
      id, email, phone, full_name, given_name, surname,
      booking_count_total, booking_count_past, booking_count_upcoming,
      first_seen_at, last_seen_at, next_booking_at,
      last_pickup_text, last_dropoff_text, preferred_vehicle_raw, last_payment_method_raw,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9,
      $10, $11, $12,
      $13, $14, $15, $16,
      $17, $18
    )
    ON CONFLICT (email) DO UPDATE SET
      phone = EXCLUDED.phone,
      full_name = EXCLUDED.full_name,
      given_name = EXCLUDED.given_name,
      surname = EXCLUDED.surname,
      booking_count_total = EXCLUDED.booking_count_total,
      booking_count_past = EXCLUDED.booking_count_past,
      booking_count_upcoming = EXCLUDED.booking_count_upcoming,
      first_seen_at = EXCLUDED.first_seen_at,
      last_seen_at = EXCLUDED.last_seen_at,
      next_booking_at = EXCLUDED.next_booking_at,
      last_pickup_text = EXCLUDED.last_pickup_text,
      last_dropoff_text = EXCLUDED.last_dropoff_text,
      preferred_vehicle_raw = EXCLUDED.preferred_vehicle_raw,
      last_payment_method_raw = EXCLUDED.last_payment_method_raw,
      updated_at = EXCLUDED.updated_at`,
    [
      derived.id,
      derived.email,
      derived.phone,
      derived.fullName,
      derived.givenName,
      derived.surname,
      derived.bookingCountTotal,
      derived.bookingCountPast,
      derived.bookingCountUpcoming,
      derived.firstSeenAt,
      derived.lastSeenAt,
      derived.nextBookingAt,
      derived.lastPickupText,
      derived.lastDropoffText,
      derived.preferredVehicleRaw,
      derived.lastPaymentMethodRaw,
      derived.createdAt,
      derived.updatedAt
    ]
  );
}

/**
 * Keeps the master customer record in sync with an imported aggregate.
 *
 * Matching is done by normalized email, so importing the same file again (or a
 * newer export containing known customers) never creates duplicates. Customer
 * records that were created manually keep their own name and contact details.
 */
async function syncCustomerRecord(
  client: Queryable,
  derived: DerivedCustomerRecord
): Promise<void> {
  const existingRes = await client.query<{ id: string; source: string; deleted_at: string | null }>(
    "SELECT id, source, deleted_at FROM customers WHERE id = $1",
    [derived.id]
  );
  const existing = existingRes.rows[0];

  const notes = `Imported from Cabcher cleaned bookings. Total bookings: ${derived.bookingCountTotal}.`;
  const lastBookingAt = derived.lastSeenAt || derived.firstSeenAt;

  if (!existing) {
    await client.query(
      `INSERT INTO customers (
        id, title, given_name, surname, email, email_normalized, phone, company, address,
        preferred_contact, notes, status, source, created_at, updated_at,
        last_login_at, last_booking_at, deleted_at
      ) VALUES (
        $1, NULL, $2, $3, $4, $5, $6, NULL, NULL,
        $7, $8, 'Active', 'import', $9, $10,
        NULL, $11, NULL
      )`,
      [
        derived.id,
        derived.givenName || derived.fullName || "Imported",
        derived.surname || "Customer",
        derived.email,
        derived.email,
        derived.phone,
        derived.phone ? "Phone" : "Email",
        notes,
        derived.firstSeenAt || derived.createdAt,
        derived.updatedAt,
        lastBookingAt
      ]
    );

    return;
  }

  if (existing.source === "import") {
    await client.query(
      `UPDATE customers SET
        given_name = $1,
        surname = $2,
        phone = $3,
        notes = $4,
        last_booking_at = $5,
        updated_at = $6
      WHERE id = $7`,
      [
        derived.givenName || derived.fullName || "Imported",
        derived.surname || "Customer",
        derived.phone,
        notes,
        lastBookingAt,
        derived.updatedAt,
        derived.id
      ]
    );

    return;
  }

  // Manually maintained customer: only enrich missing contact data and the
  // last booking date, never overwrite curated fields.
  await client.query(
    `UPDATE customers SET
      phone = COALESCE(phone, $1),
      last_booking_at = COALESCE($2, last_booking_at),
      updated_at = $3
    WHERE id = $4`,
    [
      derived.phone,
      lastBookingAt,
      derived.updatedAt,
      derived.id
    ]
  );
}

async function deriveCustomersByEmail(
  client: Queryable,
  emails: Set<string>,
  nowIso: string
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const email of emails) {
    const bookingsRes = await client.query<BookingRow>(
      "SELECT * FROM imported_bookings WHERE customer_email = $1",
      [email]
    );
    const groupedBookings = bookingsRes.rows.map(mapBookingRow);

    if (groupedBookings.length === 0) {
      continue;
    }

    const existingRes = await client.query<DerivedCustomerRow>(
      "SELECT * FROM imported_customers WHERE email = $1",
      [email]
    );
    const existingRow = existingRes.rows[0];
    const existing = existingRow ? mapDerivedCustomerRow(existingRow) : undefined;

    let derivedId: string;
    if (existing?.id) {
      derivedId = existing.id;
    } else {
      const matchedRes = await client.query<{ id: string }>(
        "SELECT id FROM customers WHERE email_normalized = $1 LIMIT 1",
        [email]
      );
      if (matchedRes.rows[0]?.id) {
        derivedId = matchedRes.rows[0].id;
      } else {
        const seq = await nextSequenceValue(client, "imported_customer");
        derivedId = `imp-cust-${seq}`;
      }
    }

    const derived = deriveCustomerFromBookings(email, groupedBookings, nowIso, existing, () => derivedId);

    await persistDerivedCustomer(client, derived);
    await syncCustomerRecord(client, derived);

    await client.query(
      "UPDATE imported_bookings SET customer_id = $1, updated_at = $2 WHERE customer_email = $3",
      [derived.id, nowIso, email]
    );

    if (existing) {
      updated += 1;
    } else {
      created += 1;
    }
  }

  return { created, updated };
}

export async function importCabcherBookings(
  input: ImportInput,
  client?: Queryable
): Promise<CabcherImportResult> {
  const now = input.now || new Date();
  const nowIso = now.toISOString();

  const runWithClient = async (txClient: Queryable) => {
    const seq = await nextSequenceValue(txClient, "import_batch");
    const batch: ImportBatchRecord = {
      id: `imp-batch-${seq}`,
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

    await persistBatch(txClient, batch);

    const parsedRows = parseCsvRows(input.csvContent).filter((row) => row.length > 0);

    if (parsedRows.length === 0) {
      batch.status = "failed";
      batch.notes = "Uploaded file is empty.";
      await persistBatch(txClient, batch);

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
        await persistBatch(txClient, batch);
        throw error;
      }

      throw error;
    }

    batch.status = "parsed";
    await persistBatch(txClient, batch);

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

      if (await isBookingAlreadyImported(txClient, dedupeKey)) {
        duplicateGuard.add(dedupeKey);
        rejectedRows.push({
          rowNumber: row.rowNumber,
          reason: "Duplicate row already imported in an earlier batch."
        });
        continue;
      }

      duplicateGuard.add(dedupeKey);

      const bookingSeq = await nextSequenceValue(txClient, "imported_booking");
      const booking: BookingImportRecord = {
        id: `imp-book-${bookingSeq}`,
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

      await insertBooking(txClient, booking, dedupeKey);
      importedEmails.add(email);

      if (vehicleClassRaw) {
        distinctVehicles.add(vehicleClassRaw);
      }

      if (paymentMethodRaw) {
        distinctPayments.add(paymentMethodRaw);
      }
    }

    const customerStats = await deriveCustomersByEmail(txClient, importedEmails, nowIso);

    const totalRowsParsed = dataRows.filter((row) => !isRowEmpty(row.values)).length;
    const importedRows = totalRowsParsed - rejectedRows.length;

    batch.totalRows = totalRowsParsed;
    batch.importedRows = importedRows;
    batch.rejectedRows = rejectedRows.length;

    batch.status = "imported";
    batch.notes = importedRows > 0
      ? `Imported ${importedRows} bookings and derived ${customerStats.created + customerStats.updated} customer aggregates.`
      : "No rows were imported from this file.";

    await persistBatch(txClient, batch);

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
  };

  if (client) {
    return runWithClient(client);
  }

  return withTransaction(async (txClient) => runWithClient(txClient));
}

export async function listImportBatches(client?: Queryable): Promise<ImportBatchRecord[]> {
  const runner = client || getPool();
  const res = await runner.query<ImportBatchRow>(
    "SELECT * FROM import_batches ORDER BY uploaded_at DESC, id DESC"
  );

  return res.rows.map(mapBatchRow);
}

export async function listImportedBookingsForCustomer(
  customerId: string,
  client?: Queryable
): Promise<BookingImportRecord[]> {
  const runner = client || getPool();
  const res = await runner.query<BookingRow>(
    "SELECT * FROM imported_bookings WHERE customer_id = $1 ORDER BY service_date_time DESC",
    [customerId]
  );

  return res.rows.map(mapBookingRow);
}

export async function listDerivedCustomers(client?: Queryable): Promise<DerivedCustomerRecord[]> {
  const runner = client || getPool();
  const res = await runner.query<DerivedCustomerRow>(
    "SELECT * FROM imported_customers ORDER BY email ASC"
  );

  return res.rows.map(mapDerivedCustomerRow);
}

export async function getDerivedCustomerById(
  customerId: string,
  client?: Queryable
): Promise<DerivedCustomerRecord | undefined> {
  const runner = client || getPool();
  const res = await runner.query<DerivedCustomerRow>(
    "SELECT * FROM imported_customers WHERE id = $1",
    [customerId]
  );

  const row = res.rows[0];
  return row ? mapDerivedCustomerRow(row) : undefined;
}
