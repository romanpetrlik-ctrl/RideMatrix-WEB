import { randomUUID } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { query } from "../database/connection";
import { enqueueDelivery } from "./booking-delivery";
import { getEmailMessagingSettings } from "./email-templates";
import { retrieveBookingCheckoutSession, isStripeCheckoutPaymentValid } from "./stripe-bookings";
import { loadSendableWhatsAppSettings } from "./whatsapp-booking-notifications";

export type BookingNotificationKind = "booking_received" | "payment_link" | "driver_assignment";
export type BookingNotificationChannel = "email" | "whatsapp";

export class BookingNotificationError extends Error {
  constructor(readonly code:
    | "not-found"
    | "booking-not-sendable"
    | "payment-link-unavailable"
    | "recipient-missing"
    | "whatsapp-opt-in-required"
    | "messaging-not-ready") {
    super(code);
  }
}

type BookingNotificationRow = {
  id: string;
  reference: string;
  status: string;
  archived_at: string | null;
  service_date: string;
  service_time: string | null;
  pickup: string;
  dropoff: string;
  passenger_name: string | null;
  passenger_email: string | null;
  passenger_phone: string | null;
  passenger_whatsapp_opt_in: boolean;
  booking_manager_phone: string | null;
  booking_manager_whatsapp_opt_in: boolean;
  payer_type: string;
  payer_name: string | null;
  payer_email: string | null;
  payer_phone: string | null;
  payment_method: string | null;
  payment_status: string;
  payment_deadline_at: string | null;
  total_fare_amount: string | number | null;
  stripe_checkout_session_id: string | null;
  stripe_checkout_url: string | null;
  driver_id: string | null;
  driver_name: string | null;
  vehicle_registration: string | null;
};

function normalizedPhone(value: string | null): string | null {
  const phone = value ? parsePhoneNumberFromString(value) : undefined;
  return phone?.isValid() ? phone.number : null;
}

function payerWhatsAppOptedIn(booking: BookingNotificationRow): boolean {
  const payerPhone = normalizedPhone(booking.payer_phone);
  if (!payerPhone) return false;
  if (booking.payer_type === "lead_passenger") {
    return booking.passenger_whatsapp_opt_in &&
      payerPhone === normalizedPhone(booking.passenger_phone);
  }
  if (booking.payer_type === "booking_manager") {
    return booking.booking_manager_whatsapp_opt_in &&
      payerPhone === normalizedPhone(booking.booking_manager_phone);
  }
  return false;
}

