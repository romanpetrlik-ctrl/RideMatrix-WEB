import type { Pool, PoolClient } from "pg";
import { getPool } from "../database/connection";

type Queryable = Pool | PoolClient;

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

type PgError = Error & {
  code?: string;
  constraint?: string;
};

const ACTIVE_CUSTOMER_EMAIL_UNIQUE_INDEX = "idx_customers_active_email_normalized_unique";

export class DuplicateActiveCustomerEmailError extends Error {
  constructor(readonly normalizedEmail: string) {
    super(`An active customer with email ${normalizedEmail} already exists.`);
    this.name = "DuplicateActiveCustomerEmailError";
  }
}

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

export function isActiveCustomerEmailUniqueViolation(
  error: unknown
): error is PgError {
  const pgError = error as PgError;
  return pgError?.code === "23505" && pgError.constraint === ACTIVE_CUSTOMER_EMAIL_UNIQUE_INDEX;
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

async function loadBookings(
  runner: Queryable,
  customerIds: string[]
): Promise<Map<string, BookingRecord[]>> {
  const grouped = new Map<string, BookingRecord[]>();

  if (customerIds.length === 0) {
    return grouped;
  }

  const ownBookingsRes = await runner.query<{
    id: string;
    customer_id: string;
    reference: string;
    service_date: string;
    pickup: string;
    dropoff: string;
    status: BookingRecord["status"];
  }>(
    `SELECT id, customer_id, reference, service_date, pickup, dropoff, status
     FROM customer_bookings
     WHERE customer_id = ANY($1)
     ORDER BY service_date DESC`,
    [customerIds]
  );

  for (const booking of ownBookingsRes.rows) {
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

  const importedBookingsRes = await runner.query<{
    id: string;
    customer_id: string;
    service_date_time: string;
    pickup_text: string;
    dropoff_text: string;
    inferred_temporal_status: string;
  }>(
    `SELECT id, customer_id, service_date_time, pickup_text, dropoff_text, inferred_temporal_status
     FROM imported_bookings
     WHERE customer_id = ANY($1)
     ORDER BY service_date_time DESC`,
    [customerIds]
  );

  const nowIso = new Date().toISOString();

  for (const booking of importedBookingsRes.rows) {
    const list = grouped.get(booking.customer_id) || [];
    list.push({
      id: booking.id,
      reference: `RM-HIST-${booking.id.replace("imp-book-", "")}`,
      serviceDate: booking.service_date_time,
      pickup: booking.pickup_text,
      dropoff: booking.dropoff_text,
      // The temporal status is derived on read so that imported bookings do not
      // stay "Scheduled" forever once their service date has passed.
      status: booking.service_date_time > nowIso ? "Scheduled" : "Completed"
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

async function hydrate(runner: Queryable, rows: CustomerRow[]): Promise<CustomerRecord[]> {
  const bookings = await loadBookings(runner, rows.map((row) => row.id));
  return rows.map((row) => mapRow(row, bookings.get(row.id) || []));
}

function generateCustomerId(): string {
  return `cust-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type FilterClause = {
  sql: string;
  params: any[];
};

function buildFilterClause(params: CustomerListParams): FilterClause {
  const conditions = ["deleted_at IS NULL"];
  const values: any[] = [];

  if (params.status !== "all") {
    values.push(params.status);
    conditions.push(`status = $${values.length}`);
  }

  const search = String(params.search || "").trim();

  if (search) {
    values.push(`%${escapeLike(search.toLowerCase())}%`);
    const searchIdx = values.length;

    const phoneSearch = normalizePhoneDigits(search);
    const searchConditions = [
      `lower(COALESCE(surname, '')) LIKE $${searchIdx} ESCAPE '\\'`,
      `lower(COALESCE(given_name, '')) LIKE $${searchIdx} ESCAPE '\\'`,
      `lower(COALESCE(email, '')) LIKE $${searchIdx} ESCAPE '\\'`,
      `lower(COALESCE(phone, '')) LIKE $${searchIdx} ESCAPE '\\'`
    ];

    if (phoneSearch) {
      values.push(`%${escapeLike(phoneSearch)}%`);
      const phoneIdx = values.length;
      searchConditions.push(`rm_normalize_phone(phone) LIKE $${phoneIdx} ESCAPE '\\'`);
    }

    conditions.push(`(${searchConditions.join(" OR ")})`);
  }

  return {
    sql: conditions.join(" AND "),
    params: values
  };
}

export async function createCustomer(
  input: CustomerCreateInput,
  client?: Queryable
): Promise<CustomerRecord> {
  const runner = client || getPool();
  const now = new Date().toISOString();
  const id = input.id || generateCustomerId();
  const email = trimOrNull(input.email);

  const normalizedEmail = normalizeCustomerEmail(email);

  try {
    await runner.query(
      `INSERT INTO customers (
        id, title, given_name, surname, email, email_normalized, phone, company, address,
        house_name_number, address_line1, address_line2, address_line3,
        city_town, county, state, postcode,
        preferred_contact, notes, status, source, created_at, updated_at,
        last_login_at, last_booking_at, deleted_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23,
        NULL, NULL, NULL
      )`,
      [
        id,
        trimOrNull(input.title),
        String(input.givenName || "").trim(),
        String(input.surname || "").trim(),
        email,
        normalizedEmail,
        trimOrNull(input.phone),
        trimOrNull(input.company),
        trimOrNull(input.address),
        trimOrNull(input.houseNameNumber),
        trimOrNull(input.addressLine1),
        trimOrNull(input.addressLine2),
        trimOrNull(input.addressLine3),
        trimOrNull(input.cityTown),
        trimOrNull(input.county),
        trimOrNull(input.state),
        trimOrNull(input.postcode),
        normalizePreferredContact(input.preferredContact),
        trimOrNull(input.notes),
        input.status || "Pending",
        input.source || "manual",
        now,
        now
      ]
    );
  } catch (error) {
    if (normalizedEmail && isActiveCustomerEmailUniqueViolation(error)) {
      throw new DuplicateActiveCustomerEmailError(normalizedEmail);
    }

    throw error;
  }

  const created = await getCustomerById(id, runner);

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

export async function updateCustomer(
  id: string,
  input: CustomerUpdateInput,
  client?: Queryable
): Promise<CustomerRecord | undefined> {
  const runner = client || getPool();
  const existing = await getCustomerById(id, runner);

  if (!existing) {
    return undefined;
  }

  const assignments: string[] = [];
  const values: any[] = [id]; // $1 is id

  for (const [inputKey, column] of UPDATABLE_COLUMNS) {
    const value = input[inputKey];

    if (value === undefined) {
      continue;
    }

    values.push(trimOrNull(value as string | null));
    assignments.push(`${column} = $${values.length}`);
  }

  if (input.email !== undefined) {
    const email = trimOrNull(input.email);
    values.push(email);
    assignments.push(`email = $${values.length}`);
    values.push(normalizeCustomerEmail(email));
    assignments.push(`email_normalized = $${values.length}`);
  }

  if (input.preferredContact !== undefined) {
    values.push(normalizePreferredContact(input.preferredContact));
    assignments.push(`preferred_contact = $${values.length}`);
  }

  if (input.status !== undefined) {
    values.push(normalizeStatus(input.status));
    assignments.push(`status = $${values.length}`);
  }

  values.push(new Date().toISOString());
  assignments.push(`updated_at = $${values.length}`);

  try {
    await runner.query(
      `UPDATE customers SET ${assignments.join(", ")} WHERE id = $1 AND deleted_at IS NULL`,
      values
    );
  } catch (error) {
    const normalizedEmail = normalizeCustomerEmail(input.email);
    if (normalizedEmail && isActiveCustomerEmailUniqueViolation(error)) {
      throw new DuplicateActiveCustomerEmailError(normalizedEmail);
    }

    throw error;
  }

  return getCustomerById(id, runner);
}

export async function getCustomerByEmail(
  email: string,
  client?: Queryable
): Promise<CustomerRecord | undefined> {
  const normalized = normalizeCustomerEmail(email);

  if (!normalized) {
    return undefined;
  }

  const runner = client || getPool();
  const res = await runner.query<CustomerRow>(
    "SELECT * FROM customers WHERE email_normalized = $1 AND deleted_at IS NULL LIMIT 1",
    [normalized]
  );

  const row = res.rows[0];
  if (!row) {
    return undefined;
  }

  const records = await hydrate(runner, [row]);
  return records[0];
}

export async function updateCustomerLastBookingAt(
  id: string,
  bookingAt: string,
  client?: Queryable
): Promise<CustomerRecord | undefined> {
  const runner = client || getPool();
  const result = await runner.query(
    "UPDATE customers SET last_booking_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL",
    [bookingAt, new Date().toISOString(), id]
  );

  if ((result.rowCount ?? 0) === 0) {
    return undefined;
  }

  return getCustomerById(id, runner);
}

/**
 * Soft-deletes a customer profile. Booking history is intentionally retained
 * for legal and compliance purposes, so only the customer profile is hidden
 * from the application.
 */
export async function deleteCustomer(id: string, client?: Queryable): Promise<boolean> {
  const runner = client || getPool();
  const result = await runner.query(
    "UPDATE customers SET deleted_at = $1, updated_at = $1 WHERE id = $2 AND deleted_at IS NULL",
    [new Date().toISOString(), id]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function listCustomers(
  params: CustomerListParams,
  client?: Queryable
): Promise<CustomerListResult> {
  const runner = client || getPool();
  const filter = buildFilterClause(params);

  const countRes = await runner.query<{ total: string | number }>(
    `SELECT COUNT(*) AS total FROM customers WHERE ${filter.sql}`,
    filter.params
  );

  const totalRecords = Number(countRes.rows[0]?.total ?? 0);

  const perPage = CUSTOMER_PER_PAGE_OPTIONS.includes(
    params.perPage as (typeof CUSTOMER_PER_PAGE_OPTIONS)[number]
  )
    ? params.perPage
    : CUSTOMER_DEFAULT_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(totalRecords / perPage));
  const page = Math.min(Math.max(1, params.page), totalPages);
  const offset = (page - 1) * perPage;

  const rowsParams = [...filter.params, perPage, offset];
  const limitParamIdx = rowsParams.length - 1;
  const offsetParamIdx = rowsParams.length;

  const rowsRes = await runner.query<CustomerRow>(
    `SELECT * FROM customers
     WHERE ${filter.sql}
     ORDER BY lower(surname) ASC, lower(given_name) ASC, id ASC
     LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
    rowsParams
  );

  const customers = await hydrate(runner, rowsRes.rows);

  return {
    customers,
    totalRecords,
    totalPages,
    page,
    perPage
  };
}

export async function getCustomerById(
  id: string,
  client?: Queryable
): Promise<CustomerRecord | undefined> {
  const runner = client || getPool();
  const res = await runner.query<CustomerRow>(
    "SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );

  const row = res.rows[0];
  if (!row) {
    return undefined;
  }

  const records = await hydrate(runner, [row]);
  return records[0];
}

export async function getCustomerCount(client?: Queryable): Promise<number> {
  const runner = client || getPool();
  const res = await runner.query<{ total: string | number }>(
    "SELECT COUNT(*) AS total FROM customers WHERE deleted_at IS NULL"
  );

  return Number(res.rows[0]?.total ?? 0);
}
