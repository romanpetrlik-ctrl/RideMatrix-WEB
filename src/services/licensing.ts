import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool, withTransaction } from "../database/connection";

type Queryable = Pool | PoolClient;
const db = (client?: Queryable): Queryable => client || getPool();

export type LicensingAuthority = {
  id: string;
  name: string;
  authorityType: string | null;
  active: boolean;
  preferenceOrder: number;
};

export type LicenseRecord = {
  id: string;
  licensingAuthorityId: string;
  licenseType: VehicleLicenseType | null;
  vehicleLicenseBadge: string | null;
  licenseReference: string | null;
  validFrom: string;
  validUntil: string | null;
  active: boolean;
  revokedAt: string | null;
};

export const VEHICLE_LICENSE_TYPES = ["hackney_carriage", "private_hire"] as const;
export type VehicleLicenseType = (typeof VEHICLE_LICENSE_TYPES)[number];

export type LicenseInput = {
  licensingAuthorityId: string;
  licenseType?: VehicleLicenseType | null;
  vehicleLicenseBadge?: string | null;
  licenseReference?: string | null;
  validFrom: string;
  validUntil?: string | null;
  notes?: string | null;
};

export type CompatibleAuthority = LicensingAuthority & {
  operatorLicenseReference: string | null;
  driverLicenseReference: string | null;
  vehicleLicenseReference: string | null;
};

export function isLicenseActive(
  license: Pick<LicenseRecord, "active" | "revokedAt" | "validFrom" | "validUntil">,
  atTime: Date | string
): boolean {
  const at = new Date(atTime).getTime();
  if (!Number.isFinite(at) || !license.active || license.revokedAt) return false;
  const from = new Date(license.validFrom).getTime();
  const until = license.validUntil ? new Date(license.validUntil).getTime() : Infinity;
  return Number.isFinite(from) && from <= at && until > at;
}

function authorityFromRow(row: any): LicensingAuthority {
  return {
    id: row.id,
    name: row.name,
    authorityType: row.authority_type ?? null,
    active: Boolean(row.active),
    preferenceOrder: Number(row.preference_order || 0)
  };
}

export function selectDeterministicAuthority<T extends { preferenceOrder: number; name: string; id: string }>(
  authorities: T[]
): T | null {
  return [...authorities].sort((a, b) =>
    a.preferenceOrder - b.preferenceOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  )[0] || null;
}

export async function listLicensingAuthorities(client?: Queryable): Promise<LicensingAuthority[]> {
  const result = await db(client).query(
    `SELECT id, name, authority_type, active, preference_order
       FROM licensing_authorities
      WHERE active = TRUE
      ORDER BY preference_order, lower(name), id`
  );
  return result.rows.map(authorityFromRow);
}

export async function listLicensingAuthoritiesForManagement(client?: Queryable): Promise<LicensingAuthority[]> {
  const result = await db(client).query(
    `SELECT id, name, authority_type, active, preference_order
       FROM licensing_authorities
      ORDER BY active DESC, preference_order, lower(name), id`
  );
  return result.rows.map(authorityFromRow);
}

export async function createLicensingAuthority(
  input: { id: string; name: string; authorityType?: string | null; preferenceOrder?: number },
  client?: Queryable
): Promise<LicensingAuthority> {
  const now = new Date().toISOString();
  const result = await db(client).query(
    `INSERT INTO licensing_authorities
       (id, name, authority_type, preference_order, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id, name, authority_type, active, preference_order`,
    [input.id.trim(), input.name.trim(), input.authorityType || null, input.preferenceOrder || 0, now]
  );
  return authorityFromRow(result.rows[0]);
}

const LICENSE_TABLES = {
  operator: ["operator_licensing_authorities", "operator_id"],
  driver: ["driver_licensing_authorities", "driver_id"],
  vehicle: ["vehicle_licensing_authorities", "vehicle_id"]
} as const;

