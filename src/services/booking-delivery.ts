import { parsePhoneNumberFromString } from "libphonenumber-js";
import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../database/connection";
import {
  getStoredEmailDeliveryConfig,
  getEmailDeliveryConfigFingerprint,
  getEmailTemplate,
  renderEmailTemplate,
  type EmailDeliveryConfig,
  type EmailDeliveryMode
} from "./email-templates";
import {
  isWhatsAppBookingEventType,
  loadSendableWhatsAppSettings,
  whatsAppTemplateParams,
  type SendableWhatsAppEventSetting,
  type WhatsAppBookingEventType
} from "./whatsapp-booking-notifications";

type DeliveryEvent = "payment_link" | "payment_paid" | "payment_cancelled" | "customer_reminder_24h" | "driver_reminder_24h" | "live_status"
  | WhatsAppBookingEventType;
type DeliveryChannel = "email" | "whatsapp";

type DeliveryRow = {
  id: string;
  booking_id: string;
  event_type: DeliveryEvent;
  recipient_type: string;
  channel: DeliveryChannel;
  recipient_name: string;
  recipient_contact: string;
  payload: Record<string, unknown>;
  attempts: number;
  email_delivery_mode: EmailDeliveryMode;
};

function messageText(row: DeliveryRow): string {
  const payload = row.payload;
  const reference = String(payload.reference ?? "booking");
  if (row.event_type === "payment_link") {
    return `Payment is due for booking ${reference}. Pay securely using this link: ${String(payload.paymentUrl ?? "")}`;
  }
  if (row.event_type === "payment_paid") {
    return `Payment of ${String(payload.currency ?? "GBP")} ${String(payload.amount ?? "")} was received for booking ${reference}.`;
  }
  if (row.event_type === "payment_cancelled") {
    return `Booking ${reference} has been cancelled because payment was not received before the payment deadline. Contact the booking team if you need help.`;
  }
  if (row.event_type === "driver_reminder_24h") {
    return `Reminder: you are assigned to booking ${reference} on ${String(payload.serviceDateTime ?? "")}. Pickup: ${String(payload.pickup ?? "")}.`;
  }
  if (row.event_type === "live_status") {
    return `Booking ${reference} update: ${String(payload.status ?? "")}.`;
  }
  if (row.event_type === "booking_received") {
    return `We have received booking ${reference} for ${String(payload.serviceDateTime ?? "")}.`;
  }
  if (row.event_type === "driver_assignment") {
    return `A driver has been assigned to booking ${reference}: ${String(payload.driverName ?? "")}.`;
  }
  return `Reminder: booking ${reference} is scheduled for ${String(payload.serviceDateTime ?? "")}. Pickup: ${String(payload.pickup ?? "")}. Destination: ${String(payload.dropoff ?? "")}.`;
}

function createSmtpTransport(config: EmailDeliveryConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.auth ? { auth: config.auth } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  });
}

export async function sendBookingEmail(row: DeliveryRow): Promise<void> {
  const config = await getStoredEmailDeliveryConfig(row.email_delivery_mode);
  if (!config) {
    throw new Error(row.email_delivery_mode === "mailpit"
      ? "Mailpit SMTP is not configured. Configure its host and sender in Settings → Messaging → Email."
      : "SES SMTP is not configured. Configure its host, credentials, and sender in Settings → Messaging → Email.");
  }
  const emailTemplate = row.event_type === "booking_received" || row.event_type === "payment_link" ||
      row.event_type === "payment_paid" || row.event_type === "payment_cancelled" ||
      row.event_type === "driver_assignment"
    ? await getEmailTemplate(row.event_type)
    : null;
  const templateValues = { payerName: row.recipient_name, ...row.payload };
  const subject = emailTemplate
    ? renderEmailTemplate(emailTemplate.subjectTemplate, templateValues)
    : row.event_type === "payment_link"
      ? `Payment link for booking ${String(row.payload.reference ?? "")}`
      : row.event_type === "payment_paid"
        ? `Payment received for booking ${String(row.payload.reference ?? "")}`
        : row.event_type === "payment_cancelled"
          ? `Booking ${String(row.payload.reference ?? "")} cancelled`
      : row.event_type === "driver_reminder_24h"
        ? `Tomorrow's assigned journey: ${String(row.payload.reference ?? "")}`
        : row.event_type === "live_status"
          ? `Journey update: ${String(row.payload.reference ?? "")}`
          : `Journey reminder: ${String(row.payload.reference ?? "")}`;
  const text = emailTemplate
    ? renderEmailTemplate(emailTemplate.bodyTemplate, templateValues)
    : messageText(row);
  const transporter = createSmtpTransport(config);
  await transporter.sendMail({
    from: config.from,
    to: row.recipient_contact,
    subject: subject.replace(/[\r\n]+/g, " ").slice(0, 180),
    text,
    messageId: `<${row.id}@ridematrix.local>`
  });
}

export async function testEmailDeliveryConnection(mode: EmailDeliveryMode): Promise<string> {
  const config = await getStoredEmailDeliveryConfig(mode);
  if (!config) {
    throw new TypeError("Configure the selected SMTP connection before testing it.");
  }
  const transporter = createSmtpTransport(config);
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
  return getEmailDeliveryConfigFingerprint(config);
}

