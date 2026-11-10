import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../database/connection";
import { isValidGeoPoint } from "./maps";

export type AirportFeeRecord = {
  id: string;
  displayName: string;
  dropoffPlaceId: string;
  dropoffLocationLabel: string;
  dropoffLatitude: number;
  dropoffLongitude: number;
  dropoffFee: string;
  pickupPlaceId: string;
  pickupLocationLabel: string;
  pickupLatitude: number;
  pickupLongitude: number;
  pickupFee: string;
  pickupTimeReference: "ALT" | "AGA" | null;
  pickupDeferredEnabled: boolean | null;
  pickupDeferredMinutes: number | null;
  pickupFeeCoveredMinutes: number | null;
  createdAt: string;
  updatedAt: string;
};

export type AirportFeeFormValues = {
  id: string;
  displayName: string;
  dropoffPlaceId: string;
  dropoffLocationLabel: string;
  dropoffLatitude: string;
  dropoffLongitude: string;
  dropoffFee: string;
  pickupPlaceId: string;
  pickupLocationLabel: string;
  pickupLatitude: string;
  pickupLongitude: string;
  pickupFee: string;
  pickupTimeReference: string;
  pickupDeferredPolicy: string;
  pickupDeferredMinutes: string;
  pickupFeeCoveredMinutes: string;
};

export type AirportFeeActor = {
  accountId: string | null;
  email: string;
};

export type AirportFeeStore = {
  list: () => Promise<AirportFeeRecord[]>;
  get: (id: string) => Promise<AirportFeeRecord | null>;
  save: (id: string | null, values: AirportFeeFormValues, actor: AirportFeeActor) => Promise<AirportFeeRecord | null>;
  archive: (id: string, actor: AirportFeeActor) => Promise<boolean>;
};

export type AirportFeeValidation = {
  values: AirportFeeFormValues;
  errors: Record<string, string>;
};

const EMPTY_FORM: AirportFeeFormValues = {
  id: "",
  displayName: "",
  dropoffPlaceId: "",
  dropoffLocationLabel: "",
  dropoffLatitude: "",
  dropoffLongitude: "",
  dropoffFee: "",
  pickupPlaceId: "",
  pickupLocationLabel: "",
  pickupLatitude: "",
  pickupLongitude: "",
  pickupFee: "",
  pickupTimeReference: "",
  pickupDeferredPolicy: "",
  pickupDeferredMinutes: "",
  pickupFeeCoveredMinutes: ""
};

function submittedText(body: Record<string, unknown>, key: keyof AirportFeeFormValues): string {
  return typeof body[key] === "string" ? body[key] as string : "";
}

function normalizeAmount(value: string): string | null {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) return null;
  return value.includes(".") ? value.padEnd(value.indexOf(".") + 3, "0") : `${value}.00`;
}

function validCoordinate(value: string): boolean {
  return value.length <= 32 && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) && Number.isFinite(Number(value));
}

