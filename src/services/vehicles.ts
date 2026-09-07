import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "../database/connection";

type Queryable = Pool | PoolClient;
export const VEHICLE_DEFAULT_PER_PAGE = 15;
export const VEHICLE_STATUS_OPTIONS = ["available", "maintenance", "retired"] as const;
export type VehicleStatus = (typeof VEHICLE_STATUS_OPTIONS)[number];

export type VehicleClass = { key: string; label: string };
export type BaggageCategory = { key: string; label: string; description: string | null };
export type Vehicle = {
  id: string; registration: string; make: string; model: string; year: number | null;
  colour: string | null; vehicleClassKey: string; vehicleClassLabel: string;
  status: VehicleStatus; notes: string | null; driverId: string | null; driverEmail: string | null;
  documentsCount: number;
};
export type VehicleInput = {
  registration: string; make: string; model: string; year?: number | null;
  colour?: string | null; vehicleClassKey: string; status?: VehicleStatus; notes?: string | null;
};

function runner(client?: Queryable): Queryable { return client || getPool(); }
function normalize(value: unknown): string { return String(value ?? "").trim(); }
function mapVehicle(row: any): Vehicle {
  return {
    id: row.id, registration: row.registration, make: row.make, model: row.model,
    year: row.year === null ? null : Number(row.year), colour: row.colour,
    vehicleClassKey: row.vehicle_class_key, vehicleClassLabel: row.vehicle_class_label,
    status: row.status, notes: row.notes, driverId: row.driver_id, driverEmail: row.driver_email,
    documentsCount: Number(row.documents_count || 0)
  };
}

export async function listVehicleClasses(client?: Queryable): Promise<VehicleClass[]> {
  const result = await runner(client).query<VehicleClass>(
    "SELECT key, label FROM vehicle_classes WHERE active = TRUE ORDER BY label"
  );
  return result.rows;
}

export async function listBaggageCategories(client?: Queryable): Promise<BaggageCategory[]> {
  const result = await runner(client).query<BaggageCategory>(
    "SELECT key, label, description FROM baggage_categories WHERE active = TRUE ORDER BY label"
  );
  return result.rows;
}

