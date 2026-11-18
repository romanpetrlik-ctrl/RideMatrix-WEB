import { randomUUID } from "node:crypto";
import type { FeeScheduleDraft } from "./london-fee-schedule-data";
import { query, withTransaction } from "../database/connection";
import {
  RECENT_CONFIGURATION_HISTORY_LIMIT,
  resolveHistoryPage,
  type ConfigurationHistoryEntry,
  type ConfigurationHistoryPage
} from "./configuration-history";

export type LondonFeeScheduleScheme = FeeScheduleDraft["scheme"];

export type LondonFeeScheduleVersionRecord = ConfigurationHistoryEntry;

export type LondonFeeScheduleSnapshot = {
  schedule: FeeScheduleDraft;
  currentVersion: number;
  /** The most recent history entries only (newest first); see historyTotal for the full count. */
  history: LondonFeeScheduleVersionRecord[];
  historyTotal: number;
};

export type LondonFeeScheduleActor = {
  accountId: string | null;
  email: string;
};

export type LondonFeeScheduleStore = {
  load: (scheme: LondonFeeScheduleScheme) => Promise<LondonFeeScheduleSnapshot>;
  loadHistoryPage: (scheme: LondonFeeScheduleScheme, page: number, perPage?: number) => Promise<ConfigurationHistoryPage>;
  save: (
    scheme: LondonFeeScheduleScheme,
    expectedVersion: number,
    amounts: Record<string, string>,
    actor: LondonFeeScheduleActor
  ) => Promise<void>;
};

type ScheduleVersionRow = {
  version: number;
  status: string;
  payload: FeeScheduleDraft;
  actor_email: string | null;
  created_at: string | Date;
};

export class LondonFeeScheduleVersionConflictError extends Error {
  constructor() {
    super("This draft changed after the form was opened. Review the latest draft and try again.");
    this.name = "LondonFeeScheduleVersionConflictError";
  }
}

export function validateLondonFeeRateAmounts(
  schedule: FeeScheduleDraft,
  submitted: unknown
): { amounts: Record<string, string>; errors: Record<string, string> } {
  const body = submitted && typeof submitted === "object" ? submitted as Record<string, unknown> : {};
  const amounts: Record<string, string> = {};
  const errors: Record<string, string> = {};

  for (const rate of schedule.rates) {
    const raw = body[`amount_${rate.key}`];
    if (typeof raw !== "string" || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(raw)) {
      errors[rate.key] = "Enter an amount in GBP with no more than 2 decimal places.";
      continue;
    }

    const isZero = /^0(?:\.0{1,2})?$/.test(raw);
    if (isZero && (schedule.kind !== "crossing" || !schedule.allowZeroAmounts)) {
      errors[rate.key] = "Enter a GBP amount greater than £0.00.";
      continue;
    }

    if (isZero) {
      amounts[rate.key] = "0.00";
    } else if (raw.includes(".")) {
      amounts[rate.key] = raw.padEnd(raw.indexOf(".") + 3, "0");
    } else {
      amounts[rate.key] = `${raw}.00`;
    }
  }

  return { amounts, errors };
}

