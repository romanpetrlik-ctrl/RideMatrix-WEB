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

async function activeLicenseIds(
  table: "operator_licensing_authorities" | "driver_licensing_authorities" | "vehicle_licensing_authorities",
  column: string,
  entityId: string,
  atTime: string,
  client: Queryable,
  vehicleLicenseType?: VehicleLicenseType
): Promise<Map<string, string | null>> {
  const result = await client.query(
    `SELECT l.licensing_authority_id, l.license_reference
       FROM ${table} l
       JOIN licensing_authorities a ON a.id = l.licensing_authority_id
      WHERE l.${column} = $1 AND a.active = TRUE AND l.active = TRUE
        AND l.revoked_at IS NULL AND l.valid_from <= $2
        AND (l.valid_until IS NULL OR l.valid_until > $2)
        ${table === "vehicle_licensing_authorities" && vehicleLicenseType ? "AND l.license_type = $3" : ""}
      ORDER BY l.valid_from DESC, l.id`,
    table === "vehicle_licensing_authorities" && vehicleLicenseType
      ? [entityId, atTime, vehicleLicenseType]
      : [entityId, atTime]
  );
  const licenses = new Map<string, string | null>();
  for (const row of result.rows as any[]) {
    if (!licenses.has(row.licensing_authority_id)) {
      licenses.set(row.licensing_authority_id, row.license_reference ?? null);
    }
  }
  return licenses;
}

