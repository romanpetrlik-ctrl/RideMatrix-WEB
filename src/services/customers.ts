import type { Database } from "better-sqlite3";
import { getDatabase } from "../database/connection";

export const CUSTOMER_STATUS_OPTIONS = [
  "all",
  "Active",
  "Suspended",
  "Pending",
  "Delete Pending"
] as const;

export const CUSTOMER_PER_PAGE_OPTIONS = [10, 25, 50] as const;
export const CUSTOMER_DEFAULT_PER_PAGE = 10;

export type CustomerStatus = (typeof CUSTOMER_STATUS_OPTIONS)[number];

export type PreferredContact = "WhatsApp" | "Email" | "Phone" | "Unknown";

export type BookingRecord = {
  id: string;
  reference: string;
  serviceDate: string;
  pickup: string;
  dropoff: string;
  status: "Scheduled" | "Completed" | "Cancelled";
};

export type CustomerRecord = {
  id: string;
  title: string | null;
  givenName: string;
  surname: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastBookingAt: string | null;
  status: Exclude<CustomerStatus, "all">;
  notes: string | null;
  address: string | null;
  houseNameNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  cityTown: string | null;
  county: string | null;
  state: string | null;
  postcode: string | null;
  company: string | null;
  preferredContact: PreferredContact;
  source: string;
  bookings: BookingRecord[];
};

export type CustomerListParams = {
  search: string;
  status: CustomerStatus;
  page: number;
  perPage: number;
};

export type CustomerListResult = {
  customers: CustomerRecord[];
  totalRecords: number;
  totalPages: number;
  page: number;
  perPage: number;
};

export type CustomerCreateInput = {
  id?: string;
  title?: string | null;
  givenName: string;
  surname: string;
  email: string | null;
  phone: string | null;
  notes?: string | null;
  address?: string | null;
  houseNameNumber?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  cityTown?: string | null;
  county?: string | null;
  state?: string | null;
  postcode?: string | null;
  company?: string | null;
  preferredContact?: PreferredContact;
  status?: Exclude<CustomerStatus, "all">;
  source?: string;
};

export type CustomerUpdateInput = Partial<Omit<CustomerCreateInput, "id">>;

type CustomerRow = {
  id: string;
  title: string | null;
  given_name: string;
  surname: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  address: string | null;
  house_name_number: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_line3: string | null;
  city_town: string | null;
  county: string | null;
  state: string | null;
  postcode: string | null;
  preferred_contact: string;
  notes: string | null;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  last_booking_at: string | null;
};

const PREFERRED_CONTACT_VALUES: PreferredContact[] = ["WhatsApp", "Email", "Phone", "Unknown"];

function normalizePreferredContact(value: string | null | undefined): PreferredContact {
  return PREFERRED_CONTACT_VALUES.includes(value as PreferredContact)
    ? (value as PreferredContact)
    : "Unknown";
}

function normalizeStatus(value: string | null | undefined): Exclude<CustomerStatus, "all"> {
  const allowed = CUSTOMER_STATUS_OPTIONS.filter((status) => status !== "all");
  return allowed.includes(value as Exclude<CustomerStatus, "all">)
    ? (value as Exclude<CustomerStatus, "all">)
    : "Pending";
}

function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

