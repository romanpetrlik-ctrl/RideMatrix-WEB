import { query, withTransaction } from "../database/connection";
import { changeBookingStatus } from "./booking-dashboard";
import {
  enqueueDelivery,
  recordBookingIntegrationAlert
} from "./booking-delivery";
import {
  expireBookingCheckoutSession,
  retrieveBookingCheckoutSession,
  sendBookingPaymentLink
} from "./stripe-bookings";

type PaymentCandidate = { id: string };

export async function scheduleDueBookingPaymentLinks(limit = 100): Promise<number> {
  const result = await query<PaymentCandidate>(
    `SELECT id
       FROM customer_bookings
      WHERE status = 'Driver assigned' AND archived_at IS NULL
        AND payment_method = 'payment-link' AND payment_status NOT IN ('paid', 'expired')
        AND payment_due_at <= CURRENT_TIMESTAMP
        AND NOT EXISTS (
          SELECT 1 FROM booking_delivery_outbox d
           WHERE d.booking_id = customer_bookings.id
             AND d.event_type = 'payment_link' AND d.event_key = ''
             AND d.recipient_type = 'payer' AND d.channel = 'email'
             AND d.recipient_contact = btrim(customer_bookings.payer_email)
        )
      ORDER BY payment_due_at, id
      LIMIT $1`,
    [limit]
  );
  let processed = 0;
  for (const booking of result.rows) {
    try {
      const state = await sendBookingPaymentLink({ bookingId: booking.id });
      if (state === "sent") processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Stripe checkout failure.";
      await recordBookingIntegrationAlert({
        bookingId: booking.id,
        alertType: "payment-link-failed",
        details: { message }
      });
      console.error(`[booking-automation] Payment link failed for ${booking.id}: ${message}`);
    }
  }
  return processed;
}

async function markBookingPaid(bookingId: string, sessionId: string): Promise<void> {
  await query(
    `UPDATE customer_bookings
        SET payment_status = 'paid', payment_paid_at = COALESCE(payment_paid_at, CURRENT_TIMESTAMP)
      WHERE id = $1 AND stripe_checkout_session_id = $2 AND payment_status <> 'paid'`,
    [bookingId, sessionId]
  );
  await query(
    `UPDATE booking_delivery_outbox SET delivery_status = 'skipped'
      WHERE booking_id = $1 AND event_type = 'payment_link'
        AND delivery_status IN ('pending', 'failed')`,
    [bookingId]
  );
}

