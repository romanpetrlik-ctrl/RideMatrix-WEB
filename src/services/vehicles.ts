import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import {
  DOCUMENT_ALLOWED_MIME,
  DOCUMENT_MAX_FILE_SIZE_BYTES,
  DOCUMENT_MAX_FILES_PER_CATEGORY
} from "../config/documents";
import { getPool } from "../database/connection";
import { buildEntityVaultRelativePath, readVaultFile, removeVaultFile, sanitizeOriginalFilename as sanitizeVaultFilename, writeVaultFile } from "./document-vault";

type Queryable = Pool | PoolClient;
const db = (client?: Queryable): Queryable => client || getPool();
const text = (value: unknown): string => String(value ?? "").trim();
const normalizeRegistrationSearch = (value: unknown): string => text(value).replace(/[^a-z0-9]/gi, "").toLowerCase();

export const VEHICLE_DEFAULT_PER_PAGE = 15;
export const VEHICLE_STATUS_OPTIONS = ["active", "inactive", "maintenance"] as const;
export const VEHICLE_FUEL_TYPES = ["ICE", "HYBRID", "EV"] as const;
export const VEHICLE_LICENSE_TYPES = ["hackney_carriage", "private_hire"] as const;
export const VEHICLE_DOCUMENT_TYPES = ["insurance", "mot", "mec", "hackney_ph_badge", "v5c", "council_mechanical_check", "hire_reward_insurance", "hc_phv_license_issued"] as const;
export const VEHICLE_RECORD_DOCUMENT_TYPES = ["v5c", "mec", "hire_reward_insurance", "hc_phv_license_issued", "mot"] as const;
export const DOCUMENT_EXPIRING_SOON_DAYS = 30;
export const VEHICLE_DOCUMENT_UPLOAD_LIMIT = 30;
export const VEHICLE_DOCUMENT_DOWNLOAD_LIMIT = 120;
export const VEHICLE_DOCUMENT_MAX_BYTES = DOCUMENT_MAX_FILE_SIZE_BYTES;
export const VEHICLE_MUTATION_LIMIT = 120;
export const VEHICLE_RECORD_DOCUMENT_CATEGORIES = VEHICLE_RECORD_DOCUMENT_TYPES;
export type VehicleStatus = (typeof VEHICLE_STATUS_OPTIONS)[number];
export type VehicleFuelType = (typeof VEHICLE_FUEL_TYPES)[number];
export type VehicleLicenseType = (typeof VEHICLE_LICENSE_TYPES)[number];
export type VehicleDocumentType = (typeof VEHICLE_DOCUMENT_TYPES)[number];
export type VehicleRecordDocumentType = (typeof VEHICLE_RECORD_DOCUMENT_TYPES)[number];
const VEHICLE_RECORD_DOCUMENT_CATEGORY_ALIASES: Record<VehicleRecordDocumentType, readonly string[]> = {
  v5c: ["v5c"],
  mec: ["mec", "council_mechanical_check"],
  hire_reward_insurance: ["hire_reward_insurance"],
  hc_phv_license_issued: ["hc_phv_license_issued"],
  mot: ["mot"]
};
const VEHICLE_RECORD_DOCUMENT_CATEGORY_TO_CANONICAL = Object.fromEntries(
  Object.entries(VEHICLE_RECORD_DOCUMENT_CATEGORY_ALIASES).flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical]))
) as Record<string, VehicleRecordDocumentType>;

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
  vehicleLicenseType: VehicleLicenseType | null; vehicleLicenseBadge: string | null;
  wheelchairAccessible: boolean; notes: string | null; classes: VehicleClass[];
  driverId: string | null; driverEmail: string | null; capacities: VehicleCapacity[];
  documentsCount: number;
};
export type VehicleInput = {
  registration: string; make: string; model: string; classKeys?: string[];
  vehicleClassKey?: string; fuelType: VehicleFuelType; passengerCapacity: number;
  status: VehicleStatus; colour?: string | null; registeredKeeperDetails?: string | null;
  year?: number | null; vehicleLicenseType?: VehicleLicenseType | null; vehicleLicenseBadge?: string | null; notes?: string | null;
  baggageCapacities?: Record<string, number | null>;
};

