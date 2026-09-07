import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "../database/connection";

type Queryable = Pool | PoolClient;
const db = (client?: Queryable): Queryable => client || getPool();
const text = (value: unknown): string => String(value ?? "").trim();

export const VEHICLE_DEFAULT_PER_PAGE = 15;
export const VEHICLE_STATUS_OPTIONS = ["active", "inactive", "maintenance"] as const;
export const VEHICLE_FUEL_TYPES = ["ICE", "HYBRID", "EV"] as const;
export const VEHICLE_DOCUMENT_TYPES = ["insurance", "mot", "mec", "hackney_ph_badge"] as const;
export const DOCUMENT_EXPIRING_SOON_DAYS = 30;
export const VEHICLE_DOCUMENT_UPLOAD_LIMIT = 30;
export type VehicleStatus = (typeof VEHICLE_STATUS_OPTIONS)[number];
export type VehicleFuelType = (typeof VEHICLE_FUEL_TYPES)[number];
export type VehicleDocumentType = (typeof VEHICLE_DOCUMENT_TYPES)[number];

export type VehicleClass = { key: string; label: string };
export type BaggageCategory = {
  key: string; label: string; description: string | null;
  minReferenceWeightKg: number | null; maxReferenceWeightKg: number | null;
  nominalLengthMm: number | null; nominalWidthMm: number | null; nominalHeightMm: number | null;
};
export type VehicleCapacity = { categoryKey: string; label: string; maxQuantity: number };
export type Vehicle = {
  id: string; registration: string; make: string; model: string; year: number | null;
  colour: string | null; registeredKeeperDetails: string | null;
  fuelType: VehicleFuelType; passengerCapacity: number; status: VehicleStatus;
  wheelchairAccessible: boolean; notes: string | null; classes: VehicleClass[];
  driverId: string | null; driverEmail: string | null; capacities: VehicleCapacity[];
  documentsCount: number;
};
export type VehicleInput = {
  registration: string; make: string; model: string; classKeys?: string[];
  vehicleClassKey?: string; fuelType: VehicleFuelType; passengerCapacity: number;
  status: VehicleStatus; colour?: string | null; registeredKeeperDetails?: string | null;
  wheelchairAccessible?: boolean; year?: number | null; notes?: string | null;
  baggageCapacities?: Record<string, number | null>;
};

function mapVehicle(row: any): Vehicle {
  return {
    id: row.id, registration: row.registration, make: row.make, model: row.model,
    year: row.year == null ? null : Number(row.year), colour: row.colour,
    registeredKeeperDetails: row.registered_keeper_details, fuelType: row.fuel_type,
    passengerCapacity: Number(row.passenger_capacity), status: row.status,
    wheelchairAccessible: Boolean(row.wheelchair_accessible), notes: row.notes,
    classes: row.classes || [], driverId: row.driver_id, driverEmail: row.driver_email,
    capacities: row.capacities || [], documentsCount: Number(row.documents_count || 0)
  };
}

export async function listVehicleClasses(client?: Queryable): Promise<VehicleClass[]> {
  const result = await db(client).query<VehicleClass>(
    "SELECT key, label FROM vehicle_classes WHERE active = TRUE ORDER BY label"
  );
  return result.rows;
}

export async function listBaggageCategories(client?: Queryable): Promise<BaggageCategory[]> {
  const result = await db(client).query<any>(
    `SELECT key, label, description, min_reference_weight_kg, max_reference_weight_kg,
       nominal_length_mm, nominal_width_mm, nominal_height_mm
     FROM baggage_categories WHERE active = TRUE ORDER BY
       CASE key WHEN 'xl_suitcase' THEN 1 WHEN 'l_suitcase' THEN 2
       WHEN 'cabin_bag' THEN 3 WHEN 'backpack' THEN 4 ELSE 5 END, label`
  );
  return result.rows.map((row: any) => ({
    key: row.key, label: row.label, description: row.description,
    minReferenceWeightKg: row.min_reference_weight_kg == null ? null : Number(row.min_reference_weight_kg),
    maxReferenceWeightKg: row.max_reference_weight_kg == null ? null : Number(row.max_reference_weight_kg),
    nominalLengthMm: row.nominal_length_mm, nominalWidthMm: row.nominal_width_mm, nominalHeightMm: row.nominal_height_mm
  }));
}