export function validateAirportFeeForm(submitted: unknown): AirportFeeValidation {
  const body = submitted && typeof submitted === "object"
    ? submitted as Record<string, unknown>
    : {};
  const values = { ...EMPTY_FORM };
  (Object.keys(values) as (keyof AirportFeeFormValues)[]).forEach((key) => {
    values[key] = submittedText(body, key);
  });

  const errors: Record<string, string> = {};
  const displayName = values.displayName.trim();
  if (!displayName || displayName.length > 160) {
    errors.displayName = displayName ? "Enter an airport name no longer than 160 characters." : "Enter an airport display name.";
  }

  const normalizedAmounts: Partial<Record<"dropoffFee" | "pickupFee", string>> = {};
  for (const operation of ["dropoff", "pickup"] as const) {
    const operationLabel = operation === "dropoff" ? "drop-off" : "pick-up";
    const locationField = `${operation}Location` as const;
    const placeIdField = `${operation}PlaceId` as const;
    const labelField = `${operation}LocationLabel` as const;
    const latitudeField = `${operation}Latitude` as const;
    const longitudeField = `${operation}Longitude` as const;
    const feeField = `${operation}Fee` as const;
    const placeId = values[placeIdField].trim();
    const locationLabel = values[labelField].trim();
    const latitude = values[latitudeField].trim();
    const longitude = values[longitudeField].trim();
    const point = {
      latitude: validCoordinate(latitude) ? Number(latitude) : NaN,
      longitude: validCoordinate(longitude) ? Number(longitude) : NaN
    };

    if (!placeId || placeId.length > 500 ||
        !locationLabel || locationLabel.length > 500 ||
        !validCoordinate(latitude) || !validCoordinate(longitude) || !isValidGeoPoint(point)) {
      errors[locationField] = `Select a ${operationLabel} location from Google Places.`;
    }

    const amount = normalizeAmount(values[feeField].trim());
    if (amount === null) {
      errors[feeField] = "Enter a GBP amount from £0.00 to £999,999.99 with up to 2 decimal places.";
    } else {
      normalizedAmounts[feeField] = amount;
    }
  }

  const validTimeReferences = ["ALT", "AGA"];
  if (!validTimeReferences.includes(values.pickupTimeReference.trim())) {
    errors.pickupTimeReference = "Select Actual Landing Time (ALT) or Actual Gate Arrival (AGA).";
  }

  const deferredPolicy = values.pickupDeferredPolicy.trim();
  if (deferredPolicy !== "yes" && deferredPolicy !== "no") {
    errors.pickupDeferredPolicy = "Select Yes or No for the deferred pick-up policy.";
  }

  const deferredMinutes = values.pickupDeferredMinutes.trim();
  if (!["0", "15", "30", "45", "60"].includes(deferredMinutes)) {
    errors.pickupDeferredMinutes = "Select a deferred period of 0, 15, 30, 45, or 60 minutes.";
  } else if (deferredPolicy === "no" && deferredMinutes !== "0") {
    errors.pickupDeferredMinutes = "Select 0 minutes when the deferred pick-up policy is No.";
  } else if (deferredPolicy === "yes" && deferredMinutes === "0") {
    errors.pickupDeferredMinutes = "Select a non-zero deferred period when the deferred pick-up policy is Yes.";
  }

  if (!["10", "15", "20", "30", "40", "45", "60"].includes(values.pickupFeeCoveredMinutes.trim())) {
    errors.pickupFeeCoveredMinutes = "Select a fee-covered period of 10, 15, 20, 30, 40, 45, or 60 minutes.";
  }

  if (Object.keys(errors).length === 0) {
    values.id = values.id.trim();
    values.displayName = displayName;
    values.pickupTimeReference = values.pickupTimeReference.trim();
    values.pickupDeferredPolicy = deferredPolicy;
    values.pickupDeferredMinutes = deferredMinutes;
    values.pickupFeeCoveredMinutes = values.pickupFeeCoveredMinutes.trim();
    for (const operation of ["dropoff", "pickup"] as const) {
      const placeIdField = `${operation}PlaceId` as const;
      const labelField = `${operation}LocationLabel` as const;
      const latitudeField = `${operation}Latitude` as const;
      const longitudeField = `${operation}Longitude` as const;
      values[placeIdField] = values[placeIdField].trim();
      values[labelField] = values[labelField].trim();
      values[latitudeField] = values[latitudeField].trim();
      values[longitudeField] = values[longitudeField].trim();
      values[`${operation}Fee`] = normalizedAmounts[`${operation}Fee`]!;
    }
  }

  return { values, errors };
}