function mapVehicle(row: any): Vehicle {
  return {
    id: row.id, registration: row.registration, make: row.make, model: row.model,
    year: row.year == null ? null : Number(row.year), colour: row.colour,
    registeredKeeperDetails: row.registered_keeper_details, fuelType: row.fuel_type,
    passengerCapacity: Number(row.passenger_capacity), status: row.status,
    vehicleLicenseType: row.vehicle_license_type, vehicleLicenseBadge: row.vehicle_license_badge,
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
      `SELECT u.id::text AS id, u.email FROM users u
       WHERE EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id AND r.key = 'driver')
       ORDER BY lower(u.email)`
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
  ((SELECT count(*)::int FROM vehicle_documents d WHERE d.vehicle_id = v.id AND d.is_latest = TRUE)
    + (SELECT count(*)::int FROM entity_documents d WHERE d.entity_type = 'vehicle' AND d.entity_id = v.id)) AS documents_count`;

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

export function normalizeVehicleStatusFilter(value: unknown): VehicleStatus | "" {
  if (typeof value !== "string") return "";
  const status = text(value).toLowerCase();
  return VEHICLE_STATUS_OPTIONS.includes(status as VehicleStatus) ? (status as VehicleStatus) : "";
}

const vehicleDirectoryWhere = `($1 = '' OR v.registration ILIKE '%' || $1 || '%'
      OR ($3 <> '' AND regexp_replace(v.registration, '[^a-zA-Z0-9]+', '', 'g') ILIKE '%' || $3 || '%')
      OR v.make ILIKE '%' || $1 || '%'
      OR v.model ILIKE '%' || $1 || '%' OR EXISTS (
         SELECT 1 FROM vehicle_class_assignments vca JOIN vehicle_classes vc ON vc.key = vca.vehicle_class_key
         WHERE vca.vehicle_id = v.id AND vca.unassigned_at IS NULL
           AND (vc.label ILIKE '%' || $1 || '%' OR vc.key ILIKE '%' || $1 || '%')))
     AND ($2 = '' OR v.status = $2)`;

export async function getVehicleCount(search = "", client?: Queryable, status: unknown = ""): Promise<number> {
  const normalizedSearch = normalizeRegistrationSearch(search);
  const result = await db(client).query<{ count: string }>(
    `SELECT count(*)::text AS count FROM vehicles v
     WHERE ${vehicleDirectoryWhere}`,
    [text(search), normalizeVehicleStatusFilter(status), normalizedSearch]
  );
  return Number(result.rows[0]?.count || 0);
}

export async function listVehicles(params: { search?: string; status?: unknown; page?: number; perPage?: number; client?: Queryable } = {}) {
  const perPage = Math.max(1, Math.min(100, Number(params.perPage) || VEHICLE_DEFAULT_PER_PAGE));
  const status = normalizeVehicleStatusFilter(params.status);
  const total = await getVehicleCount(params.search, params.client, status);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.max(1, Math.min(totalPages, Math.trunc(Number(params.page)) || 1));
  const normalizedSearch = normalizeRegistrationSearch(params.search);
  const result = await db(params.client).query(
    `SELECT ${vehicleSelect} FROM vehicles v
     LEFT JOIN vehicle_driver_assignments a ON a.vehicle_id = v.id AND a.unassigned_at IS NULL
     LEFT JOIN users u ON u.id::text = a.driver_id
     WHERE ${vehicleDirectoryWhere}
     ORDER BY lower(v.registration) LIMIT $4 OFFSET $5`,
    [text(params.search), status, normalizedSearch, perPage, (page - 1) * perPage]
  );
  return { vehicles: result.rows.map(mapVehicle), status, page, perPage, total, totalPages };
}

export async function getVehicleById(id: string, client?: Queryable): Promise<Vehicle | null> {
  const result = await db(client).query(
    `SELECT ${vehicleSelect} FROM vehicles v
     LEFT JOIN vehicle_driver_assignments a ON a.vehicle_id = v.id AND a.unassigned_at IS NULL
     LEFT JOIN users u ON u.id::text = a.driver_id WHERE v.id = $1`, [id]
  );
  return result.rows[0] ? mapVehicle(result.rows[0]) : null;
}

function normalizedClasses(input: VehicleInput): string[] {
  const keys = (input.classKeys || (input.vehicleClassKey ? [input.vehicleClassKey] : []))
    .map(text).filter(Boolean);
  return Array.from(new Set(keys));
}
function validateVehicleInput(input: VehicleInput): string[] {
  const errors: string[] = [];
  const vehicleLicenseType = text(input.vehicleLicenseType);
  const badge = text(input.vehicleLicenseBadge);
  if (!text(input.registration) || !text(input.make) || !text(input.model)) errors.push("Registration, make, and model are required.");
  if (normalizedClasses(input).length === 0) errors.push("Select at least one vehicle class assignment.");
  if (!VEHICLE_FUEL_TYPES.includes(input.fuelType)) errors.push("Select a valid fuel type.");
  if (!Number.isInteger(input.passengerCapacity) || input.passengerCapacity < 1 || input.passengerCapacity > 8) {
    errors.push("Passenger capacity must be an integer between 1 and 8.");
  }
  if (!VEHICLE_STATUS_OPTIONS.includes(input.status)) errors.push("Select a valid vehicle status.");
  if (!VEHICLE_LICENSE_TYPES.includes(vehicleLicenseType as VehicleLicenseType)) errors.push("Select Hackney Carriage or Private Hire as the vehicle licence type.");
  if (badge && (badge.length > 64 || /[\x00-\x1F\x7F]/.test(badge))) errors.push("Vehicle licence badge number must be 64 characters or fewer and contain no control characters.");
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

export class VehicleValidationError extends Error {}
function toVehicleValidationError(error: unknown): unknown {
  const code = (error as { code?: string }).code;
  if (code === "23505") return new VehicleValidationError("A vehicle with this registration number already exists.");
  if (code === "23503") return new VehicleValidationError("Select a valid vehicle class assignment and baggage categories.");
  return error;
}

export async function createVehicle(input: VehicleInput, client?: Queryable): Promise<Vehicle> {
  const errors = validateVehicleInput(input);
  if (errors.length) throw new VehicleValidationError(errors.join(" "));
  const id = randomUUID();
  return withVehicleTransaction(client, async (runner) => {
    await runner.query(
      `INSERT INTO vehicles
        (id, registration, make, model, year, colour, registered_keeper_details, fuel_type,
         passenger_capacity, wheelchair_accessible, status, vehicle_license_type, vehicle_license_badge, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [id, text(input.registration).toUpperCase(), text(input.make), text(input.model), input.year ?? null,
        text(input.colour) || null, text(input.registeredKeeperDetails) || null, input.fuelType,
        input.passengerCapacity, normalizedClasses(input).includes("wheelchair_accessible"),
        input.status, text(input.vehicleLicenseType), text(input.vehicleLicenseBadge) || null,
        text(input.notes) || null, new Date().toISOString()]
    );
    await persistAssignments(id, input, runner);
    return (await getVehicleById(id, runner))!;
  }).catch((error) => { throw toVehicleValidationError(error); });
}