export async function addLicense(
  subject: keyof typeof LICENSE_TABLES,
  subjectId: string,
  input: LicenseInput,
  client?: Queryable
): Promise<string> {
  const [table, column] = LICENSE_TABLES[subject];
  const id = randomUUID();
  const now = new Date().toISOString();
  if (subject === "vehicle") {
    validateVehicleLicenseInput(input);
    await db(client).query(
      `INSERT INTO ${table}
        (id, ${column}, licensing_authority_id, license_type, vehicle_license_badge,
         license_reference, valid_from, valid_until, active, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10,$10)`,
      [id, subjectId, input.licensingAuthorityId, input.licenseType,
        normalizeVehicleLicenseBadge(input.vehicleLicenseBadge), input.licenseReference || null,
        input.validFrom, input.validUntil || null, input.notes || null, now]
    );
  } else {
    await db(client).query(
      `INSERT INTO ${table}
        (id, ${column}, licensing_authority_id, license_reference, valid_from, valid_until,
         active, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, $8)`,
      [id, subjectId, input.licensingAuthorityId, input.licenseReference || null,
        input.validFrom, input.validUntil || null, input.notes || null, now]
    );
  }
  return id;
}

function normalizeVehicleLicenseBadge(value: unknown): string | null {
  const badge = String(value ?? "").trim();
  if (!badge) return null;
  if (badge.length > 64 || /[\u0000-\u001f\u007f]/.test(badge)) {
    throw new Error("Vehicle licence badge must be at most 64 characters and contain no control characters.");
  }
  return badge;
}

function validateVehicleLicenseInput<T extends LicenseInput>(
  input: T,
  allowUnspecifiedType = false
): asserts input is T & { licenseType: VehicleLicenseType | null | undefined } {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (input.licenseType && !VEHICLE_LICENSE_TYPES.includes(input.licenseType as VehicleLicenseType)) {
    throw new Error("Select Hackney Carriage or Private Hire as the vehicle licence type.");
  }
  if (!allowUnspecifiedType && !input.licenseType) {
    throw new Error("Select Hackney Carriage or Private Hire as the vehicle licence type.");
  }
  if (!input.licensingAuthorityId.trim()) throw new Error("Select a licensing authority.");
  if (!validDate(input.validFrom)) {
    throw new Error("Enter a valid licence start date.");
  }
  if (input.validUntil && (!validDate(input.validUntil) || input.validUntil <= input.validFrom)) {
    throw new Error("Licence end date must be after its start date.");
  }
  normalizeVehicleLicenseBadge(input.vehicleLicenseBadge);
}

export type VehicleLicenseRecord = LicenseRecord & {
  vehicleId: string;
  licensingAuthorityName: string;
  notes: string | null;
};

function vehicleLicenseFromRow(row: any): VehicleLicenseRecord {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    licensingAuthorityId: row.licensing_authority_id,
    licensingAuthorityName: row.authority_name,
    licenseType: row.license_type ?? null,
    vehicleLicenseBadge: row.vehicle_license_badge ?? null,
    licenseReference: row.license_reference ?? null,
    validFrom: row.valid_from,
    validUntil: row.valid_until ?? null,
    active: Boolean(row.active),
    revokedAt: row.revoked_at ?? null,
    notes: row.notes ?? null
  };
}

export async function listVehicleLicenses(vehicleId: string, client?: Queryable): Promise<VehicleLicenseRecord[]> {
  const result = await db(client).query(
    `SELECT vla.*, la.name AS authority_name
       FROM vehicle_licensing_authorities vla
       JOIN licensing_authorities la ON la.id = vla.licensing_authority_id
      WHERE vla.vehicle_id = $1
      ORDER BY vla.active DESC, vla.valid_from DESC, la.preference_order, lower(la.name), vla.id`,
    [vehicleId]
  );
  return result.rows.map(vehicleLicenseFromRow);
}

