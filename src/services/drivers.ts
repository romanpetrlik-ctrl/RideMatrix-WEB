import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { DOCUMENT_MAX_FILES_PER_CATEGORY } from "../config/documents";
import { getPool } from "../database/connection";
import { buildEntityVaultRelativePath, readVaultFile, removeVaultFile, sanitizeOriginalFilename, writeVaultFile } from "./document-vault";
import { validateVehicleDocumentUpload, VEHICLE_DOCUMENT_MAX_BYTES } from "./vehicles";

export const DRIVER_STATUS_FILTERS = ["", "active", "inactive"] as const;
export const DRIVER_DOCUMENT_CATEGORIES = [
  "driver_licence",
  "private_hire_badge",
  "dbs_check",
  "right_to_work",
  "medical_certificate"
] as const;

export type DriverDocumentCategory = (typeof DRIVER_DOCUMENT_CATEGORIES)[number];

export const DRIVER_DOCUMENT_LABELS: Array<{ category: DriverDocumentCategory; label: string }> = [
  { category: "driver_licence", label: "Driver licence" },
  { category: "private_hire_badge", label: "Private hire badge" },
  { category: "dbs_check", label: "DBS check" },
  { category: "right_to_work", label: "Right to work" },
  { category: "medical_certificate", label: "Medical certificate" }
];

export type DriverDirectoryRecord = {
  id: string;
  email: string;
  status: string | null;
  firstName: string | null;
  lastName: string | null;
  shortName: string | null;
  profileComplete: boolean;
  licenceCount: number;
  documentsCount: number;
};

export type DriverProfile = {
  id: string;
  email: string;
  status: string | null;
  firstName: string;
  lastName: string;
  shortName: string;
  createdAt: string;
  updatedAt: string;
};

export type DriverProfileInput = {
  firstName: string;
  lastName: string;
};

export type DriverLicenseRecord = {
  id: string;
  driverId: string;
  licensingAuthorityId: string | null;
  licensingAuthorityName: string | null;
  licenseReference: string | null;
  validFrom: string;
  validUntil: string | null;
  active: boolean;
  revokedAt: string | null;
  notes: string | null;
};

export type DriverEntityDocument = {
  id: string;
  entity_type: "driver";
  entity_id: string;
  category: DriverDocumentCategory;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  checksum: string;
  storage_path: string;
  uploaded_by: string | null;
  uploaded_at: string;
};

type Queryable = Pool | PoolClient;

const DRIVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const text = (value: unknown): string => String(value ?? "").trim();

export const DRIVER_DEFAULT_PER_PAGE = 25;

function db(client?: Queryable): Queryable {
  return client || getPool();
}

function toDriverDirectoryRecord(row: {
  id: string;
  email: string;
  status: string | null;
  first_name: string | null;
  last_name: string | null;
  short_name: string | null;
  licence_count: string | number | null;
  documents_count: string | number | null;
}): DriverDirectoryRecord {
  const firstName = row.first_name?.trim() || null;
  const lastName = row.last_name?.trim() || null;
  const shortName = row.short_name?.trim() || null;
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    firstName,
    lastName,
    shortName,
    profileComplete: Boolean(firstName && lastName && shortName),
    licenceCount: Number(row.licence_count || 0),
    documentsCount: Number(row.documents_count || 0)
  };
}

export function isValidDriverId(value: unknown): value is string {
  return typeof value === "string" && DRIVER_ID_PATTERN.test(value);
}