export async function updateVehicle(id: string, input: VehicleInput, client?: Queryable): Promise<Vehicle | null> {
  const errors = validateVehicleInput(input);
  if (errors.length) throw new VehicleValidationError(errors.join(" "));
  return withVehicleTransaction(client, async (runner) => {
    const updated = await runner.query(
      `UPDATE vehicles SET registration=$2, make=$3, model=$4, year=$5, colour=$6,
         registered_keeper_details=$7, fuel_type=$8, passenger_capacity=$9,
         wheelchair_accessible=$10, status=$11, vehicle_license_type=$12, vehicle_license_badge=$13,
         notes=$14, updated_at=$15 WHERE id=$1`,
      [id, text(input.registration).toUpperCase(), text(input.make), text(input.model), input.year ?? null,
        text(input.colour) || null, text(input.registeredKeeperDetails) || null, input.fuelType,
        input.passengerCapacity, normalizedClasses(input).includes("wheelchair_accessible"),
        input.status, text(input.vehicleLicenseType), text(input.vehicleLicenseBadge) || null,
        text(input.notes) || null, new Date().toISOString()]
    );
    if (updated.rowCount === 0) return null;
    await persistAssignments(id, input, runner);
    return getVehicleById(id, runner);
  }).catch((error) => { throw toVehicleValidationError(error); });
}