export async function listDrivers(client?: Queryable): Promise<Array<{ id: string; email: string }>> {
  try {
    const result = await runner(client).query<{ id: string; email: string }>(
      `SELECT DISTINCT u.id, u.email FROM users u
       JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       WHERE r.key = 'driver' ORDER BY lower(u.email)`
    );
    return result.rows;
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
}

export async function getVehicleCount(search = "", client?: Queryable): Promise<number> {
  const result = await runner(client).query<{ count: string }>(
    `SELECT count(*)::text AS count FROM vehicles v
     JOIN vehicle_classes vc ON vc.key = v.vehicle_class_key
     WHERE ($1 = '' OR v.registration ILIKE '%' || $1 || '%' OR v.make ILIKE '%' || $1 || '%'
       OR v.model ILIKE '%' || $1 || '%' OR vc.label ILIKE '%' || $1 || '%')`, [normalize(search)]
  );
  return Number(result.rows[0]?.count || 0);
}

export async function listVehicles(params: { search?: string; page?: number; perPage?: number; client?: Queryable } = {}) {
  const perPage = Math.max(1, Math.min(100, Number(params.perPage || VEHICLE_DEFAULT_PER_PAGE)));
  const total = await getVehicleCount(params.search, params.client);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.max(1, Math.min(totalPages, Number(params.page || 1)));
  const result = await runner(params.client).query(
    `SELECT v.*, vc.label AS vehicle_class_label,
       a.driver_id, u.email AS driver_email, count(d.id)::int AS documents_count
     FROM vehicles v JOIN vehicle_classes vc ON vc.key = v.vehicle_class_key
     LEFT JOIN vehicle_driver_assignments a ON a.vehicle_id = v.id AND a.unassigned_at IS NULL
     LEFT JOIN users u ON u.id = a.driver_id
     LEFT JOIN vehicle_documents d ON d.vehicle_id = v.id
     WHERE ($1 = '' OR v.registration ILIKE '%' || $1 || '%' OR v.make ILIKE '%' || $1 || '%'
       OR v.model ILIKE '%' || $1 || '%' OR vc.label ILIKE '%' || $1 || '%')
     GROUP BY v.id, vc.label, a.driver_id, u.email
     ORDER BY lower(v.registration) LIMIT $2 OFFSET $3`,
    [normalize(params.search), perPage, (page - 1) * perPage]
  );
  return { vehicles: result.rows.map(mapVehicle), page, perPage, total, totalPages };
}

export async function getVehicleById(id: string, client?: Queryable): Promise<Vehicle | null> {
  const result = await runner(client).query(
    `SELECT v.*, vc.label AS vehicle_class_label, a.driver_id, u.email AS driver_email,
       count(d.id)::int AS documents_count
     FROM vehicles v JOIN vehicle_classes vc ON vc.key = v.vehicle_class_key
     LEFT JOIN vehicle_driver_assignments a ON a.vehicle_id = v.id AND a.unassigned_at IS NULL
     LEFT JOIN users u ON u.id = a.driver_id LEFT JOIN vehicle_documents d ON d.vehicle_id = v.id
     WHERE v.id = $1 GROUP BY v.id, vc.label, a.driver_id, u.email`, [id]
  );
  return result.rows[0] ? mapVehicle(result.rows[0]) : null;
}

export async function createVehicle(input: VehicleInput, client?: Queryable): Promise<Vehicle> {
  const registration = normalize(input.registration).toUpperCase();
  if (!registration || !normalize(input.make) || !normalize(input.model) || !normalize(input.vehicleClassKey)) {
    throw new Error("Registration, make, model, and vehicle class are required.");
  }
  const id = randomUUID();
  await runner(client).query(
    `INSERT INTO vehicles (id, registration, make, model, year, colour, vehicle_class_key, status, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
    [id, registration, normalize(input.make), normalize(input.model), input.year || null,
      normalize(input.colour) || null, input.vehicleClassKey, input.status || "available",
      normalize(input.notes) || null, new Date().toISOString()]
  );
  return (await getVehicleById(id, client))!;
}

export async function updateVehicle(id: string, input: VehicleInput, client?: Queryable): Promise<Vehicle | null> {
  await runner(client).query(
    `UPDATE vehicles SET registration=$2, make=$3, model=$4, year=$5, colour=$6,
       vehicle_class_key=$7, status=$8, notes=$9, updated_at=$10 WHERE id=$1`,
    [id, normalize(input.registration).toUpperCase(), normalize(input.make), normalize(input.model),
      input.year || null, normalize(input.colour) || null, input.vehicleClassKey,
      input.status || "available", normalize(input.notes) || null, new Date().toISOString()]
  );
  return getVehicleById(id, client);
}

export async function assignVehicleDriver(vehicleId: string, driverId: string, client?: Queryable): Promise<void> {
  const db = runner(client);
  await db.query("UPDATE vehicle_driver_assignments SET unassigned_at=$2 WHERE vehicle_id=$1 AND unassigned_at IS NULL",
    [vehicleId, new Date().toISOString()]);
  if (normalize(driverId)) {
    await db.query("INSERT INTO vehicle_driver_assignments (vehicle_id, driver_id, assigned_at) VALUES ($1,$2,$3)",
      [vehicleId, driverId, new Date().toISOString()]);
  }
}

export async function listVehicleDocuments(vehicleId: string, client?: Queryable) {
  const result = await runner(client).query(
    `SELECT id, document_type, document_number, issued_on, expires_on, original_filename,
       mime_type, uploaded_at FROM vehicle_documents WHERE vehicle_id=$1 ORDER BY expires_on NULLS LAST`, [vehicleId]
  );
  return result.rows;
}

export async function createVehicleDocument(input: {
  vehicleId: string; documentType: string; documentNumber?: string; issuedOn?: string;
  expiresOn?: string; originalFilename?: string; mimeType?: string; content?: Buffer;
  uploadedBy?: string;
}, client?: Queryable) {
  const id = randomUUID();
  await runner(client).query(
    `INSERT INTO vehicle_documents
      (id, vehicle_id, document_type, document_number, issued_on, expires_on, original_filename, mime_type, content, uploaded_by, uploaded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, input.vehicleId, normalize(input.documentType), normalize(input.documentNumber) || null,
      input.issuedOn || null, input.expiresOn || null, input.originalFilename || null,
      input.mimeType || null, input.content || null, input.uploadedBy || null, new Date().toISOString()]
  );
  return id;
}

export async function getVehicleDocument(id: string, client?: Queryable) {
  const result = await runner(client).query("SELECT * FROM vehicle_documents WHERE id=$1", [id]);
  return result.rows[0] || null;
}
