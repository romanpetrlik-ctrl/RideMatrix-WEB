import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../database/connection";
import { isValidGeoPoint } from "./maps";

export type PoiRecord = {
  id: string;
  displayName: string;
  category: string;
  placeId: string;
  locationLabel: string;
  latitude: number;
  longitude: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type PoiFormValues = {
  id: string;
  displayName: string;
  category: string;
  placeId: string;
  locationLabel: string;
  latitude: string;
  longitude: string;
  notes: string;
};

export type PoiFeeRecord = {
  id: string;
  poiId: string;
  poiDisplayName: string;
  action: string;
  amount: string;
  currency: "GBP";
  feeBasis: string;
  trigger: "selection" | "confirmation";
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type PoiFeeFormValues = {
  id: string;
  poiId: string;
  action: string;
  amount: string;
  feeBasis: string;
  trigger: string;
  notes: string;
};

export type PoiManagementActor = {
  accountId: string | null;
  email: string;
};

export type PoiManagementStore = {
  listPois: () => Promise<PoiRecord[]>;
  getPoi: (id: string) => Promise<PoiRecord | null>;
  savePoi: (id: string | null, values: PoiFormValues, actor: PoiManagementActor) => Promise<PoiRecord | null>;
  deletePoi: (id: string, actor: PoiManagementActor) => Promise<"deleted" | "not-found" | "has-fees">;
  listFees: () => Promise<PoiFeeRecord[]>;
  getFee: (id: string) => Promise<PoiFeeRecord | null>;
  saveFee: (id: string | null, values: PoiFeeFormValues, actor: PoiManagementActor) => Promise<PoiFeeRecord | null>;
  deleteFee: (id: string, actor: PoiManagementActor) => Promise<boolean>;
};

export type PoiValidation = {
  values: PoiFormValues;
  errors: Record<string, string>;
};

export type PoiFeeValidation = {
  values: PoiFeeFormValues;
  errors: Record<string, string>;
};

const EMPTY_POI_FORM: PoiFormValues = {
  id: "",
  displayName: "",
  category: "",
  placeId: "",
  locationLabel: "",
  latitude: "",
  longitude: "",
  notes: ""
};

const EMPTY_FEE_FORM: PoiFeeFormValues = {
  id: "",
  poiId: "",
  action: "",
  amount: "",
  feeBasis: "",
  trigger: "",
  notes: ""
};

function submittedText(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key] as string : "";
}

function submittedBody(submitted: unknown): Record<string, unknown> {
  return submitted && typeof submitted === "object" ? submitted as Record<string, unknown> : {};
}

function validCoordinate(value: string): boolean {
  return value.length <= 32 && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) && Number.isFinite(Number(value));
}

function normalizeAmount(value: string): string | null {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) return null;
  return value.includes(".") ? value.padEnd(value.indexOf(".") + 3, "0") : `${value}.00`;
}

export function validatePoiForm(submitted: unknown): PoiValidation {
  const body = submittedBody(submitted);
  const values = { ...EMPTY_POI_FORM };
  (Object.keys(values) as (keyof PoiFormValues)[]).forEach((key) => {
    values[key] = submittedText(body, key);
  });

  const errors: Record<string, string> = {};
  const displayName = values.displayName.trim();
  const category = values.category.trim();
  const placeId = values.placeId.trim();
  const locationLabel = values.locationLabel.trim();
  const latitude = values.latitude.trim();
  const longitude = values.longitude.trim();
  const point = {
    latitude: validCoordinate(latitude) ? Number(latitude) : NaN,
    longitude: validCoordinate(longitude) ? Number(longitude) : NaN
  };

  if (!displayName || displayName.length > 160) {
    errors.displayName = displayName ? "Enter a POI name no longer than 160 characters." : "Enter a POI display name.";
  }
  if (!category || category.length > 100) {
    errors.category = category ? "Enter a POI type no longer than 100 characters." : "Enter a POI type or category.";
  }
  if (!placeId || placeId.length > 500 || !locationLabel || locationLabel.length > 500 ||
      !validCoordinate(latitude) || !validCoordinate(longitude) || !isValidGeoPoint(point)) {
    errors.location = "Select a valid operational location from Google Places.";
  }
  if (values.notes.length > 2000) errors.notes = "Keep operator notes to 2,000 characters or fewer.";

  if (Object.keys(errors).length === 0) {
    values.id = values.id.trim();
    values.displayName = displayName;
    values.category = category;
    values.placeId = placeId;
    values.locationLabel = locationLabel;
    values.latitude = latitude;
    values.longitude = longitude;
    values.notes = values.notes.trim();
  }

  return { values, errors };
}

