import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../database/connection";

export type FareSurchargeSettings = {
  enabled: boolean;
  percentage: string;
  startTime: string;
  endTime: string;
};

export type BankHolidaySurchargePeriod = {
  label: string;
  startDateTime: string;
  endDateTime: string;
  percentage: string;
};

export type BankHolidayFareSettings = {
  enabled: boolean;
  periods: BankHolidaySurchargePeriod[];
};

export type DistanceSlab = {
  startMiles: string;
  endMiles: string;
  ratePerMile: string;
};

export type FareSettingsConfiguration = {
  timezone: "Europe/London";
  matchingBasis: "scheduled-service-time";
  interval: "start-inclusive-end-exclusive";
  precedence: "bank-holiday-over-daily";
  distanceSlabs: DistanceSlab[];
  dailySurcharge: FareSurchargeSettings;
  bankHolidaySurcharge: BankHolidayFareSettings;
};

export type FareSettingsHistoryEntry = {
  version: number;
  actorEmail: string | null;
  createdAt: string;
};

export type FareSettingsSnapshot = {
  configuration: FareSettingsConfiguration;
  currentVersion: number;
  history: FareSettingsHistoryEntry[];
};

export type FareSettingsActor = {
  accountId: string | null;
  email: string;
};

export type FareSettingsStore = {
  load: () => Promise<FareSettingsSnapshot>;
  save: (
    expectedVersion: number,
    configuration: FareSettingsConfiguration,
    actor: FareSettingsActor
  ) => Promise<void>;
};

export type FareSettingsValidation = {
  configuration: FareSettingsConfiguration;
  errors: Record<string, string>;
};

export const EMPTY_FARE_SETTINGS: FareSettingsConfiguration = {
  timezone: "Europe/London",
  matchingBasis: "scheduled-service-time",
  interval: "start-inclusive-end-exclusive",
  precedence: "bank-holiday-over-daily",
  distanceSlabs: [],
  dailySurcharge: {
    enabled: false,
    percentage: "",
    startTime: "",
    endTime: ""
  },
  bankHolidaySurcharge: {
    enabled: false,
    periods: []
  }
};

type FareSettingsRow = {
  configuration: FareSettingsConfiguration;
  version: number;
};

type FareSettingsHistoryEntryRow = {
  version: number;
  actorEmail: string | null;
  createdAt: string | Date;
};

type FareSettingsSnapshotRow = FareSettingsRow & {
  history: FareSettingsHistoryEntryRow[];
};

export class FareSettingsVersionConflictError extends Error {
  constructor() {
    super("Fare settings changed after the form was opened. Review the latest settings and try again.");
    this.name = "FareSettingsVersionConflictError";
  }
}

function submittedString(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key] as string : "";
}

function validPercentage(value: string): boolean {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return false;
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

type DecimalValue = { coefficient: bigint; scale: number };

function parseNonNegativeDecimal(value: string): DecimalValue | null {
  if (value.length > 80 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.startsWith(".")
    ? ["0", value.slice(1)]
    : value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function compareDecimals(left: DecimalValue, right: DecimalValue): number {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function equalDecimals(left: DecimalValue, right: DecimalValue): boolean {
  return compareDecimals(left, right) === 0;
}

function slabRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map((row) => row && typeof row === "object" && !Array.isArray(row)
      ? row as Record<string, unknown>
      : {});
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, row]) => row && typeof row === "object" && !Array.isArray(row)
        ? row as Record<string, unknown>
        : {});
  }
  return [];
}

export type DistanceSlabFormValidation = {
  distanceSlabs: DistanceSlab[];
  errors: Record<string, string>;
};