export async function saveVehicleLicense(
  vehicleId: string,
  input: LicenseInput & { clearVehicleLicenseBadge?: boolean },
  licenseId?: string,
  client?: Queryable
): Promise<string | null> {
  validateVehicleLicenseInput(input, Boolean(licenseId));
  const runner = db(client);
  const badge = normalizeVehicleLicenseBadge(input.vehicleLicenseBadge);
  const now = new Date().toISOString();
  if (licenseId) {
    const result = await runner.query(
      `UPDATE vehicle_licensing_authorities
          SET licensing_authority_id=$3,
              license_type=CASE WHEN $4::text IS NULL THEN license_type ELSE $4::text END,
              vehicle_license_badge=CASE WHEN $11::boolean THEN NULL
                WHEN $5::text IS NULL THEN vehicle_license_badge ELSE $5::text END,
              license_reference=$6, valid_from=$7, valid_until=$8, notes=$9,
              active=TRUE, revoked_at=NULL, updated_at=$10
        WHERE id=$1 AND vehicle_id=$2`,
      [licenseId, vehicleId, input.licensingAuthorityId, input.licenseType, badge,
        input.licenseReference?.trim() || null, input.validFrom, input.validUntil || null,
        input.notes?.trim() || null, now, Boolean(input.clearVehicleLicenseBadge)]
    );
    return result.rowCount ? licenseId : null;
  }
  const id = randomUUID();
  await runner.query(
    `INSERT INTO vehicle_licensing_authorities
      (id, vehicle_id, licensing_authority_id, license_type, vehicle_license_badge,
       license_reference, valid_from, valid_until, active, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10,$10)`,
    [id, vehicleId, input.licensingAuthorityId, input.licenseType, badge,
      input.licenseReference?.trim() || null, input.validFrom, input.validUntil || null,
      input.notes?.trim() || null, now]
  );
  return id;
}

export async function revokeLicense(
  subject: keyof typeof LICENSE_TABLES,
  licenseId: string,
  client?: Queryable
): Promise<void> {
  const [table] = LICENSE_TABLES[subject];
  const now = new Date().toISOString();
  await db(client).query(
    `UPDATE ${table} SET active = FALSE, revoked_at = $2, updated_at = $2 WHERE id = $1`,
    [licenseId, now]
  );
}

export type BookingAssignmentPage = {
  booking: {
    id: string;
    customerId: string;
    customerName: string;
    reference: string;
    serviceDate: string;
    pickup: string;
    dropoff: string;
    status: string;
    driverId: string | null;
    driverEmail: string | null;
    vehicleId: string | null;
    vehicleRegistration: string | null;
    licensingAuthorityId: string | null;
    licensingAuthorityName: string | null;
    vehicleLicenseType: VehicleLicenseType | null;
    vehicleLicenseBadge: string | null;
  };
  drivers: Array<{ id: string; email: string }>;
  vehicleLicenses: Array<{
    id: string;
    vehicleId: string;
    registration: string;
    licensingAuthorityId: string;
    licensingAuthorityName: string;
    licenseType: VehicleLicenseType;
    vehicleLicenseBadge: string | null;
  }>;
  commonAuthorities: LicensingAuthority[];
  auditHistory: Array<{
    action: string;
    assignedAt: string;
    licensingAuthorityName: string | null;
    vehicleLicenseType: VehicleLicenseType | null;
    vehicleLicenseBadge: string | null;
  }>;
};

export class BookingAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingAssignmentError";
  }
}