type AirportFeeRow = {
  id: string;
  display_name: string;
  dropoff_place_id: string;
  dropoff_location_label: string;
  dropoff_latitude: string | number;
  dropoff_longitude: string | number;
  dropoff_fee: string;
  pickup_place_id: string;
  pickup_location_label: string;
  pickup_latitude: string | number;
  pickup_longitude: string | number;
  pickup_fee: string;
  pickup_time_reference: "ALT" | "AGA" | null;
  pickup_deferred_enabled: boolean | null;
  pickup_deferred_minutes: number | null;
  pickup_fee_covered_minutes: number | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function toRecord(row: AirportFeeRow): AirportFeeRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    dropoffPlaceId: row.dropoff_place_id,
    dropoffLocationLabel: row.dropoff_location_label,
    dropoffLatitude: Number(row.dropoff_latitude),
    dropoffLongitude: Number(row.dropoff_longitude),
    dropoffFee: row.dropoff_fee,
    pickupPlaceId: row.pickup_place_id,
    pickupLocationLabel: row.pickup_location_label,
    pickupLatitude: Number(row.pickup_latitude),
    pickupLongitude: Number(row.pickup_longitude),
    pickupFee: row.pickup_fee,
    pickupTimeReference: row.pickup_time_reference,
    pickupDeferredEnabled: row.pickup_deferred_enabled,
    pickupDeferredMinutes: row.pickup_deferred_minutes,
    pickupFeeCoveredMinutes: row.pickup_fee_covered_minutes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

const RETURNING_COLUMNS = `id, display_name, dropoff_place_id, dropoff_location_label,
  dropoff_latitude, dropoff_longitude, dropoff_fee, pickup_place_id,
  pickup_location_label, pickup_latitude, pickup_longitude, pickup_fee,
  pickup_time_reference, pickup_deferred_enabled, pickup_deferred_minutes,
  pickup_fee_covered_minutes, created_at, updated_at`;

export const airportFeeStore: AirportFeeStore = {
  async list() {
    const result = await query<AirportFeeRow>(
      `SELECT ${RETURNING_COLUMNS}
         FROM airport_fee_configurations
        WHERE archived_at IS NULL
        ORDER BY display_name, id`
    );
    return result.rows.map(toRecord);
  },

  async get(id) {
    const result = await query<AirportFeeRow>(
      `SELECT ${RETURNING_COLUMNS}
         FROM airport_fee_configurations
        WHERE id = $1 AND archived_at IS NULL`,
      [id]
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  },

  async save(id, values, actor) {
    return withTransaction(async (client) => {
      const params = [
        values.displayName,
        values.dropoffPlaceId,
        values.dropoffLocationLabel,
        Number(values.dropoffLatitude),
        Number(values.dropoffLongitude),
        values.dropoffFee,
        values.pickupPlaceId,
        values.pickupLocationLabel,
        Number(values.pickupLatitude),
        Number(values.pickupLongitude),
        values.pickupFee,
        values.pickupTimeReference,
        values.pickupDeferredPolicy === "yes",
        Number(values.pickupDeferredMinutes),
        Number(values.pickupFeeCoveredMinutes),
        actor.accountId,
        actor.email
      ];
      const result = id
        ? await client.query<AirportFeeRow>(
          `UPDATE airport_fee_configurations
              SET display_name = $2, dropoff_place_id = $3, dropoff_location_label = $4,
                  dropoff_latitude = $5, dropoff_longitude = $6, dropoff_fee = $7,
                  pickup_place_id = $8, pickup_location_label = $9, pickup_latitude = $10,
                  pickup_longitude = $11, pickup_fee = $12, pickup_time_reference = $13,
                  pickup_deferred_enabled = $14, pickup_deferred_minutes = $15,
                  pickup_fee_covered_minutes = $16, updated_by_account_id = $17,
                  updated_by_email = $18, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND archived_at IS NULL
            RETURNING ${RETURNING_COLUMNS}`,
          [id, ...params]
        )
        : await client.query<AirportFeeRow>(
          `INSERT INTO airport_fee_configurations (
             id, display_name, dropoff_place_id, dropoff_location_label, dropoff_latitude,
             dropoff_longitude, dropoff_fee, pickup_place_id, pickup_location_label,
             pickup_latitude, pickup_longitude, pickup_fee, pickup_time_reference,
             pickup_deferred_enabled, pickup_deferred_minutes, pickup_fee_covered_minutes,
             created_by_account_id, created_by_email, updated_by_account_id, updated_by_email
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $17, $18)
           RETURNING ${RETURNING_COLUMNS}`,
          [randomUUID(), ...params]
        );
      if (!result.rows[0]) return null;
      const record = toRecord(result.rows[0]);
      await client.query(
        `INSERT INTO airport_fee_configuration_audit
           (airport_id, event_type, snapshot, actor_account_id, actor_email)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [record.id, id ? "updated" : "created", JSON.stringify(record), actor.accountId, actor.email]
      );
      return record;
    });
  },

  async archive(id, actor) {
    return withTransaction(async (client) => {
      const result = await client.query<AirportFeeRow>(
        `UPDATE airport_fee_configurations
            SET archived_at = CURRENT_TIMESTAMP, archived_by_account_id = $2,
                archived_by_email = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND archived_at IS NULL
          RETURNING ${RETURNING_COLUMNS}`,
        [id, actor.accountId, actor.email]
      );
      const row = result.rows[0];
      if (!row) return false;
      await client.query(
        `INSERT INTO airport_fee_configuration_audit
           (airport_id, event_type, snapshot, actor_account_id, actor_email)
         VALUES ($1, 'archived', $2::jsonb, $3, $4)`,
        [id, JSON.stringify(toRecord(row)), actor.accountId, actor.email]
      );
      return true;
    });
  }
};

export function airportFeeRecordToForm(record: AirportFeeRecord): AirportFeeFormValues {
  return {
    id: record.id,
    displayName: record.displayName,
    dropoffPlaceId: record.dropoffPlaceId,
    dropoffLocationLabel: record.dropoffLocationLabel,
    dropoffLatitude: String(record.dropoffLatitude),
    dropoffLongitude: String(record.dropoffLongitude),
    dropoffFee: record.dropoffFee,
    pickupPlaceId: record.pickupPlaceId,
    pickupLocationLabel: record.pickupLocationLabel,
    pickupLatitude: String(record.pickupLatitude),
    pickupLongitude: String(record.pickupLongitude),
    pickupFee: record.pickupFee,
    pickupTimeReference: record.pickupTimeReference ?? "",
    pickupDeferredPolicy: record.pickupDeferredEnabled === null ? "" : record.pickupDeferredEnabled ? "yes" : "no",
    pickupDeferredMinutes: record.pickupDeferredMinutes === null ? "" : String(record.pickupDeferredMinutes),
    pickupFeeCoveredMinutes: record.pickupFeeCoveredMinutes === null ? "" : String(record.pickupFeeCoveredMinutes)
  };
}

export function formatAirportPickupTimingRule(record: AirportFeeRecord): string {
  const { pickupTimeReference, pickupDeferredEnabled, pickupDeferredMinutes, pickupFeeCoveredMinutes } = record;
  if (!pickupTimeReference || pickupDeferredEnabled === null ||
      pickupDeferredMinutes === null || pickupFeeCoveredMinutes === null) {
    return "Setup incomplete: pick-up timing policy is not configured.";
  }

  const reference = pickupTimeReference === "ALT"
    ? "Actual Landing Time (ALT)"
    : "Actual Gate Arrival (AGA)";
  const totalWindow = pickupDeferredMinutes + pickupFeeCoveredMinutes;
  return pickupDeferredMinutes > 0
    ? `Customer time window: ${totalWindow} minutes from ${reference}; first ${pickupDeferredMinutes} minutes are deferred, then the £${record.pickupFee} pick-up fee covers the following ${pickupFeeCoveredMinutes} minutes.`
    : `Customer time window: ${totalWindow} minutes from ${reference}; the £${record.pickupFee} pick-up fee covers this period.`;
}