export async function resolveCompatibleLicensingAuthorities(
  operatorId: string,
  driverId: string,
  vehicleId: string,
  atTime: Date | string = new Date(),
  client?: Queryable,
  vehicleLicenseType?: VehicleLicenseType
): Promise<CompatibleAuthority[]> {
  const runner = db(client);
  const instant = new Date(atTime).toISOString();
  const operator = await activeLicenseIds("operator_licensing_authorities", "operator_id", operatorId, instant, runner);
  const driver = await activeLicenseIds("driver_licensing_authorities", "driver_id", driverId, instant, runner);
  const vehicle = await activeLicenseIds(
    "vehicle_licensing_authorities", "vehicle_id", vehicleId, instant, runner, vehicleLicenseType
  );
  const ids = [...operator.keys()].filter((id) => driver.has(id) && vehicle.has(id));
  if (!ids.length) return [];
  const result = await runner.query(
    `SELECT id, name, authority_type, active, preference_order
       FROM licensing_authorities WHERE id = ANY($1::text[]) AND active = TRUE`,
    [ids]
  );
  return result.rows.map((row: any) => ({
    ...authorityFromRow(row),
    operatorLicenseReference: operator.get(row.id) ?? null,
    driverLicenseReference: driver.get(row.id) ?? null,
    vehicleLicenseReference: vehicle.get(row.id) ?? null
  })).sort((a: CompatibleAuthority, b: CompatibleAuthority) =>
    a.preferenceOrder - b.preferenceOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

export async function assignBookingWithLicensing(input: {
  bookingId: string;
  operatorId: string;
  driverId: string;
  vehicleId: string;
  vehicleLicenseType?: VehicleLicenseType | null;
  atTime?: Date | string;
  actorId?: string | null;
  source?: string;
  reason?: string | null;
}, client?: Queryable): Promise<CompatibleAuthority> {
  if (input.vehicleLicenseType && !VEHICLE_LICENSE_TYPES.includes(input.vehicleLicenseType)) {
    throw new Error("Select a valid vehicle licence type.");
  }
  const work = async (runner: Queryable) => {
    const booking = await runner.query<{ service_date: string }>(
      "SELECT service_date FROM customer_bookings WHERE id = $1 FOR UPDATE",
      [input.bookingId]
    );
    if (!booking.rows[0]) throw new Error("Booking was not found.");
    const vehicle = await runner.query<{ status: string }>(
      "SELECT status FROM vehicles WHERE id = $1",
      [input.vehicleId]
    );
    if (!vehicle.rows[0] || vehicle.rows[0].status !== "active") {
      throw new Error("Vehicle is not operationally available for assignment.");
    }
    const authorities = await resolveCompatibleLicensingAuthorities(
      input.operatorId, input.driverId, input.vehicleId, input.atTime || booking.rows[0].service_date,
      runner, input.vehicleLicenseType || undefined
    );
    const selected = selectDeterministicAuthority(authorities);
    if (!selected) throw new Error("No common active licensing authority for operator, driver, and vehicle.");
    const assignedAt = new Date().toISOString();
    let vehicleLicenseBadge: string | null = null;
    if (input.vehicleLicenseType) {
      const license = await runner.query<{ vehicle_license_badge: string | null }>(
        `SELECT vehicle_license_badge
           FROM vehicle_licensing_authorities
          WHERE vehicle_id=$1 AND licensing_authority_id=$2 AND license_type=$3
            AND active=TRUE AND revoked_at IS NULL
            AND valid_from <= $4 AND (valid_until IS NULL OR valid_until > $4)
          ORDER BY valid_from DESC, id
          LIMIT 1`,
        [input.vehicleId, selected.id, input.vehicleLicenseType, input.atTime || booking.rows[0].service_date]
      );
      vehicleLicenseBadge = license.rows[0]?.vehicle_license_badge ?? null;
    }
    await runner.query(
      `UPDATE customer_bookings
          SET operator_id = $2, driver_id = $3, vehicle_id = $4, licensing_authority_id = $5,
              vehicle_license_type = $10, vehicle_license_badge = $11,
              assignment_status = 'assigned', assignment_review_required = FALSE,
              assigned_at = $6, assigned_by = $7, assignment_source = $8, assignment_reason = $9
        WHERE id = $1`,
      [input.bookingId, input.operatorId, input.driverId, input.vehicleId, selected.id, assignedAt,
        input.actorId || null, input.source || "dispatch", input.reason || null,
        input.vehicleLicenseType || null, vehicleLicenseBadge]
    );
    await runner.query(
      `INSERT INTO booking_assignment_audit
        (id, booking_id, operator_id, driver_id, vehicle_id, licensing_authority_id,
         assigned_at, actor_id, source, action, reason, vehicle_license_type, vehicle_license_badge)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'assigned', $10, $11, $12)`,
      [randomUUID(), input.bookingId, input.operatorId, input.driverId, input.vehicleId,
        selected.id, assignedAt, input.actorId || null, input.source || "dispatch", input.reason || null,
        input.vehicleLicenseType || null, vehicleLicenseBadge]
    );
    return selected;
  };
  if (client) return work(client);
  return withTransaction(work);
}

export async function unassignBookingVehicle(input: {
  bookingId: string;
  actorId?: string | null;
  source?: string;
  reason?: string | null;
}, client?: Queryable): Promise<void> {
  const work = async (runner: Queryable) => {
    const booking = await runner.query<{ operator_id: string | null; driver_id: string | null }>(
      "SELECT operator_id, driver_id FROM customer_bookings WHERE id = $1 FOR UPDATE",
      [input.bookingId]
    );
    if (!booking.rows[0]) throw new Error("Booking was not found.");
    const unassignedAt = new Date().toISOString();
    await runner.query(
      `UPDATE customer_bookings
          SET vehicle_id=NULL, licensing_authority_id=NULL, vehicle_license_type=NULL,
              vehicle_license_badge=NULL, assignment_status='pending',
              assignment_review_required=TRUE, assigned_at=$2, assigned_by=$3,
              assignment_source=$4, assignment_reason=$5
        WHERE id=$1`,
      [input.bookingId, unassignedAt, input.actorId || null, input.source || "dispatch",
        input.reason || "Vehicle removed from assignment."]
    );
    await runner.query(
      `INSERT INTO booking_assignment_audit
        (id, booking_id, operator_id, driver_id, vehicle_id, licensing_authority_id,
         assigned_at, actor_id, source, action, reason, vehicle_license_type, vehicle_license_badge)
       VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,$7,'vehicle_unassigned',$8,NULL,NULL)`,
      [randomUUID(), input.bookingId, booking.rows[0].operator_id, booking.rows[0].driver_id,
        unassignedAt, input.actorId || null, input.source || "dispatch",
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