export async function listDrivers(client?: Queryable): Promise<Array<{ id: string; email: string }>> {
  try {
    const result = await db(client).query<{ id: string; email: string }>(
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

function classAggregate(): string {
  return `COALESCE((SELECT json_agg(json_build_object('key', vc.key, 'label', vc.label) ORDER BY vc.label)
    FROM vehicle_class_assignments vca JOIN vehicle_classes vc ON vc.key = vca.vehicle_class_key
    WHERE vca.vehicle_id = v.id AND vca.unassigned_at IS NULL), '[]'::json) AS classes`;
}
function capacityAggregate(): string {
  return `COALESCE((SELECT json_agg(json_build_object('categoryKey', bc.key, 'label', bc.label, 'maxQuantity', vbc.max_quantity) ORDER BY bc.label)
    FROM vehicle_baggage_capacities vbc JOIN baggage_categories bc ON bc.key = vbc.baggage_category_key
    WHERE vbc.vehicle_id = v.id), '[]'::json) AS capacities`;
}
const vehicleSelect = `v.*, ${classAggregate()}, ${capacityAggregate()},
  a.driver_id, u.email AS driver_email,
  (SELECT count(*)::int FROM vehicle_documents d WHERE d.vehicle_id = v.id AND d.is_latest = TRUE) AS documents_count`;

async function withVehicleTransaction<T>(client: Queryable | undefined, work: (runner: Queryable) => Promise<T>): Promise<T> {
  const runner = client || getPool();
  if ("connect" in runner && typeof runner.connect === "function") {
    const tx = await (runner as Pool).connect();
    try {
      await tx.query("BEGIN");
      const result = await work(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }
  return work(runner);
}

export async function getVehicleCount(search = "", client?: Queryable): Promise<number> {
  const result = await db(client).query<{ count: string }>(
    `SELECT count(*)::text AS count FROM vehicles v
     WHERE ($1 = '' OR v.registration ILIKE '%' || $1 || '%' OR v.make ILIKE '%' || $1 || '%'
       OR v.model ILIKE '%' || $1 || '%' OR EXISTS (
         SELECT 1 FROM vehicle_class_assignments vca JOIN vehicle_classes vc ON vc.key = vca.vehicle_class_key
         WHERE vca.vehicle_id = v.id AND vca.unassigned_at IS NULL AND vc.label ILIKE '%' || $1 || '%'))`,
    [text(search)]
  );
  return Number(result.rows[0]?.count || 0);
}

export async function listVehicles(params: { search?: string; page?: number; perPage?: number; client?: Queryable } = {}) {
  const perPage = Math.max(1, Math.min(100, Number(params.perPage || VEHICLE_DEFAULT_PER_PAGE)));
  const total = await getVehicleCount(params.search, params.client);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.max(1, Math.min(totalPages, Number(params.page || 1)));
  const result = await db(params.client).query(
    `SELECT ${vehicleSelect} FROM vehicles v
     LEFT JOIN vehicle_driver_assignments a ON a.vehicle_id = v.id AND a.unassigned_at IS NULL
     LEFT JOIN users u ON u.id = a.driver_id
     WHERE ($1 = '' OR v.registration ILIKE '%' || $1 || '%' OR v.make ILIKE '%' || $1 || '%'
       OR v.model ILIKE '%' || $1 || '%' OR EXISTS (
         SELECT 1 FROM vehicle_class_assignments vca JOIN vehicle_classes vc ON vc.key = vca.vehicle_class_key
         WHERE vca.vehicle_id = v.id AND vca.unassigned_at IS NULL AND vc.label ILIKE '%' || $1 || '%'))
     ORDER BY lower(v.registration) LIMIT $2 OFFSET $3`,
    [text(params.search), perPage, (page - 1) * perPage]
  );
  return { vehicles: result.rows.map(mapVehicle), page, perPage, total, totalPages };
}

export async function getVehicleById(id: string, client?: Queryable): Promise<Vehicle | null> {
  const result = await db(client).query(
    `SELECT ${vehicleSelect} FROM vehicles v
     LEFT JOIN vehicle_driver_assignments a ON a.vehicle_id = v.id AND a.unassigned_at IS NULL
     LEFT JOIN users u ON u.id = a.driver_id WHERE v.id = $1`, [id]
  );
  return result.rows[0] ? mapVehicle(result.rows[0]) : null;
}

function normalizedClasses(input: VehicleInput): string[] {
  const keys = (input.classKeys || (input.vehicleClassKey ? [input.vehicleClassKey] : []))
    .map(text).filter(Boolean);
  if (input.wheelchairAccessible) keys.push("wheelchair_accessible");
  return Array.from(new Set(keys));
}
function validateVehicleInput(input: VehicleInput): string[] {
  const errors: string[] = [];
  if (!text(input.registration) || !text(input.make) || !text(input.model)) errors.push("Registration, make, and model are required.");
  if (normalizedClasses(input).length === 0) errors.push("Select at least one vehicle class assignment.");
  if (!VEHICLE_FUEL_TYPES.includes(input.fuelType)) errors.push("Select a valid fuel type.");
  if (!Number.isInteger(input.passengerCapacity) || input.passengerCapacity < 1) errors.push("Passenger capacity must be a positive integer.");
  if (!VEHICLE_STATUS_OPTIONS.includes(input.status)) errors.push("Select a valid vehicle status.");
  for (const [key, quantity] of Object.entries(input.baggageCapacities || {})) {
    if (quantity != null && (!Number.isInteger(quantity) || quantity < 0)) errors.push(`Capacity for ${key} must be a non-negative integer.`);
  }
  return errors;
}
async function persistAssignments(id: string, input: VehicleInput, client: Queryable): Promise<void> {
  const now = new Date().toISOString();
  const classes = normalizedClasses(input);
  await client.query("UPDATE vehicles SET vehicle_class_key = $2 WHERE id = $1", [id, classes[0]]);
  await client.query(
    `UPDATE vehicle_class_assignments SET unassigned_at = $2
     WHERE vehicle_id = $1 AND unassigned_at IS NULL AND NOT (vehicle_class_key = ANY($3::text[]))`,
    [id, now, classes]
  );
  for (const key of classes) {
    await client.query(
      `INSERT INTO vehicle_class_assignments (vehicle_id, vehicle_class_key, assigned_at)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, key, now]
    );
  }
  for (const [key, quantity] of Object.entries(input.baggageCapacities || {})) {
    if (quantity == null) {
      await client.query("DELETE FROM vehicle_baggage_capacities WHERE vehicle_id = $1 AND baggage_category_key = $2", [id, key]);
    } else {
      await client.query(
        `INSERT INTO vehicle_baggage_capacities (vehicle_id, baggage_category_key, max_quantity, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (vehicle_id, baggage_category_key) DO UPDATE SET max_quantity = EXCLUDED.max_quantity, updated_at = EXCLUDED.updated_at`,
        [id, key, quantity, now]
      );
    }
  }
  await client.query("UPDATE vehicles SET wheelchair_accessible = $2 WHERE id = $1", [id, classes.includes("wheelchair_accessible")]);
}

export async function createVehicle(input: VehicleInput, client?: Queryable): Promise<Vehicle> {
  const errors = validateVehicleInput(input);
  if (errors.length) throw new Error(errors.join(" "));
  const id = randomUUID();
  return withVehicleTransaction(client, async (runner) => {
    await runner.query(
      `INSERT INTO vehicles
        (id, registration, make, model, year, colour, registered_keeper_details, fuel_type,
         passenger_capacity, wheelchair_accessible, status, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
      [id, text(input.registration).toUpperCase(), text(input.make), text(input.model), input.year || null,
        text(input.colour) || null, text(input.registeredKeeperDetails) || null, input.fuelType,
        input.passengerCapacity, normalizedClasses(input).includes("wheelchair_accessible"),
        input.status, text(input.notes) || null, new Date().toISOString()]
    );
    await persistAssignments(id, input, runner);
    return (await getVehicleById(id, runner))!;
  });
}

export async function updateVehicle(id: string, input: VehicleInput, client?: Queryable): Promise<Vehicle | null> {
  const errors = validateVehicleInput(input);
  if (errors.length) throw new Error(errors.join(" "));
  return withVehicleTransaction(client, async (runner) => {
    await runner.query(
      `UPDATE vehicles SET registration=$2, make=$3, model=$4, year=$5, colour=$6,
         registered_keeper_details=$7, fuel_type=$8, passenger_capacity=$9,
         wheelchair_accessible=$10, status=$11, notes=$12, updated_at=$13 WHERE id=$1`,
      [id, text(input.registration).toUpperCase(), text(input.make), text(input.model), input.year || null,
        text(input.colour) || null, text(input.registeredKeeperDetails) || null, input.fuelType,
        input.passengerCapacity, normalizedClasses(input).includes("wheelchair_accessible"),
        input.status, text(input.notes) || null, new Date().toISOString()]
    );
    await persistAssignments(id, input, runner);
    return getVehicleById(id, runner);
  });
}

export async function assignVehicleDriver(vehicleId: string, driverId: string, client?: Queryable): Promise<void> {
  const runner = db(client);
  const now = new Date().toISOString();
  await runner.query("UPDATE vehicle_driver_assignments SET unassigned_at=$2 WHERE vehicle_id=$1 AND unassigned_at IS NULL", [vehicleId, now]);
  if (text(driverId)) await runner.query(
    "INSERT INTO vehicle_driver_assignments (vehicle_id, driver_id, assigned_at) VALUES ($1,$2,$3)",
    [vehicleId, text(driverId), now]
  );
}
export async function listVehicleDriverAssignments(vehicleId: string, client?: Queryable) {
  const result = await db(client).query(
    `SELECT driver_id, assigned_at, unassigned_at FROM vehicle_driver_assignments
     WHERE vehicle_id=$1 ORDER BY assigned_at DESC`, [vehicleId]
  );
  return result.rows;
}
export async function getVehicleDriverSummary(vehicleId: string, client?: Queryable) {
  try {
    const result = await db(client).query(
      `SELECT a.driver_id AS id, u.email, u.status, a.assigned_at
       FROM vehicle_driver_assignments a
       JOIN users u ON u.id = a.driver_id
       WHERE a.vehicle_id = $1 AND a.unassigned_at IS NULL
       ORDER BY a.assigned_at DESC
       LIMIT 1`,
      [vehicleId]
    );
    return result.rows[0] || null;
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return null;
    throw error;
  }
}

export function getDocumentStatus(expiresOn: string | null, now = new Date()): "Missing" | "Valid" | "Expiring soon" | "Expired" {
  if (!expiresOn) return "Missing";
  const expiry = new Date(`${expiresOn}T23:59:59Z`);
  if (Number.isNaN(expiry.getTime()) || expiry < now) return "Expired";
  if (expiry.getTime() - now.getTime() <= DOCUMENT_EXPIRING_SOON_DAYS * 86400000) return "Expiring soon";
  return "Valid";
}
export async function listVehicleDocuments(vehicleId: string, client?: Queryable) {
  const result = await db(client).query(
    `SELECT id, document_type, document_number, issued_on, expires_on, original_filename,
       mime_type, uploaded_at FROM vehicle_documents WHERE vehicle_id=$1 AND is_latest = TRUE ORDER BY document_type`, [vehicleId]
  );
  return result.rows.map((row) => ({ ...row, status: getDocumentStatus(row.expires_on) }));
}
export async function createVehicleDocument(input: {
  vehicleId: string; documentType: string; documentNumber?: string; issuedOn?: string;
  expiresOn?: string; originalFilename?: string; mimeType?: string; content?: Buffer; uploadedBy?: string;
}, client?: Queryable) {
  if (!VEHICLE_DOCUMENT_TYPES.includes(input.documentType as VehicleDocumentType)) throw new Error("Select a valid compliance document type.");
  if (!input.expiresOn || getDocumentStatus(input.expiresOn) === "Expired") throw new Error("Enter a valid current or future expiry date.");
  return withVehicleTransaction(client, async (runner) => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await runner.query(
      `UPDATE vehicle_documents
       SET is_latest = FALSE, superseded_at = $3
       WHERE vehicle_id = $1 AND document_type = $2 AND is_latest = TRUE`,
      [input.vehicleId, input.documentType, now]
    );
    await runner.query(
      `INSERT INTO vehicle_documents
        (id, vehicle_id, document_type, document_number, issued_on, expires_on, original_filename, mime_type, content, uploaded_by, uploaded_at, is_latest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`,
      [id, input.vehicleId, input.documentType, text(input.documentNumber) || null, input.issuedOn || null,
        input.expiresOn, input.originalFilename || null, input.mimeType || null, input.content || null,
        input.uploadedBy || null, now]
    );
    return id;
  });
}
export async function getVehicleDocument(id: string, client?: Queryable) {
  const result = await db(client).query("SELECT * FROM vehicle_documents WHERE id=$1 AND is_latest = TRUE", [id]);
  return result.rows[0] || null;
}
export async function consumeVehicleDocumentUploadRateLimit(rateLimitKey: string, client?: Queryable): Promise<boolean> {
  const result = await db(client).query<{ allowed: boolean }>(
    `INSERT INTO vehicle_document_upload_rate_limits (rate_limit_key, window_started_at, request_count)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (rate_limit_key) DO UPDATE SET
       request_count = CASE WHEN vehicle_document_upload_rate_limits.window_started_at <= now() - interval '1 minute'
         THEN 1 ELSE vehicle_document_upload_rate_limits.request_count + 1 END,
       window_started_at = CASE WHEN vehicle_document_upload_rate_limits.window_started_at <= now() - interval '1 minute'
         THEN date_trunc('minute', now()) ELSE vehicle_document_upload_rate_limits.window_started_at END
     RETURNING request_count <= $2 AS allowed`, [rateLimitKey, VEHICLE_DOCUMENT_UPLOAD_LIMIT]
  );
  return Boolean(result.rows[0]?.allowed);
}

export type VehicleDocumentUpload = { originalname: string; mimetype: string; buffer: Buffer };
const DOCUMENT_FORMATS = {
  ".pdf": { mime: "application/pdf", signature: (b: Buffer) => b.subarray(0, 5).toString() === "%PDF-" },
  ".jpg": { mime: "image/jpeg", signature: (b: Buffer) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  ".jpeg": { mime: "image/jpeg", signature: (b: Buffer) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  ".png": { mime: "image/png", signature: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
} as const;
export function validateVehicleDocumentUpload(file: VehicleDocumentUpload): void {
  const extension = file.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  const format = DOCUMENT_FORMATS[extension as keyof typeof DOCUMENT_FORMATS];
  if (!format || file.mimetype !== format.mime || !format.signature(file.buffer)) throw new Error("Only valid PDF, JPEG, and PNG documents are accepted.");
}