export const londonFeeScheduleStore: LondonFeeScheduleStore = {
  async load(scheme) {
    // (scheme, version) is UNIQUE, so ordering by version is deterministic even when timestamps tie.
    const result = await query<ScheduleVersionRow & {
      history_total: number;
      history: Array<{ version: number; actorEmail: string | null; createdAt: string }>;
    }>(
      `SELECT latest.version, latest.status, latest.payload, latest.actor_email, latest.created_at,
              (SELECT COUNT(*)::int FROM london_fee_schedule_versions WHERE scheme = $1) AS history_total,
              COALESCE(
                (SELECT json_agg(
                    json_build_object(
                      'version', recent.version,
                      'actorEmail', recent.actor_email,
                      'createdAt', recent.created_at
                    ) ORDER BY recent.version DESC
                  )
                   FROM (SELECT version, actor_email, created_at
                           FROM london_fee_schedule_versions
                          WHERE scheme = $1
                          ORDER BY version DESC
                          LIMIT $2) AS recent),
                '[]'::json
              ) AS history
         FROM london_fee_schedule_versions AS latest
        WHERE latest.scheme = $1
        ORDER BY latest.version DESC
        LIMIT 1`,
      [scheme, RECENT_CONFIGURATION_HISTORY_LIMIT]
    );

    if (result.rows.length === 0) {
      throw new Error(`The ${scheme} draft schedule has not been seeded.`);
    }

    const latest = result.rows[0];
    if (latest.status !== "draft_inactive" || latest.payload.active !== false || latest.payload.bookingPriceUsage !== "never") {
      throw new Error(`The ${scheme} schedule is not in the required inactive draft state.`);
    }

    return {
      schedule: latest.payload,
      currentVersion: latest.version,
      history: latest.history.map((row) => ({
        version: row.version,
        actorEmail: row.actorEmail,
        createdAt: new Date(row.createdAt).toISOString()
      })),
      historyTotal: latest.history_total
    };
  },

  async loadHistoryPage(scheme, requestedPage, perPage) {
    const count = await query<{ total: number }>(
      "SELECT COUNT(*)::int AS total FROM london_fee_schedule_versions WHERE scheme = $1",
      [scheme]
    );
    const totalRecords = count.rows[0]?.total ?? 0;
    const page = resolveHistoryPage(requestedPage, totalRecords, perPage);
    const result = await query<{ version: number; actor_email: string | null; created_at: string | Date }>(
      `SELECT version, actor_email, created_at
         FROM london_fee_schedule_versions
        WHERE scheme = $1
        ORDER BY version DESC
        LIMIT $2 OFFSET $3`,
      [scheme, page.perPage, page.offset]
    );
    return {
      entries: result.rows.map((row) => ({
        version: row.version,
        actorEmail: row.actor_email,
        createdAt: new Date(row.created_at).toISOString()
      })),
      page: page.page,
      perPage: page.perPage,
      totalPages: page.totalPages,
      totalRecords
    };
  },

  async save(scheme, expectedVersion, amounts, actor) {
    await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [scheme]);
      const current = await client.query<ScheduleVersionRow>(
        `SELECT version, status, payload, actor_email, created_at
           FROM london_fee_schedule_versions
          WHERE scheme = $1
          ORDER BY version DESC
          LIMIT 1
          FOR UPDATE`,
        [scheme]
      );
      const latest = current.rows[0];

      if (!latest || latest.version !== expectedVersion) {
        throw new LondonFeeScheduleVersionConflictError();
      }
      if (latest.status !== "draft_inactive" || latest.payload.active !== false || latest.payload.bookingPriceUsage !== "never") {
        throw new Error(`The ${scheme} schedule is not in the required inactive draft state.`);
      }

      const validation = validateLondonFeeRateAmounts(
        latest.payload,
        Object.fromEntries(Object.entries(amounts).map(([key, amount]) => [`amount_${key}`, amount]))
      );
      if (Object.keys(validation.errors).length > 0) {
        throw new Error("Invalid London fee schedule amounts reached persistence.");
      }

      const nextPayload: FeeScheduleDraft = latest.payload.kind === "london_daily"
        ? {
          ...latest.payload,
          rates: latest.payload.rates.map((rate) => ({
            ...rate,
            amount: Number(validation.amounts[rate.key])
          }))
        }
        : {
          ...latest.payload,
          rates: latest.payload.rates.map((rate) => ({
            ...rate,
            amount: validation.amounts[rate.key]
          }))
        };

      await client.query(
        `INSERT INTO london_fee_schedule_versions
          (id, scheme, version, status, payload, actor_account_id, actor_email)
         VALUES ($1, $2, $3, 'draft_inactive', $4::jsonb, $5, $6)`,
        [
          randomUUID(),
          scheme,
          latest.version + 1,
          JSON.stringify(nextPayload),
          actor.accountId,
          actor.email
        ]
      );
    });
  }
};