export async function sendBookingWhatsApp(row: DeliveryRow, setting: SendableWhatsAppEventSetting): Promise<void> {
  const accessToken = String(process.env.WHATSAPP_ACCESS_TOKEN ?? "").trim();
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const apiVersion = String(process.env.WHATSAPP_API_VERSION ?? "").trim();
  if (!accessToken || !phoneNumberId || !apiVersion) {
    throw new Error("WhatsApp Business API is not configured. Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_API_VERSION.");
  }
  const phone = parsePhoneNumberFromString(row.recipient_contact);
  if (!phone?.isValid()) throw new TypeError("WhatsApp recipient must be a valid international phone number.");
  const templateParams = whatsAppTemplateParams(setting.eventType, row.payload);
  const response = await fetch(`https://graph.facebook.com/${encodeURIComponent(apiVersion)}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone.number.replace("+", ""),
      type: "template",
      template: {
        name: setting.templateName,
        language: { code: setting.templateLanguage },
        ...(templateParams.length ? {
          components: [{
            type: "body",
            parameters: templateParams.map((text) => ({ type: "text", text }))
          }]
        } : {})
      }
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`WhatsApp API returned ${response.status}: ${body.slice(0, 1000)}`);
  }
}

export async function enqueueDelivery(input: {
  bookingId: string;
  eventType: DeliveryEvent;
  recipientType: "payer" | "lead_passenger" | "booking_manager" | "driver";
  channel: DeliveryChannel;
  recipientName: string;
  recipientContact: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
  eventKey?: string;
  actorId?: string;
  actorEmail?: string;
}): Promise<void> {
  if (!input.recipientContact.trim()) throw new TypeError("A delivery recipient contact is required.");
  await query(
    `INSERT INTO booking_delivery_outbox (
       id, booking_id, event_type, event_key, recipient_type, channel, recipient_name, recipient_contact,
       payload, available_at, created_by_account_id, created_by_email
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
     ON CONFLICT (booking_id, event_type, event_key, recipient_type, channel, recipient_contact) DO NOTHING`,
    [randomUUID(), input.bookingId, input.eventType, input.eventKey ?? "", input.recipientType, input.channel,
      input.recipientName.trim().slice(0, 200), input.recipientContact.trim().slice(0, 254),
      JSON.stringify(input.payload), (input.availableAt ?? new Date()).toISOString(),
      input.actorId ?? null, input.actorEmail ?? null]
  );
}

export async function recordBookingIntegrationAlert(input: {
  bookingId: string;
  alertType: string;
  details: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO booking_integration_alerts (id, booking_id, alert_type, details)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (booking_id, alert_type) DO NOTHING`,
    [randomUUID(), input.bookingId, input.alertType, JSON.stringify(input.details)]
  );
}

async function claimPendingMessages(limit: number): Promise<DeliveryRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<DeliveryRow>(
      `SELECT id, booking_id, event_type, recipient_type, channel, recipient_name,
              recipient_contact, payload, attempts,
              (SELECT delivery_mode FROM email_messaging_settings WHERE id = 1) AS email_delivery_mode
         FROM booking_delivery_outbox
        WHERE delivery_status IN ('pending', 'failed', 'sending')
          AND available_at <= CURRENT_TIMESTAMP
          AND (
            channel = 'whatsapp'
            OR (channel = 'email' AND EXISTS (
              SELECT 1 FROM email_messaging_settings WHERE id = 1 AND enabled = TRUE
            ))
          )
        ORDER BY available_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit]
    );
    if (!result.rows.length) return [];
    await client.query(
      `UPDATE booking_delivery_outbox
          SET delivery_status = 'sending', attempts = attempts + 1,
              available_at = CURRENT_TIMESTAMP + INTERVAL '2 minutes'
        WHERE id = ANY($1::text[])`,
      [result.rows.map((row) => row.id)]
    );
    return result.rows;
  });
}

function resolveWhatsAppSkipReason(
  row: DeliveryRow,
  settings: Map<WhatsAppBookingEventType, SendableWhatsAppEventSetting>
): string | null {
  if (!isWhatsAppBookingEventType(row.event_type)) return "Event has no WhatsApp notification configuration.";
  if (!settings.has(row.event_type)) return "WhatsApp notification is disabled or has no approved template configured.";
  return null;
}

export async function deliverPendingBookingMessages(limit = 50): Promise<number> {
  const rows = await claimPendingMessages(limit);
  const whatsappSettings = await loadSendableWhatsAppSettings();
  let delivered = 0;
  for (const row of rows) {
    try {
      if (row.channel === "email") {
        await sendBookingEmail(row);
      } else {
        const skipReason = resolveWhatsAppSkipReason(row, whatsappSettings);
        if (skipReason) {
          await query(
            `UPDATE booking_delivery_outbox
                SET delivery_status = 'skipped', last_error = $2
              WHERE id = $1 AND delivery_status = 'sending'`,
            [row.id, skipReason]
          );
          continue;
        }
        await sendBookingWhatsApp(row, whatsappSettings.get(row.event_type as WhatsAppBookingEventType)!);
      }
      await query(
        `UPDATE booking_delivery_outbox
            SET delivery_status = 'sent', sent_at = CURRENT_TIMESTAMP, last_error = NULL
          WHERE id = $1 AND delivery_status = 'sending'`,
        [row.id]
      );
      delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown delivery failure.";
      const retryMinutes = Math.min(60, 2 ** Math.min(row.attempts, 6));
      await query(
        `UPDATE booking_delivery_outbox
            SET delivery_status = 'failed', last_error = $2,
                available_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 minute')
          WHERE id = $1 AND delivery_status = 'sending'`,
        [row.id, message.slice(0, 1000), retryMinutes]
      );
      await recordBookingIntegrationAlert({
        bookingId: row.booking_id,
        alertType: `${row.event_type}-${row.channel}-delivery-failed`,
        details: { message: message.slice(0, 1000), recipientType: row.recipient_type }
      });
      console.error(`[booking-delivery] Failed ${row.channel} delivery ${row.id}: ${message}`);
    }
  }
  return delivered;
}