export function normalizeCustomerEmail(email: string | null | undefined): string | null {
  const trimmed = trimOrNull(email);
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizePhoneDigits(value: string | null | undefined): string {
  return String(value || "").replace(/[^\d+]/g, "").toLowerCase();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function mapRow(row: CustomerRow, bookings: BookingRecord[]): CustomerRecord {
  return {
    id: row.id,
    title: row.title,
    givenName: row.given_name,
    surname: row.surname,
    email: row.email,
    phone: row.phone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    lastBookingAt: row.last_booking_at,
    status: normalizeStatus(row.status),
    notes: row.notes,
    address: row.address,
    houseNameNumber: row.house_name_number,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    addressLine3: row.address_line3,
    cityTown: row.city_town,
    county: row.county,
    state: row.state,
    postcode: row.postcode,
    company: row.company,
    preferredContact: normalizePreferredContact(row.preferred_contact),
    source: row.source,
    bookings
  };
}

function loadBookings(database: Database, customerIds: string[]): Map<string, BookingRecord[]> {
  const grouped = new Map<string, BookingRecord[]>();

  if (customerIds.length === 0) {
    return grouped;
  }

  const placeholders = customerIds.map(() => "?").join(", ");

  const ownBookings = database
    .prepare(
      `SELECT id, customer_id, reference, service_date, pickup, dropoff, status
       FROM customer_bookings
       WHERE customer_id IN (${placeholders})
       ORDER BY service_date DESC`
    )
    .all(...customerIds) as Array<{
      id: string;
      customer_id: string;
      reference: string;
      service_date: string;
      pickup: string;
      dropoff: string;
      status: BookingRecord["status"];
    }>;

  for (const booking of ownBookings) {
    const list = grouped.get(booking.customer_id) || [];
    list.push({
      id: booking.id,
      reference: booking.reference,
      serviceDate: booking.service_date,
      pickup: booking.pickup,
      dropoff: booking.dropoff,
      status: booking.status
    });
    grouped.set(booking.customer_id, list);
  }

  const importedBookings = database
    .prepare(
      `SELECT id, customer_id, service_date_time, pickup_text, dropoff_text, inferred_temporal_status
       FROM imported_bookings
       WHERE customer_id IN (${placeholders})
       ORDER BY service_date_time DESC`
    )
    .all(...customerIds) as Array<{
      id: string;
      customer_id: string;
      service_date_time: string;
      pickup_text: string;
      dropoff_text: string;
      inferred_temporal_status: string;
    }>;

  for (const booking of importedBookings) {
    const list = grouped.get(booking.customer_id) || [];
    list.push({
      id: booking.id,
      reference: `RM-HIST-${booking.id.replace("imp-book-", "")}`,
      serviceDate: booking.service_date_time,
      pickup: booking.pickup_text,
      dropoff: booking.dropoff_text,
      status: booking.inferred_temporal_status === "upcoming" ? "Scheduled" : "Completed"
    });
    grouped.set(booking.customer_id, list);
  }

  for (const [customerId, list] of grouped) {
    grouped.set(
      customerId,
      list.sort((left, right) => right.serviceDate.localeCompare(left.serviceDate))
    );
  }

  return grouped;
}

function hydrate(database: Database, rows: CustomerRow[]): CustomerRecord[] {
  const bookings = loadBookings(database, rows.map((row) => row.id));
  return rows.map((row) => mapRow(row, bookings.get(row.id) || []));
}

function generateCustomerId(): string {
  return `cust-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type FilterClause = {
  sql: string;
  params: Record<string, string>;
};

function buildFilterClause(params: CustomerListParams): FilterClause {
  const conditions = ["deleted_at IS NULL"];
  const values: Record<string, string> = {};

  if (params.status !== "all") {
    conditions.push("status = @status");
    values.status = params.status;
  }

  const search = String(params.search || "").trim();

  if (search) {
    const like = `%${escapeLike(search.toLowerCase())}%`;
    values.like = like;

    const phoneSearch = normalizePhoneDigits(search);
    const searchConditions = [
      "lower(COALESCE(surname, '')) LIKE @like ESCAPE '\\'",
      "lower(COALESCE(given_name, '')) LIKE @like ESCAPE '\\'",
      "lower(COALESCE(email, '')) LIKE @like ESCAPE '\\'",
      "lower(COALESCE(phone, '')) LIKE @like ESCAPE '\\'"
    ];

    if (phoneSearch) {
      values.phoneLike = `%${escapeLike(phoneSearch)}%`;
      searchConditions.push("rm_normalize_phone(phone) LIKE @phoneLike ESCAPE '\\'");
    }

    conditions.push(`(${searchConditions.join(" OR ")})`);
  }

  return {
    sql: conditions.join(" AND "),
    params: values
  };
}

export function createCustomer(input: CustomerCreateInput): CustomerRecord {
  const database = getDatabase();
  const now = new Date().toISOString();
  const id = input.id || generateCustomerId();
  const email = trimOrNull(input.email);

  database
    .prepare(
      `INSERT INTO customers (
        id, title, given_name, surname, email, email_normalized, phone, company, address,
        house_name_number, address_line1, address_line2, address_line3,
        city_town, county, state, postcode,
        preferred_contact, notes, status, source, created_at, updated_at,
        last_login_at, last_booking_at, deleted_at
      ) VALUES (
        @id, @title, @givenName, @surname, @email, @emailNormalized, @phone, @company, @address,
        @houseNameNumber, @addressLine1, @addressLine2, @addressLine3,
        @cityTown, @county, @state, @postcode,
        @preferredContact, @notes, @status, @source, @createdAt, @updatedAt,
        NULL, NULL, NULL
      )`
    )
    .run({
      id,
      title: trimOrNull(input.title),
      givenName: String(input.givenName || "").trim(),
      surname: String(input.surname || "").trim(),
      email,
      emailNormalized: normalizeCustomerEmail(email),
      phone: trimOrNull(input.phone),
      company: trimOrNull(input.company),
      address: trimOrNull(input.address),
      houseNameNumber: trimOrNull(input.houseNameNumber),
      addressLine1: trimOrNull(input.addressLine1),
      addressLine2: trimOrNull(input.addressLine2),
      addressLine3: trimOrNull(input.addressLine3),
      cityTown: trimOrNull(input.cityTown),
      county: trimOrNull(input.county),
      state: trimOrNull(input.state),
      postcode: trimOrNull(input.postcode),
      preferredContact: normalizePreferredContact(input.preferredContact),
      notes: trimOrNull(input.notes),
      status: input.status || "Pending",
      source: input.source || "manual",
      createdAt: now,
      updatedAt: now
    });

  const created = getCustomerById(id);

  if (!created) {
    throw new Error(`Customer ${id} could not be persisted.`);
  }

  return created;
}

const UPDATABLE_COLUMNS: Array<[keyof CustomerUpdateInput, string]> = [
  ["title", "title"],
  ["givenName", "given_name"],
  ["surname", "surname"],
  ["phone", "phone"],
  ["company", "company"],
  ["address", "address"],
  ["houseNameNumber", "house_name_number"],
  ["addressLine1", "address_line1"],
  ["addressLine2", "address_line2"],
  ["addressLine3", "address_line3"],
  ["cityTown", "city_town"],
  ["county", "county"],
  ["state", "state"],
  ["postcode", "postcode"],
  ["notes", "notes"]
];

export function updateCustomer(id: string, input: CustomerUpdateInput): CustomerRecord | undefined {
  const database = getDatabase();
  const existing = getCustomerById(id);

  if (!existing) {
    return undefined;
  }

  const assignments: string[] = [];
  const values: Record<string, string | null> = { id };

  for (const [inputKey, column] of UPDATABLE_COLUMNS) {
    const value = input[inputKey];

    if (value === undefined) {
      continue;
    }

    assignments.push(`${column} = @${column}`);
    values[column] = trimOrNull(value as string | null);
  }

  if (input.email !== undefined) {
    const email = trimOrNull(input.email);
    assignments.push("email = @email", "email_normalized = @email_normalized");
    values.email = email;
    values.email_normalized = normalizeCustomerEmail(email);
  }

  if (input.preferredContact !== undefined) {
    assignments.push("preferred_contact = @preferred_contact");
    values.preferred_contact = normalizePreferredContact(input.preferredContact);
  }

  if (input.status !== undefined) {
    assignments.push("status = @status");
    values.status = normalizeStatus(input.status);
  }

  assignments.push("updated_at = @updated_at");
  values.updated_at = new Date().toISOString();

  database
    .prepare(`UPDATE customers SET ${assignments.join(", ")} WHERE id = @id AND deleted_at IS NULL`)
    .run(values);

  return getCustomerById(id);
}

export function getCustomerByEmail(email: string): CustomerRecord | undefined {
  const normalized = normalizeCustomerEmail(email);

  if (!normalized) {
    return undefined;
  }

  const database = getDatabase();
  const row = database
    .prepare("SELECT * FROM customers WHERE email_normalized = ? AND deleted_at IS NULL LIMIT 1")
    .get(normalized) as CustomerRow | undefined;

  return row ? hydrate(database, [row])[0] : undefined;
}

export function updateCustomerLastBookingAt(id: string, bookingAt: string): CustomerRecord | undefined {
  const database = getDatabase();
  const result = database
    .prepare(
      "UPDATE customers SET last_booking_at = @bookingAt, updated_at = @updatedAt WHERE id = @id AND deleted_at IS NULL"
    )
    .run({ id, bookingAt, updatedAt: new Date().toISOString() });

  if (result.changes === 0) {
    return undefined;
  }

  return getCustomerById(id);
}

/**
 * Soft-deletes a customer profile. Booking history is intentionally retained
 * for legal and compliance purposes, so only the customer profile is hidden
 * from the application.
 */
export function deleteCustomer(id: string): boolean {
  const database = getDatabase();
  const result = database
    .prepare(
      "UPDATE customers SET deleted_at = @deletedAt, updated_at = @deletedAt WHERE id = @id AND deleted_at IS NULL"
    )
    .run({ id, deletedAt: new Date().toISOString() });

  return result.changes > 0;
}

export function listCustomers(params: CustomerListParams): CustomerListResult {
  const database = getDatabase();
  const filter = buildFilterClause(params);

  const totalRecords = Number(
    (
      database
        .prepare(`SELECT COUNT(*) AS total FROM customers WHERE ${filter.sql}`)
        .get(filter.params) as { total: number }
    ).total
  );

  const perPage = CUSTOMER_PER_PAGE_OPTIONS.includes(params.perPage as (typeof CUSTOMER_PER_PAGE_OPTIONS)[number])
    ? params.perPage
    : CUSTOMER_DEFAULT_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(totalRecords / perPage));
  const page = Math.min(Math.max(1, params.page), totalPages);
  const offset = (page - 1) * perPage;

  const rows = database
    .prepare(
      `SELECT * FROM customers
       WHERE ${filter.sql}
       ORDER BY surname COLLATE NOCASE ASC, given_name COLLATE NOCASE ASC, id ASC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...filter.params, limit: perPage, offset }) as CustomerRow[];

  return {
    customers: hydrate(database, rows),
    totalRecords,
    totalPages,
    page,
    perPage
  };
}

export function getCustomerById(id: string): CustomerRecord | undefined {
  const database = getDatabase();
  const row = database
    .prepare("SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL")
    .get(id) as CustomerRow | undefined;

  return row ? hydrate(database, [row])[0] : undefined;
}

export function getCustomerCount(): number {
  const database = getDatabase();
  const row = database
    .prepare("SELECT COUNT(*) AS total FROM customers WHERE deleted_at IS NULL")
    .get() as { total: number };

  return Number(row.total);
}