export class VehicleDriverAssignmentError extends Error {}
export class VehicleNotFoundError extends Error {}

export async function assignVehicleDriver(vehicleId: string, driverId: string, client?: Queryable): Promise<"assigned" | "unassigned" | "unchanged"> {
  const nextDriverId = text(driverId);
  return withVehicleTransaction(client, async (runner) => {
    const vehicle = await runner.query("SELECT id FROM vehicles WHERE id = $1 FOR UPDATE", [vehicleId]);
    if (!vehicle.rows[0]) throw new VehicleNotFoundError("Vehicle not found.");
    if (nextDriverId) {
      const driver = await runner.query(
        `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
         WHERE u.id::text = $1 AND r.key = 'driver' LIMIT 1`, [nextDriverId]
      );
      if (!driver.rows[0]) throw new VehicleDriverAssignmentError("Select a valid driver.");
    }
    const current = await runner.query(
      "SELECT driver_id FROM vehicle_driver_assignments WHERE vehicle_id = $1 AND unassigned_at IS NULL", [vehicleId]
    );
    const currentDriverId = text(current.rows[0]?.driver_id);
    if (currentDriverId === nextDriverId) return "unchanged";
    const now = new Date().toISOString();
    await runner.query("UPDATE vehicle_driver_assignments SET unassigned_at=$2 WHERE vehicle_id=$1 AND unassigned_at IS NULL", [vehicleId, now]);
    if (!nextDriverId) return "unassigned";
    await runner.query(
      "INSERT INTO vehicle_driver_assignments (vehicle_id, driver_id, assigned_at) VALUES ($1,$2,$3)",
      [vehicleId, nextDriverId, now]
    );
    return "assigned";
  });
}
export async function listVehicleDriverAssignments(vehicleId: string, client?: Queryable) {
  const result = await db(client).query(
    `SELECT a.driver_id, u.email AS driver_email, a.assigned_at, a.unassigned_at
     FROM vehicle_driver_assignments a LEFT JOIN users u ON u.id::text = a.driver_id
     WHERE a.vehicle_id=$1 ORDER BY a.assigned_at DESC`, [vehicleId]
  );
  return result.rows;
}
export async function getVehicleDriverSummary(vehicleId: string, client?: Queryable) {
  try {
    const result = await db(client).query(
      `SELECT a.driver_id AS id, u.email, u.status, a.assigned_at
       FROM vehicle_driver_assignments a
       JOIN users u ON u.id::text = a.driver_id
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
    `SELECT d.id, d.vehicle_id, d.license_id, d.document_type, d.document_number, d.issued_on,
       d.expires_on, d.original_filename, d.mime_type, d.byte_size, d.checksum, d.uploaded_by,
       d.uploaded_at, d.is_latest, d.superseded_at, vla.license_type, vla.vehicle_license_badge
       FROM vehicle_documents d
       LEFT JOIN vehicle_licensing_authorities vla ON vla.id = d.license_id
      WHERE d.vehicle_id=$1
      ORDER BY d.document_type, vla.license_type NULLS FIRST, d.uploaded_at DESC`,
    [vehicleId]
  );
  return result.rows.map((row) => ({ ...row, status: getDocumentStatus(row.expires_on) }));
}

export async function listLatestVehicleRecordDocuments(vehicleId: string, client?: Queryable) {
  const categoryFilters = Array.from(new Set(
    VEHICLE_RECORD_DOCUMENT_TYPES.flatMap((type) => VEHICLE_RECORD_DOCUMENT_CATEGORY_ALIASES[type])
  ));
  const result = await db(client).query(
    `SELECT id, document_type, storage_key, original_filename, mime_type, uploaded_at
       FROM vehicle_documents
      WHERE vehicle_id = $1
        AND is_latest = TRUE
        AND document_type = ANY($2::text[])`,
    [vehicleId, categoryFilters]
  );
  const entries = new Map<string, any>();
  for (const row of result.rows) {
    const canonicalType = normalizeVehicleRecordDocumentCategory(row.document_type);
    if (!canonicalType) continue;
    const current = entries.get(canonicalType);
    if (!current || new Date(row.uploaded_at).getTime() >= new Date(current.uploaded_at).getTime()) {
      entries.set(canonicalType, row);
    }
  }
  return VEHICLE_RECORD_DOCUMENT_TYPES.map((type) => {
    const row = entries.get(type);
    return {
      id: row?.id || null,
      documentType: type,
      storageKey: row?.storage_key || null,
      originalFilename: row?.original_filename || null,
      mimeType: row?.mime_type || null,
      uploadedAt: row?.uploaded_at || null
    };
  });
}

export type VehicleEntityDocument = {
  id: string;
  entity_type: "vehicle";
  entity_id: string;
  category: string;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  checksum: string;
  storage_path: string;
  uploaded_by: string | null;
  uploaded_at: string;
};

export async function listVehicleEntityDocuments(vehicleId: string, category?: string, client?: Queryable): Promise<VehicleEntityDocument[]> {
  const normalizedCategory = text(category) ? normalizeVehicleRecordDocumentCategory(text(category)) : null;
  const categoryFilter = normalizedCategory ? VEHICLE_RECORD_DOCUMENT_CATEGORY_ALIASES[normalizedCategory] : [];
  const result = await db(client).query<VehicleEntityDocument>(
    `SELECT id, entity_type, entity_id, category, original_filename, mime_type, byte_size, checksum, storage_path, uploaded_by, uploaded_at
      FROM entity_documents
      WHERE entity_type = 'vehicle' AND entity_id = $1
        AND ($2 = '' OR category = ANY($3::text[]))
      ORDER BY category, uploaded_at DESC, id DESC`,
    [vehicleId, text(category), categoryFilter]
  );
  return result.rows.map((row) => ({
    ...row,
    category: normalizeVehicleRecordDocumentCategory(row.category) || row.category,
    byte_size: Number(row.byte_size)
  }));
}

export async function getVehicleEntityDocument(documentId: string, client?: Queryable): Promise<VehicleEntityDocument | null> {
  const result = await db(client).query<VehicleEntityDocument>(
    `SELECT id, entity_type, entity_id, category, original_filename, mime_type, byte_size, checksum, storage_path, uploaded_by, uploaded_at
       FROM entity_documents
      WHERE id = $1 AND entity_type = 'vehicle'`,
    [documentId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, byte_size: Number(row.byte_size) };
}

export async function logVehicleDocumentAccess(input: {
  documentId: string;
  action: "upload" | "view" | "download";
  actorId?: string | null;
}, client?: Queryable): Promise<void> {
  await db(client).query(
    `INSERT INTO document_access_events (id, document_id, action, actor_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), input.documentId, input.action, text(input.actorId) || null, new Date().toISOString()]
  );
}

