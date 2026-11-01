import { randomUUID } from "node:crypto";
import type { LondonFeeScheduleDraft } from "./london-fee-schedule-data";
import { query, withTransaction } from "../database/connection";

export type LondonFeeScheduleScheme = LondonFeeScheduleDraft["scheme"];

export type LondonFeeScheduleVersionRecord = {
  version: number;
  actorEmail: string | null;
  createdAt: string;
};

export type LondonFeeScheduleSnapshot = {
  schedule: LondonFeeScheduleDraft;
  currentVersion: number;
  history: LondonFeeScheduleVersionRecord[];
};

export type LondonFeeScheduleActor = {
  accountId: string | null;
  email: string;
};

export type LondonFeeScheduleStore = {
  load: (scheme: LondonFeeScheduleScheme) => Promise<LondonFeeScheduleSnapshot>;
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
  payload: LondonFeeScheduleDraft;
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
  schedule: LondonFeeScheduleDraft,
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

    if (Number(raw) <= 0) {
      errors[rate.key] = "Enter a GBP amount greater than £0.00.";
      continue;
    }

    amounts[rate.key] = raw;
  }

  return { amounts, errors };
}

export const londonFeeScheduleStore: LondonFeeScheduleStore = {
  async load(scheme) {
    const result = await query<ScheduleVersionRow>(
      `SELECT version, status, payload, actor_email, created_at
         FROM london_fee_schedule_versions
        WHERE scheme = $1
        ORDER BY version DESC`,
      [scheme]
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
      history: result.rows.map((row) => ({
        version: row.version,
        actorEmail: row.actor_email,
        createdAt: new Date(row.created_at).toISOString()
      }))
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

      const nextPayload: LondonFeeScheduleDraft = {
        ...latest.payload,
        rates: latest.payload.rates.map((rate) => ({
          ...rate,
          amount: Number(validation.amounts[rate.key])
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
