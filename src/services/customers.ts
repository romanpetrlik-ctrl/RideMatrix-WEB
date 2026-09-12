import type { Pool, PoolClient } from "pg";
import { getPool } from "../database/connection";
import { addCalendarMonths, readCustomerRetentionPolicy } from "./customer-retention-config";
import { normalizePhoneToE164 } from "./phone-numbers";

type Queryable = Pool | PoolClient;

export const CUSTOMER_STATUS_OPTIONS = [
  "all",
  "Active",
  "Suspended"
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

export async function listRecentBookingsForCustomer(
  customerId: string,
  client?: Queryable
): Promise<BookingRecord[]> {
  const runner = client || getPool();
  const result = await runner.query<{
    id: string;
    reference: string;
    service_date: string;
    pickup: string;
    dropoff: string;
    status: BookingRecord["status"];
  }>(
    `SELECT id, reference, service_date, pickup, dropoff, status
     FROM (
       SELECT id, reference, service_date, pickup, dropoff, status
       FROM customer_bookings
       WHERE customer_id = $1
       UNION ALL
       SELECT
         id,
         'RM-HIST-' || REPLACE(id, 'imp-book-', ''),
         service_date_time,
         pickup_text,
         dropoff_text,
         CASE WHEN service_date_time > NOW()::text THEN 'Scheduled' ELSE 'Completed' END
       FROM imported_bookings
       WHERE customer_id = $1
     ) AS customer_booking_history
     ORDER BY service_date DESC
     LIMIT 5`,
    [customerId]
  );

  return result.rows.map((booking) => ({
    id: booking.id,
    reference: booking.reference,
    serviceDate: booking.service_date,
    pickup: booking.pickup,
    dropoff: booking.dropoff,
    status: booking.status
  }));
}

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
  inactiveAt: string | null;
  anonymizedAt: string | null;
  erasureRequestedAt: string | null;
  retentionHoldUntil: string | null;
  retentionHoldReason: string | null;
  purgeAfter: string | null;
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
  latitude: number | null;
  longitude: number | null;
  geocodedAt: string | null;
  geocodeStatus: string | null;
  bookings: BookingRecord[];
};