function normalizeName(value: unknown, fieldLabel: string): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${fieldLabel} must not contain control characters.`);
  }
  const normalized = value.trim();
  if (!normalized) throw new Error(`${fieldLabel} is required.`);
  if (normalized.length > 100) throw new Error(`${fieldLabel} must be 100 characters or fewer.`);
  return normalized;
}

export function buildDriverShortName(firstName: string, lastName: string): string {
  const first = firstName.trim();
  const lastInitial = Array.from(lastName.trim())[0] || "";
  const short = `${first} ${lastInitial.toUpperCase()}`.trim();
  return short.slice(0, 160);
}

export function normalizeDriverProfileInput(input: DriverProfileInput): {
  firstName: string;
  lastName: string;
  shortName: string;
} {
  const firstName = normalizeName(input.firstName, "First name");
  const lastName = normalizeName(input.lastName, "Last name");
  const shortName = buildDriverShortName(firstName, lastName);
  if (!shortName) throw new Error("Short name could not be generated.");
  return { firstName, lastName, shortName };
}

function normalizeDriverStatusFilter(value: unknown): "" | "active" | "inactive" {
  const normalized = text(value).toLowerCase();
  if (normalized === "active" || normalized === "inactive") return normalized;
  return "";
}

function normalizePagination(page: unknown, perPage: unknown): { page: number; perPage: number } {
  const normalizedPage = Number(page);
  const normalizedPerPage = Number(perPage);
  return {
    page: Number.isInteger(normalizedPage) && normalizedPage > 0 ? normalizedPage : 1,
    perPage: Number.isInteger(normalizedPerPage) && normalizedPerPage > 0 && normalizedPerPage <= 100
      ? normalizedPerPage
      : DRIVER_DEFAULT_PER_PAGE
  };
}

function withSearchTokens(search: string): string[] {
  return search
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
}

function profileNameExpression(userAlias = "u", profileAlias = "dp"): string {
  return `COALESCE(
    NULLIF(btrim(${profileAlias}.short_name), ''),
    NULLIF(btrim(concat_ws(' ',
      NULLIF(btrim(${profileAlias}.first_name), ''),
      NULLIF(btrim(${profileAlias}.last_name), '')
    )), ''),
    NULLIF(btrim(to_jsonb(${userAlias}) ->> 'full_name'), ''),
    NULLIF(btrim(concat_ws(' ',
      NULLIF(btrim(to_jsonb(${userAlias}) ->> 'first_name'), ''),
      NULLIF(btrim(to_jsonb(${userAlias}) ->> 'last_name'), '')
    )), ''),
    NULLIF(btrim(to_jsonb(${userAlias}) ->> 'driver_code'), ''),
    ${userAlias}.email,
    'Driver #' || ${userAlias}.id::text
  )`;
}

export async function listDrivers(params: {
  search?: string;
  status?: unknown;
  page?: number;
  perPage?: number;
  client?: Queryable;
} = {}): Promise<{
  drivers: DriverDirectoryRecord[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
  search: string;
  status: "" | "active" | "inactive";
}> {
  const search = text(params.search);
  const status = normalizeDriverStatusFilter(params.status);
  const { page, perPage } = normalizePagination(params.page, params.perPage);
  const offset = (page - 1) * perPage;
  const searchTokens = withSearchTokens(search);
  const searchPattern = `%${search.toLowerCase()}%`;

  const result = await db(params.client).query<{
    id: string;
    email: string;
    status: string | null;
    first_name: string | null;
    last_name: string | null;
    short_name: string | null;
    licence_count: string;
    documents_count: string;
    total_count: string;
  }>(
    `WITH base AS (
       SELECT
         u.id::text AS id,
         u.email,
         u.status,
         dp.first_name,
         dp.last_name,
         dp.short_name,
         (SELECT count(*)::int FROM driver_licensing_authorities d WHERE d.driver_id = u.id::text) AS licence_count,
         (SELECT count(*)::int FROM entity_documents d WHERE d.entity_type = 'driver' AND d.entity_id = u.id::text) AS documents_count,
         ${profileNameExpression("u", "dp")} AS sort_name
       FROM users u
       LEFT JOIN driver_profiles dp ON dp.driver_id = u.id::text
       WHERE EXISTS (
         SELECT 1 FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id AND r.key = 'driver'
       )
         AND ($1 = '' OR lower(COALESCE(u.status::text, '')) = $1)
         AND (
           $2 = ''
           OR lower(u.email) LIKE $3
           OR lower(COALESCE(dp.first_name, '')) LIKE $3
           OR lower(COALESCE(dp.last_name, '')) LIKE $3
           OR lower(COALESCE(dp.short_name, '')) LIKE $3
         )
         AND (
           $4::text[] = '{}'::text[]
           OR EXISTS (
             SELECT 1
             FROM unnest($4::text[]) token
             WHERE lower(u.email) LIKE '%' || token || '%'
                OR lower(COALESCE(dp.first_name, '')) LIKE '%' || token || '%'
                OR lower(COALESCE(dp.last_name, '')) LIKE '%' || token || '%'
                OR lower(COALESCE(dp.short_name, '')) LIKE '%' || token || '%'
           )
         )
     )
     SELECT id, email, status, first_name, last_name, short_name,
       licence_count::text, documents_count::text,
       count(*) OVER()::text AS total_count
     FROM base
     ORDER BY lower(sort_name), lower(email), id
     OFFSET $5 LIMIT $6`,
    [status, search.toLowerCase(), searchPattern, searchTokens, offset, perPage]
  );

  const total = Number(result.rows[0]?.total_count || 0);
  const totalPages = total === 0 ? 1 : Math.ceil(total / perPage);

  return {
    drivers: result.rows.map(toDriverDirectoryRecord),
    total,
    page,
    perPage,
    totalPages,
    search,
    status
  };
}

export async function listUnprofiledDriverAccounts(client?: Queryable): Promise<Array<{ id: string; email: string }>> {
  const result = await db(client).query<{ id: string; email: string }>(
    `SELECT u.id::text AS id, u.email
     FROM users u
     WHERE EXISTS (
       SELECT 1 FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = u.id AND r.key = 'driver'
     )
       AND NOT EXISTS (
         SELECT 1 FROM driver_profiles dp
         WHERE dp.driver_id = u.id::text
       )
     ORDER BY lower(u.email), u.id::text`
  );
  return result.rows;
}

export async function getDriverById(driverId: string, client?: Queryable): Promise<DriverProfile | null> {
  if (!isValidDriverId(driverId)) return null;
  const result = await db(client).query<{
    id: string;
    email: string;
    status: string | null;
    first_name: string | null;
    last_name: string | null;
    short_name: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>(
    `SELECT
       u.id::text AS id,
       u.email,
       u.status,
       dp.first_name,
       dp.last_name,
       dp.short_name,
       dp.created_at,
       dp.updated_at
     FROM users u
     LEFT JOIN driver_profiles dp ON dp.driver_id = u.id::text
     WHERE u.id::text = $1
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id AND r.key = 'driver'
       )`,
    [driverId]
  );
  const row = result.rows[0];
  if (!row || !row.first_name || !row.last_name || !row.short_name || !row.created_at || !row.updated_at) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    firstName: row.first_name,
    lastName: row.last_name,
    shortName: row.short_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function ensureDriverAccount(driverId: string, client?: Queryable): Promise<boolean> {
  const result = await db(client).query<{ id: string }>(
    `SELECT u.id::text AS id
     FROM users u
     WHERE u.id::text = $1
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id AND r.key = 'driver'
       )`,
    [driverId]
  );
  return Boolean(result.rows[0]);
}

export class DriverValidationError extends Error {}

export async function createDriverProfile(
  driverId: string,
  input: DriverProfileInput,
  client?: Queryable
): Promise<DriverProfile> {
  if (!isValidDriverId(driverId)) throw new DriverValidationError("Select a valid driver account.");
  const valid = await ensureDriverAccount(driverId, client);
  if (!valid) throw new DriverValidationError("Select a valid driver account.");
  const profile = normalizeDriverProfileInput(input);
  const now = new Date().toISOString();
  await db(client).query(
    `INSERT INTO driver_profiles
      (driver_id, first_name, last_name, short_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (driver_id) DO NOTHING`,
    [driverId, profile.firstName, profile.lastName, profile.shortName, now]
  );
  const saved = await getDriverById(driverId, client);
  if (!saved) throw new DriverValidationError("Driver profile already exists for this account.");
  return saved;
}

export async function updateDriverProfile(
  driverId: string,
  input: DriverProfileInput,
  client?: Queryable
): Promise<DriverProfile | null> {
  if (!isValidDriverId(driverId)) return null;
  if (!(await ensureDriverAccount(driverId, client))) return null;
  const profile = normalizeDriverProfileInput(input);
  const now = new Date().toISOString();
  const result = await db(client).query(
    `UPDATE driver_profiles
        SET first_name = $2,
            last_name = $3,
            short_name = $4,
            updated_at = $5
      WHERE driver_id = $1`,
    [driverId, profile.firstName, profile.lastName, profile.shortName, now]
  );
  if (!result.rowCount) return null;
  return getDriverById(driverId, client);
}

export async function listDriverLicenses(driverId: string, client?: Queryable): Promise<DriverLicenseRecord[]> {
  const result = await db(client).query<{
    id: string;
    driver_id: string;
    licensing_authority_id: string | null;
    authority_name: string | null;
    license_reference: string | null;
    valid_from: string;
    valid_until: string | null;
    active: boolean;
    revoked_at: string | null;
    notes: string | null;
  }>(
    `SELECT dl.*, la.name AS authority_name
     FROM driver_licensing_authorities dl
     LEFT JOIN licensing_authorities la ON la.id = dl.licensing_authority_id
     WHERE dl.driver_id = $1
     ORDER BY dl.active DESC, dl.valid_from DESC,
       COALESCE(la.preference_order, 2147483647), lower(COALESCE(la.name, '')), dl.id`,
    [driverId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    driverId: row.driver_id,
    licensingAuthorityId: row.licensing_authority_id,
    licensingAuthorityName: row.authority_name,
    licenseReference: row.license_reference,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    active: Boolean(row.active),
    revokedAt: row.revoked_at,
    notes: row.notes
  }));
}

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function normalizeDriverLicenseInput(input: {
  licensingAuthorityId?: string;
  licenseReference?: string;
  validFrom?: string;
  validUntil?: string;
  notes?: string;
}): {
  licensingAuthorityId: string | null;
  licenseReference: string | null;
  validFrom: string;
  validUntil: string | null;
  notes: string | null;
} {
  const validFrom = text(input.validFrom);
  const validUntil = text(input.validUntil);
  if (!isValidIsoDate(validFrom)) throw new DriverValidationError("Enter a valid licence start date.");
  if (validUntil && (!isValidIsoDate(validUntil) || validUntil <= validFrom)) {
    throw new DriverValidationError("Licence end date must be after its start date.");
  }
  return {
    licensingAuthorityId: text(input.licensingAuthorityId) || null,
    licenseReference: text(input.licenseReference) || null,
    validFrom,
    validUntil: validUntil || null,
    notes: text(input.notes) || null
  };
}

export async function saveDriverLicense(
  driverId: string,
  input: {
    licensingAuthorityId?: string;
    licenseReference?: string;
    validFrom?: string;
    validUntil?: string;
    notes?: string;
  },
  licenseId?: string,
  client?: Queryable
): Promise<string | null> {
  const normalized = normalizeDriverLicenseInput(input);
  const now = new Date().toISOString();
  if (licenseId) {
    const update = await db(client).query(
      `UPDATE driver_licensing_authorities
          SET licensing_authority_id = $3,
              license_reference = $4,
              valid_from = $5,
              valid_until = $6,
              notes = $7,
              active = TRUE,
              revoked_at = NULL,
              updated_at = $8
        WHERE id = $1 AND driver_id = $2`,
      [licenseId, driverId, normalized.licensingAuthorityId, normalized.licenseReference, normalized.validFrom, normalized.validUntil, normalized.notes, now]
    );
    return update.rowCount ? licenseId : null;
  }
  const id = randomUUID();
  await db(client).query(
    `INSERT INTO driver_licensing_authorities
      (id, driver_id, licensing_authority_id, license_reference, valid_from, valid_until, active, notes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, $8)`,
    [id, driverId, normalized.licensingAuthorityId, normalized.licenseReference, normalized.validFrom, normalized.validUntil, normalized.notes, now]
  );
  return id;
}

function normalizeDriverDocumentCategory(value: unknown): DriverDocumentCategory {
  const category = text(value).toLowerCase();
  if (!DRIVER_DOCUMENT_CATEGORIES.includes(category as DriverDocumentCategory)) {
    throw new DriverValidationError("Select a valid driver document category.");
  }
  return category as DriverDocumentCategory;
}

function withDriverTransaction<T>(
  client: Queryable | undefined,
  work: (runner: Queryable) => Promise<T>
): Promise<T> {
  const runner = client || getPool();
  if ("connect" in runner && typeof runner.connect === "function") {
    return (async () => {
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
    })();
  }
  return work(runner);
}

export async function listDriverEntityDocuments(driverId: string, client?: Queryable): Promise<DriverEntityDocument[]> {
  const result = await db(client).query<DriverEntityDocument>(
    `SELECT id, entity_type, entity_id, category, original_filename, mime_type, byte_size, checksum, storage_path, uploaded_by, uploaded_at
      FROM entity_documents
      WHERE entity_type = 'driver' AND entity_id = $1
      ORDER BY category, uploaded_at DESC, id DESC`,
    [driverId]
  );
  return result.rows.map((row) => ({
    ...row,
    category: normalizeDriverDocumentCategory(row.category),
    byte_size: Number(row.byte_size)
  }));
}

export async function getDriverEntityDocument(documentId: string, client?: Queryable): Promise<DriverEntityDocument | null> {
  const result = await db(client).query<DriverEntityDocument>(
    `SELECT id, entity_type, entity_id, category, original_filename, mime_type, byte_size, checksum, storage_path, uploaded_by, uploaded_at
      FROM entity_documents
      WHERE id = $1 AND entity_type = 'driver'`,
    [documentId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    category: normalizeDriverDocumentCategory(row.category),
    byte_size: Number(row.byte_size)
  };
}

export async function logDriverDocumentAccess(input: {
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

export type DriverDocumentUpload = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

export async function saveDriverEntityDocument(input: {
  driverId: string;
  category: string;
  file: DriverDocumentUpload;
  uploadedBy?: string;
}, client?: Queryable): Promise<DriverEntityDocument> {
  const category = normalizeDriverDocumentCategory(input.category);
  validateVehicleDocumentUpload(input.file);
  if (!input.file.buffer?.length) throw new DriverValidationError("Upload a non-empty document.");
  if (input.file.buffer.length > VEHICLE_DOCUMENT_MAX_BYTES) {
    throw new DriverValidationError("Document exceeds maximum file size.");
  }

  let storagePath: string | undefined;
  let fileWritten = false;

  try {
    return await withDriverTransaction(client, async (runner) => {
      if (!(await ensureDriverAccount(input.driverId, runner))) {
        throw new DriverValidationError("Driver not found.");
      }
      const profile = await runner.query<{ first_name: string | null; last_name: string | null }>(
        `SELECT first_name, last_name FROM driver_profiles WHERE driver_id = $1`,
        [input.driverId]
      );
      const displayName = `${text(profile.rows[0]?.first_name)} ${text(profile.rows[0]?.last_name)}`.trim() || input.driverId;
      const existing = await runner.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM entity_documents
         WHERE entity_type = 'driver' AND entity_id = $1 AND category = $2`,
        [input.driverId, category]
      );
      if (Number(existing.rows[0]?.count || 0) >= DOCUMENT_MAX_FILES_PER_CATEGORY) {
        throw new DriverValidationError(`Maximum files reached for ${category}.`);
      }

      const uploadedAt = new Date().toISOString();
      storagePath = buildEntityVaultRelativePath({
        entityType: "driver",
        uploadedAt,
        entityId: input.driverId,
        displayName,
        category,
        originalFilename: input.file.originalname
      });
      await writeVaultFile(storagePath, input.file.buffer);
      fileWritten = true;

      const id = randomUUID();
      const originalFilename = sanitizeOriginalFilename(input.file.originalname || "");
      const checksum = createHash("sha256").update(input.file.buffer).digest("hex");
      const mimeType = text(input.file.mimetype).toLowerCase();

      await runner.query(
        `INSERT INTO entity_documents
          (id, entity_type, entity_id, category, original_filename, mime_type, byte_size, checksum, storage_path, uploaded_by, uploaded_at)
         VALUES ($1, 'driver', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          input.driverId,
          category,
          originalFilename,
          mimeType,
          input.file.buffer.length,
          checksum,
          storagePath,
          text(input.uploadedBy) || null,
          uploadedAt
        ]
      );
      await logDriverDocumentAccess({ documentId: id, action: "upload", actorId: input.uploadedBy || null }, runner);
      return {
        id,
        entity_type: "driver",
        entity_id: input.driverId,
        category,
        original_filename: originalFilename,
        mime_type: mimeType,
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
        // Preserve the persistence failure.
      }
    }
    throw error;
  }
}

export async function readDriverEntityDocumentContent(documentId: string, client?: Queryable): Promise<{ document: DriverEntityDocument; content: Buffer } | null> {
  const document = await getDriverEntityDocument(documentId, client);
  if (!document) return null;
  const content = await readVaultFile(document.storage_path);
  return { document, content };
}