export function validatePoiFeeForm(submitted: unknown, availablePoiIds: string[]): PoiFeeValidation {
  const body = submittedBody(submitted);
  const values = { ...EMPTY_FEE_FORM };
  (Object.keys(values) as (keyof PoiFeeFormValues)[]).forEach((key) => {
    values[key] = submittedText(body, key);
  });

  const errors: Record<string, string> = {};
  const poiId = values.poiId.trim();
  const action = values.action.trim();
  const feeBasis = values.feeBasis.trim();
  const trigger = values.trigger.trim();
  const amount = normalizeAmount(values.amount.trim());

  if (!poiId || !availablePoiIds.includes(poiId)) errors.poiId = "Select an existing POI.";
  if (!action || action.length > 100) {
    errors.action = action ? "Enter an action or service no longer than 100 characters." : "Enter the applicable action or service.";
  }
  if (amount === null) errors.amount = "Enter a GBP amount from £0.00 to £999,999.99 with up to 2 decimal places.";
  if (!feeBasis || feeBasis.length > 100) {
    errors.feeBasis = feeBasis ? "Enter a fee basis no longer than 100 characters." : "Specify the fee basis or unit.";
  }
  if (trigger !== "selection" && trigger !== "confirmation") {
    errors.trigger = "Choose whether the fee follows POI/action selection or explicit optional-service confirmation.";
  }
  if (values.notes.length > 2000) errors.notes = "Keep notes to 2,000 characters or fewer.";

  if (Object.keys(errors).length === 0) {
    values.id = values.id.trim();
    values.poiId = poiId;
    values.action = action;
    values.amount = amount!;
    values.feeBasis = feeBasis;
    values.trigger = trigger;
    values.notes = values.notes.trim();
  }

  return { values, errors };
}