export function normalizeVehicleRecordDocumentCategory(value: string): VehicleRecordDocumentType | null {
  const category = text(value).toLowerCase();
  return VEHICLE_RECORD_DOCUMENT_CATEGORY_TO_CANONICAL[category] || null;
}

function normalizeDocumentCategory(value: string): VehicleRecordDocumentType {
  const category = normalizeVehicleRecordDocumentCategory(value);
  if (!category || !VEHICLE_RECORD_DOCUMENT_CATEGORIES.includes(category)) {
    throw new Error("Select a valid record document category.");
  }
  return category;
}

export async function saveVehicleEntityDocument(input: {
  vehicleId: string;
  category: string;
  file: VehicleDocumentUpload;
  uploadedBy?: string;
}, client?: Queryable): Promise<VehicleEntityDocument> {
  const category = normalizeDocumentCategory(input.category);
  validateVehicleDocumentUpload(input.file);
  if (!input.file.buffer?.length) throw new Error("Upload a non-empty document.");
  if (input.file.buffer.length > VEHICLE_DOCUMENT_MAX_BYTES) throw new Error("Document exceeds maximum file size.");
  let storagePath: string | undefined;
  let fileWritten = false;
  try {
    return await withVehicleTransaction(client, async (runner) => {
      const vehicle = await runner.query<{ registration: string; vehicle_license_type: string | null }>(
        "SELECT registration, vehicle_license_type FROM vehicles WHERE id=$1 FOR UPDATE",
        [input.vehicleId]
      );
      if (!vehicle.rows[0]) throw new Error("Vehicle not found.");
      const existing = await runner.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM entity_documents
          WHERE entity_type='vehicle' AND entity_id=$1 AND category=$2`,
        [input.vehicleId, category]
      );
      if (Number(existing.rows[0]?.count || 0) >= DOCUMENT_MAX_FILES_PER_CATEGORY) {
        throw new Error(`Maximum files reached for ${category}.`);
      }
      const uploadedAt = new Date().toISOString();
      storagePath = buildEntityVaultRelativePath({
        entityType: "vehicle",
        uploadedAt,
        entityId: input.vehicleId,
        registrationOrBadge: vehicle.rows[0].registration || input.vehicleId,
        vehicleLicenseType: vehicle.rows[0].vehicle_license_type,
        category,
        originalFilename: input.file.originalname
      });
      await writeVaultFile(storagePath, input.file.buffer);
      fileWritten = true;
      const id = randomUUID();
      const originalFilename = sanitizeVaultFilename(input.file.originalname || "");
      const checksum = createHash("sha256").update(input.file.buffer).digest("hex");
      await runner.query(
        `INSERT INTO entity_documents
           (id, entity_type, entity_id, category, original_filename, mime_type, byte_size, checksum, storage_path, uploaded_by, uploaded_at)
         VALUES ($1, 'vehicle', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, input.vehicleId, category, originalFilename, text(input.file.mimetype).toLowerCase(), input.file.buffer.length, checksum, storagePath, text(input.uploadedBy) || null, uploadedAt]
      );
      await logVehicleDocumentAccess({ documentId: id, action: "upload", actorId: input.uploadedBy || null }, runner);
      return {
        id,
        entity_type: "vehicle",
        entity_id: input.vehicleId,
        category,
        original_filename: originalFilename,
        mime_type: text(input.file.mimetype).toLowerCase(),
        byte_size: input.file.buffer.length,
        checksum,
        storage_path: storagePath,
        uploaded_by: text(input.uploadedBy) || null,
        uploaded_at: uploadedAt
      };
    });
  } catch (error) {
    if (fileWritten && storagePath) {
      try {
        await removeVaultFile(storagePath);
      } catch {
        // Preserve the persistence error; cleanup is best-effort.
      }
    }
    throw error;
  }
}