export function validateDistanceSlabsForm(submitted: unknown): DistanceSlabFormValidation {
  const body = submitted && typeof submitted === "object"
    ? submitted as Record<string, unknown>
    : {};
  const rows = slabRows(body.distanceSlabs);
  const distanceSlabs: DistanceSlab[] = rows.map((row) => ({
    startMiles: typeof row.startMiles === "string" ? row.startMiles.trim() : "",
    endMiles: typeof row.endMiles === "string" ? row.endMiles.trim() : "",
    ratePerMile: typeof row.ratePerMile === "string" ? row.ratePerMile.trim() : ""
  }));
  const errors: Record<string, string> = {};

  if (distanceSlabs.length === 0) {
    errors["distanceSlabs.0.startMiles"] = "Add at least one distance slab.";
    errors["distanceSlabs.0.endMiles"] = "The final slab must be open-ended.";
    errors["distanceSlabs.0.ratePerMile"] = "Enter a valid non-negative rate.";
    return { distanceSlabs, errors };
  }

  const starts = distanceSlabs.map((slab, index) => {
    const parsed = parseNonNegativeDecimal(slab.startMiles);
    if (!parsed) errors[`distanceSlabs.${index}.startMiles`] = "Enter a valid non-negative distance in miles.";
    return parsed;
  });
  const ends = distanceSlabs.map((slab, index) => {
    if (index === distanceSlabs.length - 1) {
      if (slab.endMiles !== "") {
        errors[`distanceSlabs.${index}.endMiles`] = "The final slab must be open-ended; leave its end distance blank.";
      }
      return null;
    }
    const parsed = parseNonNegativeDecimal(slab.endMiles);
    if (!parsed) errors[`distanceSlabs.${index}.endMiles`] = "Enter a valid non-negative end distance.";
    return parsed;
  });
  distanceSlabs.forEach((slab, index) => {
    const parsed = parseNonNegativeDecimal(slab.ratePerMile);
    if (!parsed) errors[`distanceSlabs.${index}.ratePerMile`] = "Enter a valid non-negative rate in GBP per mile.";
  });

  if (starts[0] && starts[0].coefficient !== 0n) {
    errors["distanceSlabs.0.startMiles"] = "The first slab must start at 0 miles.";
  }
  distanceSlabs.forEach((_slab, index) => {
    const start = starts[index];
    const end = ends[index];
    if (start && end && compareDecimals(end, start) <= 0) {
      errors[`distanceSlabs.${index}.endMiles`] = "The end distance must be greater than the start distance.";
    }
    if (index > 0) {
      const previousEnd = ends[index - 1];
      if (previousEnd && start && !equalDecimals(previousEnd, start)) {
        errors[`distanceSlabs.${index}.startMiles`] = compareDecimals(start, previousEnd) < 0
          ? "This slab overlaps the previous slab; start at the previous end distance."
          : "There is a gap after the previous slab; start at the previous end distance.";
      }
    }
  });

  return { distanceSlabs, errors };
}

export function calculateDistanceSlabFare(distanceSlabs: DistanceSlab[], distanceMiles: string): string {
  const distance = parseNonNegativeDecimal(distanceMiles);
  const validation = validateDistanceSlabsForm({ distanceSlabs });
  if (!distance || Object.keys(validation.errors).length > 0) {
    throw new TypeError("A valid distance and contiguous distance-slab schedule are required.");
  }

  const products: DecimalValue[] = [];
  for (const slab of distanceSlabs) {
    const start = parseNonNegativeDecimal(slab.startMiles);
    const end = slab.endMiles === "" ? null : parseNonNegativeDecimal(slab.endMiles);
    const rate = parseNonNegativeDecimal(slab.ratePerMile);
    if (!start || !rate || (slab.endMiles !== "" && !end)) {
      throw new TypeError("A valid distance and contiguous distance-slab schedule are required.");
    }
    if (compareDecimals(distance, start) <= 0) continue;

    const portionEnd = end && compareDecimals(distance, end) < 0 ? distance : end ?? distance;
    const commonScale = Math.max(start.scale, portionEnd.scale);
    const portion = portionEnd.coefficient * 10n ** BigInt(commonScale - portionEnd.scale) -
      start.coefficient * 10n ** BigInt(commonScale - start.scale);
    if (portion <= 0n) continue;
    products.push({
      coefficient: portion * rate.coefficient,
      scale: commonScale + rate.scale
    });
  }

  const totalScale = Math.max(0, ...products.map((product) => product.scale));
  const total = products.reduce(
    (sum, product) => sum + product.coefficient * 10n ** BigInt(totalScale - product.scale),
    0n
  );
  const pennyScale = totalScale - 2;
  const pennies = pennyScale <= 0
    ? total * 10n ** BigInt(-pennyScale)
    : (() => {
      const divisor = 10n ** BigInt(pennyScale);
      const quotient = total / divisor;
      return total % divisor * 2n >= divisor ? quotient + 1n : quotient;
    })();
  return `${pennies / 100n}.${String(pennies % 100n).padStart(2, "0")}`;
}

function validTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validLocalDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return false;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute;
}

function periodRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, row]) => row)
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  }
  return [];
}

export function validateFareSettingsForm(
  submitted: unknown,
  current: FareSettingsConfiguration = EMPTY_FARE_SETTINGS
): FareSettingsValidation {
  const body = submitted && typeof submitted === "object"
    ? submitted as Record<string, unknown>
    : {};
  const errors: Record<string, string> = {};
  const hasDailySettings = Object.prototype.hasOwnProperty.call(body, "dailyEnabled");
  const hasBankHolidaySettings = Object.prototype.hasOwnProperty.call(body, "bankHolidayEnabled");
  const hasPeriods = Object.prototype.hasOwnProperty.call(body, "periods") || body.periodsSubmitted === "yes";
  const dailyEnabled = hasDailySettings
    ? submittedString(body, "dailyEnabled")
    : current.dailySurcharge.enabled ? "yes" : "no";
  const bankHolidayEnabled = hasBankHolidaySettings
    ? submittedString(body, "bankHolidayEnabled")
    : current.bankHolidaySurcharge.enabled ? "yes" : "no";

  if (hasDailySettings && dailyEnabled !== "yes" && dailyEnabled !== "no") {
    errors.dailyEnabled = "Select Yes or No for the daily fare surcharge.";
  }
  if (hasBankHolidaySettings && bankHolidayEnabled !== "yes" && bankHolidayEnabled !== "no") {
    errors.bankHolidayEnabled = "Select Yes or No for the bank holiday fare surcharge.";
  }

  let dailySurcharge: FareSurchargeSettings;
  if (!hasDailySettings) {
    dailySurcharge = { ...current.dailySurcharge };
  } else if (dailyEnabled === "no") {
    dailySurcharge = { ...current.dailySurcharge, enabled: false };
  } else {
    dailySurcharge = {
      enabled: dailyEnabled === "yes",
      percentage: submittedString(body, "dailyPercentage").trim(),
      startTime: submittedString(body, "dailyStartTime").trim(),
      endTime: submittedString(body, "dailyEndTime").trim()
    };
  }

  if (dailySurcharge.enabled) {
    if (!dailySurcharge.percentage || !validPercentage(dailySurcharge.percentage)) {
      errors.dailyPercentage = "Enter a valid non-negative percentage.";
    }
    if (!dailySurcharge.startTime || !validTime(dailySurcharge.startTime)) {
      errors.dailyStartTime = "Enter a valid start time.";
    }
    if (!dailySurcharge.endTime || !validTime(dailySurcharge.endTime)) {
      errors.dailyEndTime = "Enter a valid end time.";
    }
    if (validTime(dailySurcharge.startTime) &&
        validTime(dailySurcharge.endTime) &&
        dailySurcharge.startTime === dailySurcharge.endTime) {
      errors.dailyEndTime = "The end time must differ from the start time.";
    }
  }

  const periods: BankHolidaySurchargePeriod[] = [];
  (hasPeriods ? periodRows(body.periods) : current.bankHolidaySurcharge.periods)
    .filter((row) => !("remove" in row) || row.remove !== "yes")
    .forEach((row) => {
      const index = periods.length;
      const period = {
        label: typeof row.label === "string" ? row.label.trim() : "",
        startDateTime: typeof row.startDateTime === "string" ? row.startDateTime.trim() : "",
        endDateTime: typeof row.endDateTime === "string" ? row.endDateTime.trim() : "",
        percentage: typeof row.percentage === "string" ? row.percentage.trim() : ""
      };
      if (!period.label && !period.startDateTime && !period.endDateTime && !period.percentage) return;

      periods.push(period);
      if (!period.label || period.label.length > 160) {
        errors[`periods.${index}.label`] = "Enter a descriptive label no longer than 160 characters.";
      }
      if (!validLocalDateTime(period.startDateTime)) {
        errors[`periods.${index}.startDateTime`] = "Enter a valid local start date and time.";
      }
      if (!validLocalDateTime(period.endDateTime)) {
        errors[`periods.${index}.endDateTime`] = "Enter a valid local end date and time.";
      }
      if (!period.percentage || !validPercentage(period.percentage)) {
        errors[`periods.${index}.percentage`] = "Enter a valid non-negative percentage.";
      }
      if (validLocalDateTime(period.startDateTime) &&
          validLocalDateTime(period.endDateTime) &&
          period.endDateTime <= period.startDateTime) {
        errors[`periods.${index}.endDateTime`] = "The end date and time must be after the start.";
      }
    });

  const validPeriods = periods
    .filter((period) => validLocalDateTime(period.startDateTime) && validLocalDateTime(period.endDateTime) &&
      period.endDateTime > period.startDateTime)
    .sort((left, right) => left.startDateTime.localeCompare(right.startDateTime));
  for (let index = 1; index < validPeriods.length; index += 1) {
    if (validPeriods[index].startDateTime < validPeriods[index - 1].endDateTime) {
      errors.bankHolidayPeriods = "Bank holiday surcharge periods cannot overlap. Adjust the dates and times before saving.";
      break;
    }
  }

  const bankHolidaySurcharge: BankHolidayFareSettings = {
    enabled: bankHolidayEnabled === "yes",
    periods
  };
  if (bankHolidaySurcharge.enabled && periods.length === 0) {
    errors.bankHolidayPeriods = "Add at least one bank holiday surcharge period before enabling this setting.";
  }

  return {
    configuration: {
      timezone: "Europe/London",
      matchingBasis: "scheduled-service-time",
      interval: "start-inclusive-end-exclusive",
      precedence: "bank-holiday-over-daily",
      distanceSlabs: current.distanceSlabs ?? [],
      dailySurcharge,
      bankHolidaySurcharge
    },
    errors
  };
}