export type CustomerListParams = {
  search: string;
  status: CustomerStatus;
  page: number;
  perPage: number;
  includeInactive?: boolean;
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
  latitude: number | null;
  longitude: number | null;
  geocoded_at: string | null;
  geocode_status: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  last_booking_at: string | null;
  inactive_at: string | null;
  anonymized_at: string | null;
  erasure_requested_at: string | null;
  retention_hold_until: string | null;
  retention_hold_reason: string | null;
  purge_after: string | null;
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

export class InvalidCustomerStatusError extends Error {
  constructor(readonly status: string) {
    super(`Unsupported customer status: ${status}. Only Active and Suspended are allowed.`);
    this.name = "InvalidCustomerStatusError";
  }
}

const PREFERRED_CONTACT_VALUES: PreferredContact[] = ["WhatsApp", "Email", "Phone", "Unknown"];

function normalizePreferredContact(value: string | null | undefined): PreferredContact {
  return PREFERRED_CONTACT_VALUES.includes(value as PreferredContact)
    ? (value as PreferredContact)
    : "Unknown";
}

function normalizeStatus(value: string | null | undefined): Exclude<CustomerStatus, "all"> {
  if (value === "Active" || value === "Suspended") {
    return value;
  }
  return "Suspended";
}

function validateStatus(value: string | null | undefined): Exclude<CustomerStatus, "all"> {
  if (value === "Active" || value === "Suspended") {
    return value;
  }
  throw new InvalidCustomerStatusError(String(value));
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
    inactiveAt: row.inactive_at,
    anonymizedAt: row.anonymized_at,
    erasureRequestedAt: row.erasure_requested_at,
    retentionHoldUntil: row.retention_hold_until,
    retentionHoldReason: row.retention_hold_reason,
    purgeAfter: row.purge_after,
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
    latitude: typeof row.latitude === "number" ? row.latitude : null,
    longitude: typeof row.longitude === "number" ? row.longitude : null,
    geocodedAt: row.geocoded_at,
    geocodeStatus: row.geocode_status,
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

  if (!params.includeInactive) {
    conditions.push("inactive_at IS NULL", "anonymized_at IS NULL", "erasure_requested_at IS NULL");
  }

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
        last_login_at, last_booking_at, deleted_at,
        inactive_at, anonymized_at, erasure_requested_at, retention_hold_until, retention_hold_reason, purge_after
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      )`,
      [
        id,
        trimOrNull(input.title),
        String(input.givenName || "").trim(),
        String(input.surname || "").trim(),
        email,
        normalizedEmail,
        normalizePhoneToE164(String(input.phone || "")),
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
        validateStatus(input.status || "Active"),
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

    values.push(
      inputKey === "phone"
        ? normalizePhoneToE164(String(value || ""))
        : trimOrNull(value as string | null)
    );
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
    values.push(validateStatus(input.status));
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
    "SELECT * FROM customers WHERE email_normalized = $1 AND deleted_at IS NULL AND inactive_at IS NULL AND anonymized_at IS NULL AND erasure_requested_at IS NULL LIMIT 1",
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
    `UPDATE customers SET last_booking_at = GREATEST(COALESCE(last_booking_at, $1), $1),
      inactive_at = CASE WHEN erasure_requested_at IS NULL
        AND (retention_hold_until IS NULL OR retention_hold_until <= $2) THEN NULL ELSE inactive_at END,
      updated_at = $2 WHERE id = $3 AND deleted_at IS NULL`,
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

export function latestRelevantRideAt(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) || null;
}

export function isRetentionHoldActive(
  retentionHoldUntil: string | null | undefined,
  now: Date = new Date()
): boolean {
  return Boolean(retentionHoldUntil && new Date(retentionHoldUntil).getTime() > now.getTime());
}

export function calculateInactiveAt(
  latestRideAt: string | null,
  createdAt: string,
  now: Date = new Date(),
  months = readCustomerRetentionPolicy().inactivityMonths
): string | null {
  const reference = latestRideAt || createdAt;
  return new Date(reference).getTime() <= addCalendarMonths(now, -months).getTime()
    ? addCalendarMonths(new Date(reference), months).toISOString()
    : null;
}

export function calculatePurgeAfter(
  latestRideAt: string | null,
  createdAt: string,
  months = readCustomerRetentionPolicy().retentionMonths
): string {
  return addCalendarMonths(new Date(latestRideAt || createdAt), months).toISOString();
}

export function isAnonymizationEligible(
  customer: Pick<CustomerRecord, "purgeAfter" | "anonymizedAt" | "retentionHoldUntil">,
  now: Date = new Date()
): boolean {
  return !customer.anonymizedAt &&
    Boolean(customer.purgeAfter && new Date(customer.purgeAfter).getTime() <= now.getTime()) &&
    !isRetentionHoldActive(customer.retentionHoldUntil, now);
}

export async function markInactiveCustomers(
  client?: Queryable,
  now: Date = new Date(),
  months = readCustomerRetentionPolicy().inactivityMonths,
  retentionMonths = readCustomerRetentionPolicy().retentionMonths
): Promise<number> {
  const runner = client || getPool();
  const cutoff = addCalendarMonths(now, -months).toISOString();
  const result = await runner.query(
    `UPDATE customers c SET inactive_at = COALESCE(c.inactive_at, $1),
       purge_after = COALESCE(c.purge_after,
         (COALESCE(
           c.last_booking_at,
           (SELECT MAX(service_date) FROM customer_bookings WHERE customer_id = c.id),
           (SELECT MAX(service_date_time) FROM imported_bookings WHERE customer_id = c.id),
           c.created_at
         )::timestamptz + ($4 || ' months')::interval)::text),
       updated_at = $1
     WHERE c.deleted_at IS NULL AND c.anonymized_at IS NULL AND c.erasure_requested_at IS NULL
       AND (c.retention_hold_until IS NULL OR c.retention_hold_until <= $1)
       AND COALESCE(
         c.last_booking_at,
         (SELECT MAX(service_date) FROM customer_bookings WHERE customer_id = c.id),
         (SELECT MAX(service_date_time) FROM imported_bookings WHERE customer_id = c.id),
         c.created_at
       ) <= $3
       AND c.inactive_at IS NULL`,
    [now.toISOString(), addCalendarMonths(now, months).toISOString(), cutoff, retentionMonths]
  );
  return result.rowCount || 0;
}

export async function requestCustomerErasure(id: string, client?: Queryable): Promise<boolean> {
  const runner = client || getPool();
  const now = new Date().toISOString();
  const result = await runner.query(
    `UPDATE customers SET erasure_requested_at = COALESCE(erasure_requested_at, $1),
      inactive_at = COALESCE(inactive_at, $1), updated_at = $1
     WHERE id = $2 AND deleted_at IS NULL AND anonymized_at IS NULL`,
    [now, id]
  );
  return (result.rowCount || 0) > 0;
}

export async function anonymizeCustomer(id: string, client?: Queryable): Promise<boolean> {
  const runner = client || getPool();
  const now = new Date().toISOString();
  await runner.query("BEGIN");
  try {
    const eligible = await runner.query(
      `SELECT id FROM customers
       WHERE id = $1 AND deleted_at IS NULL AND anonymized_at IS NULL
         AND purge_after IS NOT NULL AND purge_after <= $2
         AND (retention_hold_until IS NULL OR retention_hold_until <= $2)
       FOR UPDATE`,
      [id, now]
    );
    if (!eligible.rows[0]) {
      await runner.query("ROLLBACK");
      return false;
    }
    await runner.query(
      `UPDATE customers SET title = NULL, given_name = 'Anonymized', surname = 'Customer',
        email = NULL, email_normalized = NULL, phone = NULL, company = NULL, address = NULL,
        house_name_number = NULL, address_line1 = NULL, address_line2 = NULL, address_line3 = NULL,
        city_town = NULL, county = NULL, state = NULL, postcode = NULL, notes = NULL,
        latitude = NULL, longitude = NULL, geocoded_at = NULL, geocode_status = NULL,
        anonymized_at = $2, updated_at = $2 WHERE id = $1`,
      [id, now]
    );
    await runner.query(
      `UPDATE customer_bookings SET pickup = '[anonymized]', dropoff = '[anonymized]' WHERE customer_id = $1`,
      [id]
    );
    await runner.query(
      `UPDATE imported_bookings SET customer_email = 'anonymized@invalid', customer_phone = NULL,
        customer_name_raw = 'Anonymized Customer', customer_given_name = NULL, customer_surname = NULL,
        pickup_text = '[anonymized]', dropoff_text = '[anonymized]' WHERE customer_id = $1`,
      [id]
    );
    await runner.query(
      `UPDATE imported_customers SET email = 'anonymized-' || id || '@invalid',
        phone = NULL, full_name = 'Anonymized Customer', given_name = NULL, surname = NULL,
        last_pickup_text = NULL, last_dropoff_text = NULL WHERE id = $1`,
      [id]
    );
    await runner.query("COMMIT");
    return true;
  } catch (error) {
    await runner.query("ROLLBACK");
    throw error;
  }
}

export async function purgeCustomer(id: string, client?: Queryable): Promise<boolean> {
  const runner = client || getPool();
  await runner.query("BEGIN");
  try {
    const eligible = await runner.query(
      `SELECT id FROM customers WHERE id = $1 AND deleted_at IS NULL
       AND purge_after IS NOT NULL AND purge_after <= $2
       AND (retention_hold_until IS NULL OR retention_hold_until <= $2) FOR UPDATE`,
      [id, new Date().toISOString()]
    );
    if (!eligible.rows[0]) {
      await runner.query("ROLLBACK");
      return false;
    }
    await runner.query("DELETE FROM customer_bookings WHERE customer_id = $1", [id]);
    await runner.query("DELETE FROM imported_bookings WHERE customer_id = $1", [id]);
    await runner.query("DELETE FROM imported_customers WHERE id = $1", [id]);
    const result = await runner.query("DELETE FROM customers WHERE id = $1", [id]);
    await runner.query("COMMIT");
    return (result.rowCount || 0) > 0;
  } catch (error) {
    await runner.query("ROLLBACK");
    throw error;
  }
}

export async function processCustomerRetention(
  policy = readCustomerRetentionPolicy(),
  client?: Queryable
): Promise<{ inactive: number; anonymized: number; purged: number }> {
  const runner = client || getPool();
  const inactive = await markInactiveCustomers(runner, new Date(), policy.inactivityMonths, policy.retentionMonths);
  const candidates = await runner.query<{ id: string }>(
    `SELECT id FROM customers WHERE deleted_at IS NULL AND purge_after <= $1
      AND (retention_hold_until IS NULL OR retention_hold_until <= $1)
      AND anonymized_at IS NULL ORDER BY purge_after LIMIT 500`,
    [new Date().toISOString()]
  );
  let anonymized = 0;
  let purged = 0;
  for (const candidate of candidates.rows) {
    if (policy.purgeMode === "delete") {
      if (await purgeCustomer(candidate.id)) purged++;
    } else if (await anonymizeCustomer(candidate.id)) {
      anonymized++;
    }
  }
  return { inactive, anonymized, purged };
}

export async function getCustomerById(
  id: string,
  client?: Queryable,
  options?: { loadBookings?: boolean }
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

  if (options?.loadBookings === false) {
    return mapRow(row, []);
  }

  const records = await hydrate(runner, [row]);
  return records[0];
}

export async function getCustomerCount(client?: Queryable): Promise<number> {
  const runner = client || getPool();
  const res = await runner.query<{ total: string | number }>(
    "SELECT COUNT(*) AS total FROM customers WHERE deleted_at IS NULL AND inactive_at IS NULL AND anonymized_at IS NULL AND erasure_requested_at IS NULL"
  );

  return Number(res.rows[0]?.total ?? 0);
}
