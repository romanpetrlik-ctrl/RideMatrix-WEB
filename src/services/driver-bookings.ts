import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../database/connection";
import { BOOKING_LIVE_STATUSES, type BookingLiveStatus } from "./booking-dashboard";

export type DriverBooking = {
  id: string;
  reference: string;
  serviceDate: string;
  serviceTime: string | null;
  pickup: string;
  dropoff: string;
  liveStatus: string | null;
  passengerName: string | null;
  passengerPhone: string | null;
  driverNotes: string | null;
  extrasDescription: string | null;
  extrasAmount: string | null;
  extrasPaidAt: string | null;
  airportWaitStartedAt: string | null;
  airportWaitAllowanceMinutes: number | null;
};

const LIVE_TRANSITIONS: Record<string, BookingLiveStatus[]> = {
  "": ["En route"],
  "En route": ["Waiting near pickup", "Arrived at pickup"],
  "Waiting near pickup": ["Arrived at pickup"],
  "Arrived at pickup": ["Passenger on board"],
  "Passenger on board": ["Journey started"],
  "Journey started": ["On break", "Arrived at destination"],
  "On break": ["Resume journey"],
  "Resume journey": ["On break", "Arrived at destination"],
  "Arrived at destination": ["Extras payable", "Ride finished"],
  "Extras payable": ["Extras paid"],
  "Extras paid": ["Ride finished"],
  "Ride finished": []
};

export function isAllowedDriverStatusTransition(previousStatus: string | null, nextStatus: BookingLiveStatus): boolean {
  return Boolean(LIVE_TRANSITIONS[previousStatus ?? ""]?.includes(nextStatus));
}

export async function listDriverBookings(driverId: string): Promise<DriverBooking[]> {
  const result = await query<{
    id: string;
    reference: string;
    service_date: string;
    service_time: string | null;
    pickup: string;
    dropoff: string;
    live_status: string | null;
    passenger_name: string | null;
    passenger_phone: string | null;
    driver_notes: string | null;
    extras_description: string | null;
    extras_amount: string | null;
    extras_paid_at: string | null;
    airport_wait_started_at: string | null;
    airport_wait_allowance_minutes: number | null;
  }>(
    `SELECT b.id, b.reference, b.service_date, b.service_time, b.pickup, b.dropoff,
            b.live_status, b.passenger_name, b.passenger_phone, b.driver_notes,
            b.extras_description, b.extras_amount, b.extras_paid_at,
            arrival.occurred_at AS airport_wait_started_at,
            (arrival.details->>'airportWaitingAllowanceMinutes')::integer AS airport_wait_allowance_minutes
       FROM customer_bookings b
       LEFT JOIN LATERAL (
         SELECT occurred_at, details
           FROM booking_live_status_audit
          WHERE booking_id = b.id AND new_status = 'Arrived at pickup'
          ORDER BY occurred_at DESC
          LIMIT 1
       ) arrival ON TRUE
      WHERE b.driver_id = $1
        AND b.status = 'Driver assigned'
        AND b.archived_at IS NULL
        AND b.service_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/London')::date::text
      ORDER BY b.service_date, b.service_time NULLS LAST
      LIMIT 100`,
    [driverId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    serviceDate: row.service_date,
    serviceTime: row.service_time,
    pickup: row.pickup,
    dropoff: row.dropoff,
    liveStatus: row.live_status,
    passengerName: row.passenger_name,
    passengerPhone: row.passenger_phone,
    driverNotes: row.driver_notes,
    extrasDescription: row.extras_description,
    extrasAmount: row.extras_amount === null ? null : Number(row.extras_amount).toFixed(2),
    extrasPaidAt: row.extras_paid_at,
    airportWaitStartedAt: row.airport_wait_started_at,
    airportWaitAllowanceMinutes: row.airport_wait_allowance_minutes
  }));
}

export async function setDriverOnline(driverId: string, now = new Date()): Promise<void> {
  await query(
    `INSERT INTO driver_presence (driver_id, online_until, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (driver_id) DO UPDATE
       SET online_until = EXCLUDED.online_until, updated_at = EXCLUDED.updated_at`,
    [driverId, new Date(now.getTime() + 5 * 60_000).toISOString(), now.toISOString()]
  );
}

export async function setDriverOffline(driverId: string, now = new Date()): Promise<void> {
  await query(
    `INSERT INTO driver_presence (driver_id, online_until, updated_at)
     VALUES ($1, $2, $2)
     ON CONFLICT (driver_id) DO UPDATE
       SET online_until = EXCLUDED.online_until, updated_at = EXCLUDED.updated_at`,
    [driverId, now.toISOString()]
  );
}

export async function isDriverOnline(driverId: string): Promise<boolean> {
  const result = await query<{ online: boolean }>(
    "SELECT COALESCE(online_until > CURRENT_TIMESTAMP, FALSE) AS online FROM driver_presence WHERE driver_id = $1",
    [driverId]
  );
  return result.rows[0]?.online ?? false;
}