async function cancelForUnpaidPayment(bookingId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      status: string;
      payment_status: string;
      archived_at: string | null;
    }>(
      `SELECT status, payment_status, archived_at
         FROM customer_bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    const booking = result.rows[0];
    if (!booking || booking.archived_at || booking.status !== "Driver assigned" ||
        booking.payment_status === "paid") return false;
    const changed = await changeBookingStatus({
      bookingId,
      status: "Cancelled",
      reason: "Payment was not received by the automated payment deadline.",
      actorId: "booking-integrations",
      actorEmail: "booking-integrations@system.invalid"
    }, client);
    if (changed !== "updated") return false;
    await client.query(
      `UPDATE customer_bookings
          SET payment_status = 'expired'
        WHERE id = $1 AND payment_status <> 'paid'`,
      [bookingId]
    );
    await client.query(
      `UPDATE booking_delivery_outbox SET delivery_status = 'skipped'
        WHERE booking_id = $1 AND event_type = 'payment_link'
          AND delivery_status IN ('pending', 'failed')`,
      [bookingId]
    );
    return true;
  });
}

export async function reconcileBookingPaymentDeadlines(limit = 100): Promise<number> {
  const result = await query<PaymentCandidate>(
    `SELECT id
       FROM customer_bookings
      WHERE status = 'Driver assigned' AND archived_at IS NULL
        AND payment_method = 'payment-link'
        AND payment_status IN ('scheduled', 'link_sent', 'failed')
        AND payment_deadline_at IS NOT NULL AND payment_deadline_at <= CURRENT_TIMESTAMP
      ORDER BY payment_deadline_at, id
      LIMIT $1`,
    [limit]
  );
  let cancelled = 0;
  for (const candidate of result.rows) {
    const booking = await query<{ stripe_checkout_session_id: string | null; payer_name: string | null; payer_email: string | null; reference: string }>(
      `SELECT stripe_checkout_session_id, payer_name, payer_email, reference
         FROM customer_bookings WHERE id = $1`,
      [candidate.id]
    );
    const row = booking.rows[0];
    if (!row?.stripe_checkout_session_id) {
      await recordBookingIntegrationAlert({
        bookingId: candidate.id,
        alertType: "payment-deadline-without-session",
        details: { message: "The payment deadline passed without a Stripe Checkout session; dispatcher review is required." }
      });
      continue;
    }
    try {
      let session = await retrieveBookingCheckoutSession(row.stripe_checkout_session_id);
      if (session.payment_status === "paid") {
        await markBookingPaid(candidate.id, session.id);
        continue;
      }
      if (session.status === "open") {
        try {
          await expireBookingCheckoutSession(session.id);
        } catch (error) {
          session = await retrieveBookingCheckoutSession(session.id);
          if (session.payment_status !== "paid" && session.status === "open") throw error;
        }
        session = await retrieveBookingCheckoutSession(session.id);
      }
      if (session.payment_status === "paid") {
        await markBookingPaid(candidate.id, session.id);
        continue;
      }
      if (session.status !== "expired") {
        throw new Error(`Stripe Checkout session ${session.id} is still ${session.status}; automatic cancellation was not applied.`);
      }
      if (!await cancelForUnpaidPayment(candidate.id)) continue;
      cancelled += 1;
      if (row.payer_email && row.payer_name) {
        await enqueueDelivery({
          bookingId: candidate.id,
          eventType: "payment_cancelled",
          recipientType: "payer",
          channel: "email",
          recipientName: row.payer_name,
          recipientContact: row.payer_email,
          payload: { reference: row.reference }
        });
      } else {
        await recordBookingIntegrationAlert({
          bookingId: candidate.id,
          alertType: "payment-cancelled-payer-notification-failed",
          details: { message: "Booking was cancelled for non-payment, but payer contact details are missing." }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown payment reconciliation failure.";
      await recordBookingIntegrationAlert({
        bookingId: candidate.id,
        alertType: "payment-reconciliation-failed",
        details: { message }
      });
      console.error(`[booking-automation] Payment reconciliation failed for ${candidate.id}: ${message}`);
    }
  }
  return cancelled;
}

type ReminderBooking = {
  id: string;
  reference: string;
  service_date: string;
  service_time: string | null;
  pickup: string;
  dropoff: string;
  passenger_name: string | null;
  passenger_email: string | null;
  passenger_phone: string | null;
  passenger_is_booking_manager: boolean | null;
  passenger_whatsapp_opt_in: boolean;
  notify_booking_manager: boolean;
  booking_manager_name: string | null;
  booking_manager_email: string | null;
  booking_manager_phone: string | null;
  booking_manager_whatsapp_opt_in: boolean;
  driver_id: string | null;
  driver_name: string | null;
  driver_whatsapp_phone: string | null;
  driver_whatsapp_opt_in: boolean;
};

function reminderPayload(row: ReminderBooking): Record<string, unknown> {
  return {
    reference: row.reference,
    serviceDateTime: `${row.service_date}${row.service_time ? ` ${row.service_time}` : ""}`,
    pickup: row.pickup,
    dropoff: row.dropoff
  };
}

export async function scheduleBookingReminders(limit = 500): Promise<number> {
  const result = await query<ReminderBooking>(
    `SELECT b.id, b.reference, b.service_date, b.service_time, b.pickup, b.dropoff,
            b.passenger_name, b.passenger_email, b.passenger_phone,
            b.passenger_is_booking_manager, b.passenger_whatsapp_opt_in,
            b.notify_booking_manager, b.booking_manager_name, b.booking_manager_email,
            b.booking_manager_phone, b.booking_manager_whatsapp_opt_in,
            b.driver_id, COALESCE(dp.short_name, u.email) AS driver_name,
            dp.whatsapp_phone AS driver_whatsapp_phone, COALESCE(dp.whatsapp_opt_in, FALSE) AS driver_whatsapp_opt_in
       FROM customer_bookings b
       LEFT JOIN users u ON u.id::text = b.driver_id
       LEFT JOIN driver_profiles dp ON dp.driver_id = b.driver_id::text
      WHERE b.archived_at IS NULL AND b.status NOT IN ('Cancelled', 'Completed', 'No Show')
        AND ((b.service_date::date + COALESCE(b.service_time, '00:00')::time)
              AT TIME ZONE COALESCE(b.service_timezone, 'Europe/London'))
            BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '24 hours'
      ORDER BY b.service_date, b.service_time, b.id
      LIMIT $1`,
    [limit]
  );
  let enqueued = 0;
  for (const row of result.rows) {
    const payload = reminderPayload(row);
    if (row.passenger_email) {
      await enqueueDelivery({
        bookingId: row.id,
        eventType: "customer_reminder_24h",
        recipientType: "lead_passenger",
        channel: "email",
        recipientName: row.passenger_name || "Passenger",
        recipientContact: row.passenger_email,
        payload
      });
      enqueued += 1;
    } else {
      await recordBookingIntegrationAlert({
        bookingId: row.id,
        alertType: "customer-reminder-email-missing",
        details: { message: "Lead passenger has no email address for the 24-hour reminder." }
      });
    }
    if (row.passenger_whatsapp_opt_in && row.passenger_phone) {
      await enqueueDelivery({
        bookingId: row.id,
        eventType: "customer_reminder_24h",
        recipientType: "lead_passenger",
        channel: "whatsapp",
        recipientName: row.passenger_name || "Passenger",
        recipientContact: row.passenger_phone,
        payload
      });
      enqueued += 1;
    } else {
      await recordBookingIntegrationAlert({
        bookingId: row.id,
        alertType: row.passenger_whatsapp_opt_in ? "passenger-whatsapp-phone-missing" : "passenger-whatsapp-opt-in-missing",
        details: { message: row.passenger_whatsapp_opt_in
          ? "Passenger WhatsApp reminder skipped because no phone number is available."
          : "Passenger 24-hour WhatsApp reminder skipped because explicit opt-in is missing." }
      });
    }
    if (row.notify_booking_manager && !row.passenger_is_booking_manager) {
      if (row.booking_manager_email) {
        await enqueueDelivery({
          bookingId: row.id,
          eventType: "customer_reminder_24h",
          recipientType: "booking_manager",
          channel: "email",
          recipientName: row.booking_manager_name || "Booking manager",
          recipientContact: row.booking_manager_email,
          payload
        });
        enqueued += 1;
      } else {
        await recordBookingIntegrationAlert({
          bookingId: row.id,
          alertType: "booking-manager-reminder-email-missing",
          details: { message: "Booking manager notification was requested but no email address is available." }
        });
      }
      if (row.booking_manager_whatsapp_opt_in && row.booking_manager_phone) {
        await enqueueDelivery({
          bookingId: row.id,
          eventType: "customer_reminder_24h",
          recipientType: "booking_manager",
          channel: "whatsapp",
          recipientName: row.booking_manager_name || "Booking manager",
          recipientContact: row.booking_manager_phone,
          payload
        });
        enqueued += 1;
      } else {
        await recordBookingIntegrationAlert({
          bookingId: row.id,
          alertType: row.booking_manager_whatsapp_opt_in ? "booking-manager-whatsapp-phone-missing" : "booking-manager-whatsapp-opt-in-missing",
          details: { message: row.booking_manager_whatsapp_opt_in
            ? "Booking manager WhatsApp reminder skipped because no phone number is available."
            : "Booking manager WhatsApp reminder skipped because explicit opt-in is missing." }
        });
      }
    }
    await query(
      `UPDATE booking_delivery_outbox
          SET delivery_status = 'skipped'
        WHERE booking_id = $1 AND event_type = 'driver_reminder_24h'
          AND recipient_type = 'driver' AND channel = 'whatsapp'
          AND delivery_status IN ('pending', 'failed')
          AND (NOT $2::boolean OR recipient_contact <> $3)`,
      [row.id, Boolean(row.driver_id && row.driver_whatsapp_opt_in && row.driver_whatsapp_phone), row.driver_whatsapp_phone || ""]
    );
    if (row.driver_id && row.driver_whatsapp_opt_in && row.driver_whatsapp_phone) {
      await enqueueDelivery({
        bookingId: row.id,
        eventType: "driver_reminder_24h",
        recipientType: "driver",
        channel: "whatsapp",
        recipientName: row.driver_name || "Driver",
        recipientContact: row.driver_whatsapp_phone,
        payload
      });
      enqueued += 1;
    } else if (row.driver_id && (!row.driver_whatsapp_opt_in || !row.driver_whatsapp_phone)) {
      await recordBookingIntegrationAlert({
        bookingId: row.id,
        alertType: row.driver_whatsapp_opt_in ? "driver-whatsapp-phone-missing" : "driver-whatsapp-opt-in-missing",
        details: { message: row.driver_whatsapp_opt_in
          ? "Driver 24-hour WhatsApp reminder skipped because no WhatsApp phone number is available."
          : "Driver 24-hour WhatsApp reminder skipped because explicit opt-in is missing." }
      });
    }
  }
  return enqueued;
}