export async function readVehicleEntityDocumentContent(documentId: string, client?: Queryable): Promise<{ document: VehicleEntityDocument; content: Buffer } | null> {
  const document = await getVehicleEntityDocument(documentId, client);
  if (!document) return null;
  const content = await readVaultFile(document.storage_path);
  return { document, content };
}

function sanitizeOriginalFilename(name: string): string {
  const base = path.basename(text(name));
  const cleaned = base.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "document";
  return cleaned.slice(0, 255);
}

function buildVehicleDocumentStorageKey(vehicleId: string, documentType: string, originalFilename: string): string {
  const extension = sanitizeOriginalFilename(originalFilename).match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "bin";
  return `vehicles/${encodeURIComponent(vehicleId)}/documents/${documentType}/${randomUUID()}.${extension}`;
}

export async function createVehicleDocument(input: {
  vehicleId: string; documentType: string; documentNumber?: string; issuedOn?: string;
  expiresOn?: string; originalFilename?: string; mimeType?: string; content?: Buffer; uploadedBy?: string;
  licenseId?: string | null; storageKey?: string;
}, client?: Queryable) {
  const requestedDocumentType = text(input.documentType).toLowerCase();
  if (!VEHICLE_DOCUMENT_TYPES.includes(requestedDocumentType as VehicleDocumentType)) throw new Error("Select a valid compliance document type.");
  const documentType = requestedDocumentType === "council_mechanical_check" ? "mec" : requestedDocumentType;
  if (input.expiresOn && getDocumentStatus(input.expiresOn) === "Expired") throw new Error("Enter a valid current or future expiry date.");
  if (!input.content?.length) throw new Error("Upload a non-empty vehicle document.");
  if (input.content.length > VEHICLE_DOCUMENT_MAX_BYTES) throw new Error("Vehicle documents must not exceed 10 MB.");
  validateVehicleDocumentUpload({
    originalname: input.originalFilename || "",
    mimetype: input.mimeType || "",
    buffer: input.content
  });
  if (documentType === "hackney_ph_badge" && !input.licenseId) {
    throw new Error("Select the vehicle licence that this badge document belongs to.");
  }
  return withVehicleTransaction(client, async (runner) => {
    if (input.licenseId) {
      const license = await runner.query(
        "SELECT 1 FROM vehicle_licensing_authorities WHERE id=$1 AND vehicle_id=$2",
        [input.licenseId, input.vehicleId]
      );
      if (!license.rows[0]) throw new Error("Select a licence belonging to this vehicle.");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const byteSize = input.content!.length;
    const checksum = createHash("sha256").update(input.content!).digest("hex");
    const originalFilename = sanitizeOriginalFilename(input.originalFilename || "");
    const storageKey = text(input.storageKey) || buildVehicleDocumentStorageKey(input.vehicleId, documentType, originalFilename);
    await runner.query(
      `UPDATE vehicle_documents
       SET is_latest = FALSE, superseded_at = $3
       WHERE vehicle_id = $1 AND document_type = $2
         AND license_id IS NOT DISTINCT FROM $4 AND is_latest = TRUE`,
      [input.vehicleId, documentType, now, input.licenseId || null]
    );
    await runner.query(
      `INSERT INTO vehicle_documents
        (id, vehicle_id, license_id, document_type, document_number, issued_on, expires_on,
         original_filename, mime_type, storage_key, byte_size, checksum, content, uploaded_by, uploaded_at, is_latest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE)`,
      [id, input.vehicleId, input.licenseId || null, documentType, text(input.documentNumber) || null,
        input.issuedOn || null, input.expiresOn || null, originalFilename || null, input.mimeType || null,
        storageKey, byteSize, checksum, input.content, input.uploadedBy || null, now]
    );
    return id;
  });
}
export async function getVehicleDocument(id: string, client?: Queryable) {
  const result = await db(client).query(
    "SELECT * FROM vehicle_documents WHERE id=$1",
    [id]
  );
  return result.rows[0] || null;
}
export async function consumeVehicleDocumentUploadRateLimit(rateLimitKey: string, client?: Queryable): Promise<boolean> {
  return consumeVehicleRateLimit(rateLimitKey, VEHICLE_DOCUMENT_UPLOAD_LIMIT, client);
}
export async function consumeVehicleDocumentDownloadRateLimit(rateLimitKey: string, client?: Queryable): Promise<boolean> {
  return consumeVehicleRateLimit(rateLimitKey, VEHICLE_DOCUMENT_DOWNLOAD_LIMIT, client);
}
export async function consumeVehicleMutationRateLimit(rateLimitKey: string, client?: Queryable): Promise<boolean> {
  return consumeVehicleRateLimit(rateLimitKey, VEHICLE_MUTATION_LIMIT, client);
}
async function consumeVehicleRateLimit(rateLimitKey: string, limit: number, client?: Queryable): Promise<boolean> {
  const result = await db(client).query<{ allowed: boolean }>(
    `INSERT INTO vehicle_document_upload_rate_limits (rate_limit_key, window_started_at, request_count)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (rate_limit_key) DO UPDATE SET
       request_count = CASE WHEN vehicle_document_upload_rate_limits.window_started_at <= now() - interval '1 minute'
         THEN 1 ELSE vehicle_document_upload_rate_limits.request_count + 1 END,
       window_started_at = CASE WHEN vehicle_document_upload_rate_limits.window_started_at <= now() - interval '1 minute'
         THEN date_trunc('minute', now()) ELSE vehicle_document_upload_rate_limits.window_started_at END
     RETURNING request_count <= $2 AS allowed`, [rateLimitKey, limit]
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
  const mime = text(file.mimetype).toLowerCase();
  if (!format || mime !== format.mime || !format.signature(file.buffer) || !DOCUMENT_ALLOWED_MIME.includes(mime)) {
    throw new Error("Only valid PDF, JPEG, and PNG documents are accepted.");
  }
}