function serviceDate(value: string): string {
  const day = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00Z`) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new BookingAssignmentError("Booking service date is invalid.");
  }
  return day;
}

const OPERATOR_ASSIGNMENT_LICENCES = `
  SELECT ol.id, ol.licence_number, ol.licensing_authority_id
    FROM system_setup_state s
    JOIN operators o ON o.id = s.operator_id
    JOIN operator_licences ol ON ol.operator_id = o.id
    JOIN licensing_authorities a ON a.id = ol.licensing_authority_id AND a.active = TRUE
   WHERE s.setup_key = 'initial_system_setup' AND s.status = 'completed'
     AND ol.licence_type = 'pho' AND ol.status = 'active'
     AND ol.valid_from <= $1::date AND (ol.valid_to IS NULL OR ol.valid_to > $1::date)
     AND EXISTS (
       SELECT 1 FROM operator_licence_documents d
        WHERE d.licence_id = ol.id AND d.is_latest = TRUE
          AND d.content IS NOT NULL
     )`;

export async function getBookingAssignmentPage(
  bookingId: string,
  customerId: string,
  selection: { driverId?: string; vehicleLicenseId?: string; vehicleLicenseType?: VehicleLicenseType } = {},
  client?: Queryable
): Promise<BookingAssignmentPage | null> {
  const runner = db(client);
  const result = await runner.query<any>(
    `SELECT b.id, b.customer_id, c.given_name, c.surname, b.reference, b.service_date,
            b.pickup, b.dropoff, b.status, b.driver_id, du.email AS driver_email,
            b.vehicle_id, v.registration, b.licensing_authority_id, a.name AS authority_name,
            b.vehicle_license_type, b.vehicle_license_badge
       FROM customer_bookings b
       JOIN customers c ON c.id = b.customer_id
       LEFT JOIN users du ON du.id::text = b.driver_id
       LEFT JOIN vehicles v ON v.id = b.vehicle_id
       LEFT JOIN licensing_authorities a ON a.id = b.licensing_authority_id
      WHERE b.id = $1 AND b.customer_id = $2`,
    [bookingId, customerId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const date = serviceDate(row.service_date);
  const operators = await runner.query<{ id: string; licensing_authority_id: string }>(
    OPERATOR_ASSIGNMENT_LICENCES, [date]
  );
  const authorityIds = [...new Set(operators.rows.map((licence) => licence.licensing_authority_id))];

  let drivers: BookingAssignmentPage["drivers"] = [];
  let vehicleLicenses: BookingAssignmentPage["vehicleLicenses"] = [];
  if (authorityIds.length) {
    const driverResult = await runner.query<{ id: string; email: string }>(
      `SELECT DISTINCT u.id::text AS id, u.email
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id AND r.key = 'driver'
         JOIN driver_licensing_authorities dl ON dl.driver_id = u.id::text
        WHERE lower(u.status::text) = 'active' AND dl.licensing_authority_id = ANY($1::text[])
          AND dl.active = TRUE AND dl.revoked_at IS NULL
          AND dl.valid_from <= $2 AND (dl.valid_until IS NULL OR dl.valid_until > $2)
        ORDER BY email, id`,
      [authorityIds, date]
    );
    drivers = driverResult.rows;
    const vehicleResult = await runner.query<any>(
      `SELECT vl.id, v.id AS vehicle_id, v.registration, vl.licensing_authority_id,
              a.name AS authority_name, vl.license_type, vl.vehicle_license_badge
         FROM vehicles v
         JOIN vehicle_licensing_authorities vl ON vl.vehicle_id = v.id
         JOIN licensing_authorities a ON a.id = vl.licensing_authority_id AND a.active = TRUE
        WHERE v.status = 'active' AND vl.licensing_authority_id = ANY($1::text[])
          AND vl.active = TRUE AND vl.revoked_at IS NULL
          AND vl.license_type = ANY($3::text[])
          AND vl.valid_from <= $2 AND (vl.valid_until IS NULL OR vl.valid_until > $2)
        ORDER BY v.registration, a.preference_order, a.name, vl.license_type, vl.id`,
      [authorityIds, date, VEHICLE_LICENSE_TYPES]
    );
    vehicleLicenses = vehicleResult.rows.map((license: any) => ({
      id: license.id,
      vehicleId: license.vehicle_id,
      registration: license.registration,
      licensingAuthorityId: license.licensing_authority_id,
      licensingAuthorityName: license.authority_name,
      licenseType: license.license_type,
      vehicleLicenseBadge: license.vehicle_license_badge ?? null
    }));
  }

  let commonAuthorities: LicensingAuthority[] = [];
  if (selection.driverId && selection.vehicleLicenseId && selection.vehicleLicenseType
    && VEHICLE_LICENSE_TYPES.includes(selection.vehicleLicenseType)) {
    const common = await runner.query<any>(
      `SELECT DISTINCT a.id, a.name, a.authority_type, a.active, a.preference_order
         FROM licensing_authorities a
         JOIN operator_licences ol ON ol.licensing_authority_id = a.id
         JOIN system_setup_state s ON s.operator_id = ol.operator_id
         JOIN operators o ON o.id = s.operator_id
         JOIN driver_licensing_authorities dl
           ON dl.licensing_authority_id = a.id AND dl.driver_id = $2
         JOIN vehicle_licensing_authorities vl
           ON vl.licensing_authority_id = a.id AND vl.id = $3
         JOIN vehicles v ON v.id = vl.vehicle_id AND v.status = 'active'
        WHERE a.active = TRUE AND s.setup_key = 'initial_system_setup' AND s.status = 'completed'
          AND ol.licence_type = 'pho' AND ol.status = 'active'
          AND ol.valid_from <= $1::date AND (ol.valid_to IS NULL OR ol.valid_to > $1::date)
          AND EXISTS (SELECT 1 FROM operator_licence_documents d
            WHERE d.licence_id = ol.id AND d.is_latest = TRUE
              AND d.content IS NOT NULL)
          AND lower((SELECT u.status::text FROM users u WHERE u.id::text = dl.driver_id)) = 'active'
          AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id::text = dl.driver_id AND r.key = 'driver')
          AND dl.active = TRUE AND dl.revoked_at IS NULL
          AND dl.valid_from <= $1::text AND (dl.valid_until IS NULL OR dl.valid_until > $1::text)
          AND vl.license_type = $4 AND vl.active = TRUE AND vl.revoked_at IS NULL
          AND vl.valid_from <= $1::text AND (vl.valid_until IS NULL OR vl.valid_until > $1::text)
        ORDER BY a.preference_order, a.name, a.id`,
      [date, selection.driverId, selection.vehicleLicenseId, selection.vehicleLicenseType]
    );
    commonAuthorities = common.rows.map(authorityFromRow);
  }
  const audit = await runner.query<any>(
    `SELECT aa.action, aa.assigned_at, a.name AS authority_name,
            aa.vehicle_license_type, aa.vehicle_license_badge
       FROM booking_assignment_audit aa
       LEFT JOIN licensing_authorities a ON a.id = aa.licensing_authority_id
      WHERE aa.booking_id = $1
      ORDER BY aa.assigned_at, aa.id`,
    [bookingId]
  );

  return {
    booking: {
      id: row.id,
      customerId: row.customer_id,
      customerName: `${row.given_name} ${row.surname}`,
      reference: row.reference,
      serviceDate: date,
      pickup: row.pickup,
      dropoff: row.dropoff,
      status: row.status,
      driverId: row.driver_id ?? null,
      driverEmail: row.driver_email ?? null,
      vehicleId: row.vehicle_id ?? null,
      vehicleRegistration: row.registration ?? null,
      licensingAuthorityId: row.licensing_authority_id ?? null,
      licensingAuthorityName: row.authority_name ?? null,
      vehicleLicenseType: row.vehicle_license_type ?? null,
      vehicleLicenseBadge: row.vehicle_license_badge ?? null
    },
    drivers,
    vehicleLicenses,
    commonAuthorities,
    auditHistory: audit.rows.map((entry: any) => ({
      action: entry.action,
      assignedAt: entry.assigned_at,
      licensingAuthorityName: entry.authority_name ?? null,
      vehicleLicenseType: entry.vehicle_license_type ?? null,
      vehicleLicenseBadge: entry.vehicle_license_badge ?? null
    }))
  };
}

export async function assignBookingWithLicensing(input: {
  bookingId: string;
  driverId: string;
  vehicleLicenseId: string;
  licensingAuthorityId: string;
  vehicleLicenseType: VehicleLicenseType;
  actorId: string;
  source?: string;
  reason?: string | null;
}, client?: Queryable): Promise<CompatibleAuthority> {
  if (!VEHICLE_LICENSE_TYPES.includes(input.vehicleLicenseType)) {
    throw new BookingAssignmentError("Select a valid vehicle licence type.");
  }
  if (!input.licensingAuthorityId.trim()) throw new BookingAssignmentError("Select a common licensing authority.");
  if (!input.actorId.trim()) throw new BookingAssignmentError("Authenticated actor is required for assignment.");
  const work = async (runner: Queryable) => {
    const booking = await runner.query<{ service_date: string }>(
      "SELECT service_date FROM customer_bookings WHERE id = $1 FOR UPDATE",
      [input.bookingId]
    );
    if (!booking.rows[0]) throw new BookingAssignmentError("Booking was not found.");
    const date = serviceDate(booking.rows[0].service_date);
    const setup = await runner.query<{ operator_id: string }>(
      `SELECT operator_id FROM system_setup_state
        WHERE setup_key = 'initial_system_setup' AND status = 'completed'
        FOR SHARE`,
      []
    );
    const operatorId = setup.rows[0]?.operator_id;
    if (!operatorId) throw new BookingAssignmentError("The configured operator setup is not complete.");

    const operator = await runner.query<{ id: string; licence_number: string | null }>(
      `${OPERATOR_ASSIGNMENT_LICENCES}
         AND ol.operator_id = $2 AND ol.licensing_authority_id = $3
       ORDER BY ol.valid_from DESC, ol.id
       LIMIT 1 FOR SHARE OF ol`,
      [date, operatorId, input.licensingAuthorityId]
    );
    if (!operator.rows[0]) {
      throw new BookingAssignmentError("The configured operator has no active, documented licence from that authority on the service date.");
    }
    const driver = await runner.query(
      `SELECT u.id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id AND r.key = 'driver'
        WHERE u.id::text = $1 AND lower(u.status::text) = 'active'
        FOR SHARE OF u`,
      [input.driverId]
    );
    if (!driver.rows[0]) throw new BookingAssignmentError("Select an active driver account.");
    const driverLicense = await runner.query(
      `SELECT id FROM driver_licensing_authorities
        WHERE driver_id = $1 AND licensing_authority_id = $2
          AND active = TRUE AND revoked_at IS NULL
          AND valid_from <= $3 AND (valid_until IS NULL OR valid_until > $3)
        ORDER BY valid_from DESC, id LIMIT 1 FOR SHARE`,
      [input.driverId, input.licensingAuthorityId, date]
    );
    if (!driverLicense.rows[0]) {
      throw new BookingAssignmentError("The selected driver has no active licence from the selected authority on the service date.");
    }
    const vehicleLicense = await runner.query<{
      vehicle_id: string;
      vehicle_license_badge: string | null;
      registration: string;
      authority_name: string;
    }>(
      `SELECT vl.vehicle_id, vl.vehicle_license_badge, v.registration, a.name AS authority_name
         FROM vehicle_licensing_authorities vl
         JOIN vehicles v ON v.id = vl.vehicle_id AND v.status = 'active'
         JOIN licensing_authorities a ON a.id = vl.licensing_authority_id AND a.active = TRUE
        WHERE vl.id = $1 AND vl.licensing_authority_id = $2 AND vl.license_type = $3
          AND vl.active = TRUE AND vl.revoked_at IS NULL
          AND vl.valid_from <= $4 AND (vl.valid_until IS NULL OR vl.valid_until > $4)
        FOR SHARE OF vl, v, a`,
      [input.vehicleLicenseId, input.licensingAuthorityId, input.vehicleLicenseType, date]
    );
    if (!vehicleLicense.rows[0]) {
      throw new BookingAssignmentError("The selected vehicle licence is inactive, invalid on the service date, or does not match the chosen authority and type.");
    }
    const selected = {
      id: input.licensingAuthorityId,
      name: vehicleLicense.rows[0].authority_name,
      authorityType: null,
      active: true,
      preferenceOrder: 0,
      operatorLicenseReference: operator.rows[0].licence_number,
      driverLicenseReference: null,
      vehicleLicenseReference: null
    };
    const assignedAt = new Date().toISOString();
    const vehicleId = vehicleLicense.rows[0].vehicle_id;
    const vehicleLicenseBadge = vehicleLicense.rows[0].vehicle_license_badge ?? null;
    await runner.query(
      `UPDATE customer_bookings
          SET operator_id = $2, driver_id = $3, vehicle_id = $4, licensing_authority_id = $5,
              vehicle_license_type = $6, vehicle_license_badge = $7,
              assignment_status = 'assigned', assignment_review_required = FALSE,
              assigned_at = $8, assigned_by = $9, assignment_source = $10, assignment_reason = $11
        WHERE id = $1`,
      [input.bookingId, operatorId, input.driverId, vehicleId, selected.id,
        input.vehicleLicenseType, vehicleLicenseBadge, assignedAt, input.actorId,
        input.source || "dispatch", input.reason || null]
    );
    await runner.query(
      `INSERT INTO booking_assignment_audit
        (id, booking_id, operator_id, driver_id, vehicle_id, licensing_authority_id,
         assigned_at, actor_id, source, action, reason, vehicle_license_type, vehicle_license_badge)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'assigned', $10, $11, $12)`,
      [randomUUID(), input.bookingId, operatorId, input.driverId, vehicleId,
        selected.id, assignedAt, input.actorId, input.source || "dispatch", input.reason || null,
        input.vehicleLicenseType, vehicleLicenseBadge]
    );
    return selected;
  };
  if (client) return work(client);
  return withTransaction(work);
}

export async function unassignBookingVehicle(input: {
  bookingId: string;
  actorId: string;
  source?: string;
  reason?: string | null;
}, client?: Queryable): Promise<void> {
  if (!input.actorId.trim()) throw new BookingAssignmentError("Authenticated actor is required for assignment changes.");
  const work = async (runner: Queryable) => {
    const booking = await runner.query<{ operator_id: string | null; driver_id: string | null }>(
      "SELECT operator_id, driver_id FROM customer_bookings WHERE id = $1 FOR UPDATE",
      [input.bookingId]
    );
    if (!booking.rows[0]) throw new BookingAssignmentError("Booking was not found.");
    const unassignedAt = new Date().toISOString();
    await runner.query(
      `UPDATE customer_bookings
          SET vehicle_id=NULL, licensing_authority_id=NULL, vehicle_license_type=NULL,
              vehicle_license_badge=NULL, assignment_status='pending',
              assignment_review_required=TRUE, assigned_at=$2, assigned_by=$3,
              assignment_source=$4, assignment_reason=$5
        WHERE id=$1`,
      [input.bookingId, unassignedAt, input.actorId, input.source || "dispatch",
        input.reason || "Vehicle removed from assignment."]
    );
    await runner.query(
      `INSERT INTO booking_assignment_audit
        (id, booking_id, operator_id, driver_id, vehicle_id, licensing_authority_id,
         assigned_at, actor_id, source, action, reason, vehicle_license_type, vehicle_license_badge)
       VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,$7,'vehicle_unassigned',$8,NULL,NULL)`,
      [randomUUID(), input.bookingId, booking.rows[0].operator_id, booking.rows[0].driver_id,
        unassignedAt, input.actorId, input.source || "dispatch",
        input.reason || "Vehicle removed from assignment."]
    );
  };
  if (client) return work(client);
  return withTransaction(work);
}

export async function flagBookingForLicensingReview(
  bookingId: string,
  reason: string,
  client?: Queryable
): Promise<void> {
  await db(client).query(
    `UPDATE customer_bookings
        SET assignment_review_required = TRUE, assignment_reason = $2
      WHERE id = $1 AND assignment_status = 'assigned'`,
    [bookingId, reason]
  );
}