export const fareSettingsStore: FareSettingsStore = {
  async load() {
    const result = await query<FareSettingsSnapshotRow>(
      `SELECT state.configuration, state.version,
              COALESCE(
                (SELECT json_agg(
                    json_build_object(
                      'version', history.version,
                      'actorEmail', history.actor_email,
                      'createdAt', history.occurred_at
                    ) ORDER BY history.version DESC
                  )
                   FROM fare_settings_history AS history),
                '[]'::json
              ) AS history
         FROM fare_settings_current AS state
        WHERE state.id = 1`
    );
    const row = result.rows[0];
    if (!row) throw new Error("Fare settings configuration is missing.");
    return {
      configuration: row.configuration,
      currentVersion: row.version,
      history: row.history.map((item) => ({
        version: item.version,
        actorEmail: item.actorEmail,
        createdAt: new Date(item.createdAt).toISOString()
      }))
    };
  },

  async save(expectedVersion, configuration, actor) {
    await withTransaction(async (client) => {
      const current = await client.query<FareSettingsRow>(
        `SELECT configuration, version
           FROM fare_settings_current
          WHERE id = 1
          FOR UPDATE`
      );
      const latest = current.rows[0];
      if (!latest || latest.version !== expectedVersion) {
        throw new FareSettingsVersionConflictError();
      }

      const nextVersion = latest.version + 1;
      await client.query(
        `UPDATE fare_settings_current
            SET configuration = $1::jsonb, version = $2, updated_by_account_id = $3,
                updated_by_email = $4, updated_at = CURRENT_TIMESTAMP
          WHERE id = 1`,
        [JSON.stringify(configuration), nextVersion, actor.accountId, actor.email]
      );
      await client.query(
        `INSERT INTO fare_settings_history
          (id, version, configuration, actor_account_id, actor_email)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [randomUUID(), nextVersion, JSON.stringify(configuration), actor.accountId, actor.email]
      );
    });
  }
};