type PoiRow = {
  id: string;
  display_name: string;
  category: string;
  place_id: string;
  location_label: string;
  latitude: string | number;
  longitude: string | number;
  notes: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type PoiFeeRow = {
  id: string;
  poi_id: string;
  poi_display_name: string;
  action: string;
  amount: string;
  currency: "GBP";
  fee_basis: string;
  trigger_type: "selection" | "confirmation";
  notes: string;
  created_at: string | Date;
  updated_at: string | Date;
};

function toPoiRecord(row: PoiRow): PoiRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    category: row.category,
    placeId: row.place_id,
    locationLabel: row.location_label,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function toPoiFeeRecord(row: PoiFeeRow): PoiFeeRecord {
  return {
    id: row.id,
    poiId: row.poi_id,
    poiDisplayName: row.poi_display_name,
    action: row.action,
    amount: row.amount,
    currency: row.currency,
    feeBasis: row.fee_basis,
    trigger: row.trigger_type,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

const POI_COLUMNS = "id, display_name, category, place_id, location_label, latitude, longitude, notes, created_at, updated_at";
const FEE_COLUMNS = "f.id, f.poi_id, p.display_name AS poi_display_name, f.action, f.amount, f.currency, f.fee_basis, f.trigger_type, f.notes, f.created_at, f.updated_at";

export const poiManagementStore: PoiManagementStore = {
  async listPois() {
    const result = await query<PoiRow>(
      `SELECT ${POI_COLUMNS} FROM points_of_interest
        WHERE deleted_at IS NULL
        ORDER BY display_name, id`
    );
    return result.rows.map(toPoiRecord);
  },

  async getPoi(id) {
    const result = await query<PoiRow>(
      `SELECT ${POI_COLUMNS} FROM points_of_interest
        WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] ? toPoiRecord(result.rows[0]) : null;
  },

  async savePoi(id, values, actor) {
    return withTransaction(async (client) => {
      const params = [
        values.displayName,
        values.category,
        values.placeId,
        values.locationLabel,
        Number(values.latitude),
        Number(values.longitude),
        values.notes,
        actor.accountId,
        actor.email
      ];
      const result = id
        ? await client.query<PoiRow>(
          `UPDATE points_of_interest
              SET display_name = $2, category = $3, place_id = $4, location_label = $5,
                  latitude = $6, longitude = $7, notes = $8, updated_by_account_id = $9,
                  updated_by_email = $10, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING ${POI_COLUMNS}`,
          [id, ...params]
        )
        : await client.query<PoiRow>(
          `INSERT INTO points_of_interest (
             id, display_name, category, place_id, location_label, latitude, longitude, notes,
             created_by_account_id, created_by_email, updated_by_account_id, updated_by_email
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9, $10)
           RETURNING ${POI_COLUMNS}`,
          [randomUUID(), ...params]
        );
      if (!result.rows[0]) return null;
      const record = toPoiRecord(result.rows[0]);
      await client.query(
        `INSERT INTO points_of_interest_audit (poi_id, event_type, snapshot, actor_account_id, actor_email)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [record.id, id ? "updated" : "created", JSON.stringify(record), actor.accountId, actor.email]
      );
      return record;
    });
  },

  async deletePoi(id, actor) {
    return withTransaction(async (client) => {
      const current = await client.query<PoiRow>(
        `SELECT ${POI_COLUMNS} FROM points_of_interest
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [id]
      );
      if (!current.rows[0]) return "not-found";
      const fees = await client.query(
        `SELECT 1 FROM poi_fees WHERE poi_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [id]
      );
      if (fees.rows.length) return "has-fees";

      const result = await client.query<PoiRow>(
        `UPDATE points_of_interest
            SET deleted_at = CURRENT_TIMESTAMP, deleted_by_account_id = $2,
                deleted_by_email = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING ${POI_COLUMNS}`,
        [id, actor.accountId, actor.email]
      );
      if (!result.rows[0]) return "not-found";
      await client.query(
        `INSERT INTO points_of_interest_audit (poi_id, event_type, snapshot, actor_account_id, actor_email)
         VALUES ($1, 'deleted', $2::jsonb, $3, $4)`,
        [id, JSON.stringify(toPoiRecord(result.rows[0])), actor.accountId, actor.email]
      );
      return "deleted";
    });
  },

  async listFees() {
    const result = await query<PoiFeeRow>(
      `SELECT ${FEE_COLUMNS}
         FROM poi_fees f JOIN points_of_interest p ON p.id = f.poi_id
        WHERE f.deleted_at IS NULL AND p.deleted_at IS NULL
        ORDER BY p.display_name, f.action, f.id`
    );
    return result.rows.map(toPoiFeeRecord);
  },

  async getFee(id) {
    const result = await query<PoiFeeRow>(
      `SELECT ${FEE_COLUMNS}
         FROM poi_fees f JOIN points_of_interest p ON p.id = f.poi_id
        WHERE f.id = $1 AND f.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] ? toPoiFeeRecord(result.rows[0]) : null;
  },

  async saveFee(id, values, actor) {
    return withTransaction(async (client) => {
      const poi = await client.query(
        `SELECT id FROM points_of_interest
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [values.poiId]
      );
      if (!poi.rows[0]) return null;

      const params = [
        values.poiId,
        values.action,
        values.amount,
        values.feeBasis,
        values.trigger,
        values.notes,
        actor.accountId,
        actor.email
      ];
      const result = id
        ? await client.query<PoiFeeRow>(
          `UPDATE poi_fees f
              SET poi_id = $2, action = $3, amount = $4, fee_basis = $5, trigger_type = $6,
                  notes = $7, updated_by_account_id = $8, updated_by_email = $9,
                  updated_at = CURRENT_TIMESTAMP
             FROM points_of_interest p
            WHERE f.id = $1 AND p.id = $2 AND p.deleted_at IS NULL AND f.deleted_at IS NULL
            RETURNING f.id, f.poi_id, p.display_name AS poi_display_name, f.action, f.amount,
                      f.currency, f.fee_basis, f.trigger_type, f.notes, f.created_at, f.updated_at`,
          [id, ...params]
        )
        : await client.query<PoiFeeRow>(
          `INSERT INTO poi_fees (
             id, poi_id, action, amount, currency, fee_basis, trigger_type, notes,
             created_by_account_id, created_by_email, updated_by_account_id, updated_by_email
           )
           SELECT $1, p.id, $3, $4, 'GBP', $5, $6, $7, $8, $9, $8, $9
             FROM points_of_interest p
            WHERE p.id = $2 AND p.deleted_at IS NULL
           RETURNING id, poi_id, (SELECT display_name FROM points_of_interest WHERE id = poi_id) AS poi_display_name,
                     action, amount, currency, fee_basis, trigger_type, notes, created_at, updated_at`,
          [randomUUID(), ...params]
        );
      if (!result.rows[0]) return null;
      const record = toPoiFeeRecord(result.rows[0]);
      await client.query(
        `INSERT INTO poi_fees_audit (poi_fee_id, event_type, snapshot, actor_account_id, actor_email)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [record.id, id ? "updated" : "created", JSON.stringify(record), actor.accountId, actor.email]
      );
      return record;
    });
  },

  async deleteFee(id, actor) {
    return withTransaction(async (client) => {
      const result = await client.query<PoiFeeRow>(
        `UPDATE poi_fees f
            SET deleted_at = CURRENT_TIMESTAMP, deleted_by_account_id = $2,
                deleted_by_email = $3, updated_at = CURRENT_TIMESTAMP
           FROM points_of_interest p
          WHERE f.id = $1 AND p.id = f.poi_id AND p.deleted_at IS NULL AND f.deleted_at IS NULL
          RETURNING f.id, f.poi_id, p.display_name AS poi_display_name, f.action, f.amount,
                    f.currency, f.fee_basis, f.trigger_type, f.notes, f.created_at, f.updated_at`,
        [id, actor.accountId, actor.email]
      );
      if (!result.rows[0]) return false;
      await client.query(
        `INSERT INTO poi_fees_audit (poi_fee_id, event_type, snapshot, actor_account_id, actor_email)
         VALUES ($1, 'deleted', $2::jsonb, $3, $4)`,
        [id, JSON.stringify(toPoiFeeRecord(result.rows[0])), actor.accountId, actor.email]
      );
      return true;
    });
  }
};

export function poiRecordToForm(record: PoiRecord): PoiFormValues {
  return {
    id: record.id,
    displayName: record.displayName,
    category: record.category,
    placeId: record.placeId,
    locationLabel: record.locationLabel,
    latitude: String(record.latitude),
    longitude: String(record.longitude),
    notes: record.notes
  };
}

export function poiFeeRecordToForm(record: PoiFeeRecord): PoiFeeFormValues {
  return {
    id: record.id,
    poiId: record.poiId,
    action: record.action,
    amount: record.amount,
    feeBasis: record.feeBasis,
    trigger: record.trigger,
    notes: record.notes
  };
}
