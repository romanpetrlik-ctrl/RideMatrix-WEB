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
  licenseReference: string | null;
  validFrom: string;
  validUntil: string | null;
  active: boolean;
  revokedAt: string | null;
};

export type LicenseInput = {
  licensingAuthorityId: string;
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

async function activeLicenseIds(
  table: "operator_licensing_authorities" | "driver_licensing_authorities" | "vehicle_licensing_authorities",
  column: string,
  entityId: string,
  atTime: string,
  client: Queryable
): Promise<Map<string, string | null>> {
  const result = await client.query(
    `SELECT l.licensing_authority_id, l.license_reference
       FROM ${table} l
       JOIN licensing_authorities a ON a.id = l.licensing_authority_id
      WHERE l.${column} = $1 AND a.active = TRUE AND l.active = TRUE
        AND l.revoked_at IS NULL AND l.valid_from <= $2
        AND (l.valid_until IS NULL OR l.valid_until > $2)`,
    [entityId, atTime]
  );
  return new Map(result.rows.map((row: any) => [row.licensing_authority_id, row.license_reference ?? null]));
}

export async function resolveCompatibleLicensingAuthorities(
  operatorId: string,
  driverId: string,
  vehicleId: string,
  atTime: Date | string = new Date(),
  client?: Queryable
): Promise<CompatibleAuthority[]> {
  const runner = db(client);
  const instant = new Date(atTime).toISOString();
  const [operator, driver, vehicle] = await Promise.all([
    activeLicenseIds("operator_licensing_authorities", "operator_id", operatorId, instant, runner),
    activeLicenseIds("driver_licensing_authorities", "driver_id", driverId, instant, runner),
    activeLicenseIds("vehicle_licensing_authorities", "vehicle_id", vehicleId, instant, runner)
  ]);
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
  atTime?: Date | string;
  actorId?: string | null;
  source?: string;
  reason?: string | null;
}, client?: Queryable): Promise<CompatibleAuthority> {
  const work = async (runner: Queryable) => {
    const authorities = await resolveCompatibleLicensingAuthorities(
      input.operatorId, input.driverId, input.vehicleId, input.atTime || new Date(), runner
    );
    const selected = selectDeterministicAuthority(authorities);
    if (!selected) throw new Error("No common active licensing authority for operator, driver, and vehicle.");
    const assignedAt = new Date().toISOString();
    await runner.query(
      `UPDATE customer_bookings
          SET operator_id = $2, driver_id = $3, vehicle_id = $4, licensing_authority_id = $5,
              assignment_status = 'assigned', assignment_review_required = FALSE,
              assigned_at = $6, assigned_by = $7, assignment_source = $8, assignment_reason = $9
        WHERE id = $1`,
      [input.bookingId, input.operatorId, input.driverId, input.vehicleId, selected.id, assignedAt,
        input.actorId || null, input.source || "dispatch", input.reason || null]
    );
    await runner.query(
      `INSERT INTO booking_assignment_audit
        (id, booking_id, operator_id, driver_id, vehicle_id, licensing_authority_id,
         assigned_at, actor_id, source, action, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'assigned', $10)`,
      [randomUUID(), input.bookingId, input.operatorId, input.driverId, input.vehicleId,
        selected.id, assignedAt, input.actorId || null, input.source || "dispatch", input.reason || null]
    );
    return selected;
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