export async function resendBookingNotification(input: {
  bookingId: string;
  kind: BookingNotificationKind;
  channel: BookingNotificationChannel;
  actorId: string;
  actorEmail: string;
}): Promise<void> {
  const result = await query<BookingNotificationRow>(
    `SELECT b.id, b.reference, b.status, b.archived_at, b.service_date, b.service_time,
            b.pickup, b.dropoff, b.passenger_name, b.passenger_email, b.passenger_phone,
            b.passenger_whatsapp_opt_in, b.booking_manager_phone, b.booking_manager_whatsapp_opt_in,
            b.payer_type, b.payer_name, b.payer_email, b.payer_phone, b.payment_method,
            b.payment_status, b.payment_deadline_at, b.total_fare_amount,
            b.stripe_checkout_session_id, b.stripe_checkout_url, b.driver_id,
            NULLIF(btrim(dp.short_name), '') AS driver_name, v.registration AS vehicle_registration
       FROM customer_bookings b
       LEFT JOIN driver_profiles dp ON dp.driver_id = b.driver_id::text
       LEFT JOIN vehicles v ON v.id = b.vehicle_id
      WHERE b.id = $1`,
    [input.bookingId]
  );
  const booking = result.rows[0];
  if (!booking) throw new BookingNotificationError("not-found");
  if (booking.archived_at || ["Cancelled", "Completed", "No Show"].includes(booking.status)) {
    throw new BookingNotificationError("booking-not-sendable");
  }

  let eventType = input.kind;
  let recipientType: "payer" | "lead_passenger" = input.kind === "payment_link" ? "payer" : "lead_passenger";
  let recipientName: string | null;
  let recipientContact: string | null;
  let payload: Record<string, unknown> = {
    reference: booking.reference,
    serviceDateTime: `${booking.service_date}${booking.service_time ? ` ${booking.service_time}` : ""}`,
    pickup: booking.pickup,
    dropoff: booking.dropoff
  };
  if (input.kind === "booking_received") {
    recipientName = booking.passenger_name;
    recipientContact = input.channel === "email" ? booking.passenger_email : booking.passenger_phone;
    payload = { ...payload, passengerName: booking.passenger_name || "Passenger", bookingStatus: booking.status };
  } else if (input.kind === "payment_link") {
    if (booking.status !== "Driver assigned" || booking.payment_method !== "payment-link" ||
        !["scheduled", "link_sent", "failed"].includes(booking.payment_status) ||
        !booking.stripe_checkout_session_id || !booking.stripe_checkout_url ||
        (booking.payment_deadline_at && new Date(booking.payment_deadline_at).getTime() <= Date.now())) {
      throw new BookingNotificationError("payment-link-unavailable");
    }
    let session;
    try {
      session = await retrieveBookingCheckoutSession(booking.stripe_checkout_session_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Stripe verification error.";
      console.error(`[booking-notifications] Could not verify payment link for ${booking.id}: ${message}`);
      throw new BookingNotificationError("payment-link-unavailable");
    }
    if (session.status !== "open" || session.payment_status !== "unpaid" ||
        session.url !== booking.stripe_checkout_url ||
        !isStripeCheckoutPaymentValid(session, booking.total_fare_amount)) {
      throw new BookingNotificationError("payment-link-unavailable");
    }
    recipientName = booking.payer_name;
    recipientContact = input.channel === "email" ? booking.payer_email : booking.payer_phone;
    payload = {
      ...payload,
      payerName: booking.payer_name || "Payer",
      paymentUrl: session.url,
      amount: Number(booking.total_fare_amount).toFixed(2),
      currency: "GBP"
    };
  } else {
    if (booking.status !== "Driver assigned" || !booking.driver_id) {
      throw new BookingNotificationError("booking-not-sendable");
    }
    recipientName = booking.passenger_name;
    recipientContact = input.channel === "email" ? booking.passenger_email : booking.passenger_phone;
    payload = {
      ...payload,
      passengerName: booking.passenger_name || "Passenger",
      driverName: booking.driver_name || "Assigned driver",
      vehicleRegistration: booking.vehicle_registration || "Not provided"
    };
  }

  if (!recipientContact?.trim()) throw new BookingNotificationError("recipient-missing");
  if (input.channel === "email") {
    const settings = await getEmailMessagingSettings();
    if (!settings.enabled || !settings.deliveryConfigured || !settings.deliveryTested) {
      throw new BookingNotificationError("messaging-not-ready");
    }
  } else {
    const settings = await loadSendableWhatsAppSettings();
    if (!settings.has(eventType) || !["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_API_VERSION"]
      .every((name) => Boolean(String(process.env[name] ?? "").trim()))) {
      throw new BookingNotificationError("messaging-not-ready");
    }
    const optedIn = input.kind === "payment_link"
      ? payerWhatsAppOptedIn(booking)
      : booking.passenger_whatsapp_opt_in;
    if (!optedIn) throw new BookingNotificationError("whatsapp-opt-in-required");
    if (!normalizedPhone(recipientContact)) throw new BookingNotificationError("recipient-missing");
  }

  await enqueueDelivery({
    bookingId: booking.id,
    eventType,
    eventKey: `manual-resend:${randomUUID()}`,
    recipientType,
    channel: input.channel,
    recipientName: recipientName?.trim() || (recipientType === "payer" ? "Payer" : "Passenger"),
    recipientContact: recipientContact.trim(),
    payload,
    actorId: input.actorId,
    actorEmail: input.actorEmail
  });
}