export async function updateDriverBookingStatus(input: {
  bookingId: string;
  driverId: string;
  actorEmail: string;
  status: BookingLiveStatus;
  extrasDescription?: string;
  extrasAmount?: string;
  driverNotes?: string;
  now?: Date;
}): Promise<"updated" | "not-found" | "not-changeable"> {
  if (!BOOKING_LIVE_STATUSES.includes(input.status)) throw new TypeError("Choose a valid journey status.");
  const description = input.extrasDescription?.trim() ?? "";
  const amountText = input.extrasAmount?.trim() ?? "";
  const notes = input.driverNotes?.trim() ?? "";
  let amount: number | null = null;
  if (input.status === "Extras payable") {
    amount = Number(amountText);
    if (!description || description.length > 500 || !Number.isFinite(amount) || amount <= 0 || amount > 10000) {
      throw new TypeError("Enter an extras description and an amount between 0.01 and 10000.");
    }
    amount = Math.round(amount * 100) / 100;
  }
  if (input.status === "Ride finished" && notes.length > 2000) {
    throw new TypeError("Driver notes must be no more than 2000 characters.");
  }

  return withTransaction(async (client) => {
    const currentResult = await client.query<{
      live_status: string | null;
      passenger_name: string | null;
      passenger_phone: string | null;
      booking_manager_name: string | null;
      booking_manager_phone: string | null;
      booking_manager_email: string | null;
      notify_booking_manager: boolean;
      extras_amount: string | null;
      extras_paid_at: string | null;
      pickup_location_kind: string | null;
      pickup_airport_id: string | null;
      pickup_deferred_enabled: boolean | null;
      pickup_deferred_minutes: number | null;
      pickup_fee_covered_minutes: number | null;
    }>(
      `SELECT b.live_status, b.passenger_name, b.passenger_phone,
              b.booking_manager_name, b.booking_manager_phone, b.booking_manager_email,
              b.notify_booking_manager, b.extras_amount, b.extras_paid_at,
              pickup.location_kind AS pickup_location_kind, pickup.managed_location_id AS pickup_airport_id,
              airport.pickup_deferred_enabled, airport.pickup_deferred_minutes, airport.pickup_fee_covered_minutes
         FROM customer_bookings b
         LEFT JOIN booking_journey_stops pickup
           ON pickup.booking_id = b.id AND pickup.stop_type = 'pickup'
         LEFT JOIN airport_fee_configurations airport
           ON pickup.location_kind = 'airport' AND airport.id = pickup.managed_location_id
        WHERE b.id = $1 AND b.driver_id = $2 AND b.status = 'Driver assigned'
          AND b.archived_at IS NULL
        FOR UPDATE OF b`,
      [input.bookingId, input.driverId]
    );
    const current = currentResult.rows[0];
    if (!current) return "not-found";
    if (!isAllowedDriverStatusTransition(current.live_status, input.status)) return "not-changeable";
    if (input.status === "Ride finished" && current.extras_amount !== null && !current.extras_paid_at) {
      return "not-changeable";
    }
    const details: Record<string, unknown> = {};
    if (input.status === "Arrived at pickup" && current.pickup_location_kind === "airport") {
      const deferredMinutes = current.pickup_deferred_enabled ? current.pickup_deferred_minutes ?? 0 : 0;
      details.airportWaitingAllowanceMinutes = deferredMinutes + (current.pickup_fee_covered_minutes ?? 0);
      details.airportPolicy = {
        airportId: current.pickup_airport_id,
        deferredEnabled: current.pickup_deferred_enabled,
        deferredMinutes,
        feeCoveredMinutes: current.pickup_fee_covered_minutes ?? 0
      };
    }
    if (input.status === "Extras payable") {
      details.extrasDescription = description;
      details.extrasAmount = amount;
    }
    if (input.status === "Ride finished" && notes) details.driverNotes = notes;

    const occurredAt = (input.now ?? new Date()).toISOString();
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO booking_live_status_audit
        (id, booking_id, previous_status, new_status, details, actor_user_id, actor_email, occurred_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [eventId, input.bookingId, current.live_status, input.status, JSON.stringify(details), input.driverId, input.actorEmail, occurredAt]
    );
    await client.query(
      `UPDATE customer_bookings
          SET live_status = $2,
              extras_description = CASE WHEN $2 = 'Extras payable' THEN $3 ELSE extras_description END,
              extras_amount = CASE WHEN $2 = 'Extras payable' THEN $4 ELSE extras_amount END,
              extras_paid_at = CASE WHEN $2 = 'Extras paid' THEN $5 ELSE extras_paid_at END,
              driver_notes = CASE WHEN $2 = 'Ride finished' THEN NULLIF($6, '') ELSE driver_notes END
        WHERE id = $1`,
      [input.bookingId, input.status, description || null, amount, occurredAt, notes]
    );

    const earlyStatus = ["En route", "Waiting near pickup", "Arrived at pickup"].includes(input.status);
    const recipients: Array<{ type: "lead_passenger" | "booking_manager"; name: string; email: string | null; phone: string | null }> = [];
    if (earlyStatus && (current.passenger_name || current.passenger_phone)) {
      recipients.push({
        type: "lead_passenger",
        name: current.passenger_name ?? "Lead passenger",
        email: null,
        phone: current.passenger_phone
      });
    }
    if (current.notify_booking_manager) {
      recipients.push({
        type: "booking_manager",
        name: current.booking_manager_name ?? "Booking manager",
        email: current.booking_manager_email,
        phone: current.booking_manager_phone
      });
    }
    for (const recipient of recipients) {
      if (!recipient.email && !recipient.phone) continue;
      await client.query(
        `INSERT INTO booking_status_notification_outbox
          (id, booking_id, live_event_id, recipient_type, recipient_name, recipient_email, recipient_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), input.bookingId, eventId, recipient.type, recipient.name, recipient.email, recipient.phone]
      );
    }
    return "updated";
  });
}
