import type { PoolClient } from "pg";
import { query, withTransaction } from "../database/connection";
import { serviceLocalToUtc } from "./new-bookings";

export const ONLINE_BOOKING_NOTICE_HOURS = [6, 12, 24] as const;
export type OnlineBookingNoticeHours = (typeof ONLINE_BOOKING_NOTICE_HOURS)[number];

export type BookingIntegrationSettings = {
  minimumOnlineNoticeHours: OnlineBookingNoticeHours;
  updatedAt: string;
  updatedByEmail: string | null;
};

export async function getBookingIntegrationSettings(): Promise<BookingIntegrationSettings> {
  const result = await query<{
    minimum_online_notice_hours: number;
    updated_at: string;
    updated_by_email: string | null;
  }>(
    `SELECT minimum_online_notice_hours, updated_at, updated_by_email
       FROM booking_integration_settings WHERE id = 1`
  );
  const row = result.rows[0];
  if (!row) throw new Error("Booking integration settings have not been initialized.");
  if (!ONLINE_BOOKING_NOTICE_HOURS.includes(row.minimum_online_notice_hours as OnlineBookingNoticeHours)) {
    throw new Error("Stored minimum online booking notice is invalid.");
  }
  return {
    minimumOnlineNoticeHours: row.minimum_online_notice_hours as OnlineBookingNoticeHours,
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email
  };
}

export async function saveMinimumOnlineNotice(input: {
  hours: number;
  actorId: string;
  actorEmail: string;
}): Promise<BookingIntegrationSettings> {
  if (!ONLINE_BOOKING_NOTICE_HOURS.includes(input.hours as OnlineBookingNoticeHours)) {
    throw new TypeError("Select a minimum online booking notice of 6, 12 or 24 hours.");
  }
  const result = await query<{
    minimum_online_notice_hours: number;
    updated_at: string;
    updated_by_email: string | null;
  }>(
    `UPDATE booking_integration_settings
        SET minimum_online_notice_hours = $1, updated_by_account_id = $2,
            updated_by_email = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING minimum_online_notice_hours, updated_at, updated_by_email`,
    [input.hours, input.actorId, input.actorEmail]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Booking integration settings have not been initialized.");
  return {
    minimumOnlineNoticeHours: row.minimum_online_notice_hours as OnlineBookingNoticeHours,
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email
  };
}

export async function isOnlineBookingAllowed(input: {
  serviceDate: string;
  serviceTime: string;
  now?: Date;
}): Promise<boolean> {
  const settings = await getBookingIntegrationSettings();
  const pickupAt = serviceLocalToUtc(input.serviceDate, input.serviceTime);
  return pickupAt.getTime() >= (input.now ?? new Date()).getTime() + settings.minimumOnlineNoticeHours * 60 * 60_000;
}

export async function withBookingIntegrationLock<T>(work: (client: PoolClient) => Promise<T>): Promise<T | null> {
  return withTransaction(async (client) => {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('ridematrix-booking-integrations')) AS locked"
    );
    if (!lock.rows[0]?.locked) return null;
    return work(client);
  });
}
