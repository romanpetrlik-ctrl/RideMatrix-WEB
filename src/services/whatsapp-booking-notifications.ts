import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { query } from "../database/connection";

export type WhatsAppTemplateParameterKey = "reference" | "serviceDateTime" | "pickup" | "dropoff" | "status"
  | "paymentUrl" | "amount" | "currency" | "driverName" | "vehicleRegistration";

export const WHATSAPP_BOOKING_EVENTS = [
  {
    type: "booking_received",
    label: "New booking received",
    trigger: "A booking is created with status New; staff can also resend it manually from the booking detail.",
    recipients: "Lead passenger (requires WhatsApp opt-in and phone)",
    parameters: ["reference", "serviceDateTime", "pickup", "dropoff"]
  },
  {
    type: "payment_link",
    label: "Payment link",
    trigger: "Can be sent manually from the booking detail to the payer while the existing Stripe link is active.",
    recipients: "Payer (requires WhatsApp opt-in for the payer's saved phone)",
    parameters: ["reference", "paymentUrl", "amount", "currency"]
  },
  {
    type: "driver_assignment",
    label: "Driver assigned",
    trigger: "Can be sent manually from the booking detail after a driver has been assigned.",
    recipients: "Lead passenger (requires WhatsApp opt-in and phone)",
    parameters: ["reference", "serviceDateTime", "driverName", "vehicleRegistration"]
  },
  {
    type: "availability_review",
    label: "Booking under availability review",
    trigger: "Booking status is changed to Under availability review.",
    recipients: "Lead passenger (requires WhatsApp opt-in and phone)",
    parameters: ["reference", "serviceDateTime", "pickup", "dropoff"]
  },
  {
    type: "booking_accepted",
    label: "Booking accepted",
    trigger: "Booking status is changed to Accepted. Repeated transitions to Accepted do not send again.",
    recipients: "Lead passenger (requires WhatsApp opt-in and phone)",
    parameters: ["reference", "serviceDateTime", "pickup", "dropoff"]
  },
  {
    type: "customer_reminder_24h",
    label: "24-hour journey reminder",
    trigger: "The scheduled job sends it when the service starts within 24 hours.",
    recipients: "Lead passenger and booking manager, when requested (WhatsApp opt-in and phone)",
    parameters: ["reference", "serviceDateTime", "pickup", "dropoff"]
  },
  {
    type: "driver_reminder_24h",
    label: "24-hour driver reminder",
    trigger: "The scheduled job sends it when a driver is assigned and the service starts within 24 hours.",
    recipients: "Assigned driver (WhatsApp opt-in and phone)",
    parameters: ["reference", "serviceDateTime", "pickup"]
  },
  {
    type: "live_status",
    label: "Driver status update",
    trigger: "The driver sets En route, Waiting near pickup or Arrived at pickup.",
    recipients: "Lead passenger and booking manager, when requested (WhatsApp opt-in and phone)",
    parameters: ["reference", "status"]
  }
] as const;

export type WhatsAppBookingEventType = (typeof WHATSAPP_BOOKING_EVENTS)[number]["type"];
export type WhatsAppBookingEventDefinition = (typeof WHATSAPP_BOOKING_EVENTS)[number];

export const WHATSAPP_PARAMETER_LABELS: Record<WhatsAppTemplateParameterKey, string> = {
  reference: "Booking reference",
  serviceDateTime: "Service date and time",
  pickup: "Pickup",
  dropoff: "Destination",
  status: "Driver status",
  paymentUrl: "Payment link",
  amount: "Payment amount",
  currency: "Currency",
  driverName: "Assigned driver",
  vehicleRegistration: "Vehicle registration"
};

export type WhatsAppEventSetting = {
  eventType: WhatsAppBookingEventType;
  enabled: boolean;
  templateName: string | null;
  templateLanguage: string;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

export type SendableWhatsAppEventSetting = WhatsAppEventSetting & { templateName: string };
export type WhatsAppMessagingSwitch = {
  enabled: boolean;
  updatedAt: string;
  updatedByEmail: string | null;
};

const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/;

export function getWhatsAppBookingEvent(eventType: string): WhatsAppBookingEventDefinition | undefined {
  return WHATSAPP_BOOKING_EVENTS.find((event) => event.type === eventType);
}

export function isWhatsAppBookingEventType(eventType: string): eventType is WhatsAppBookingEventType {
  return Boolean(getWhatsAppBookingEvent(eventType));
}

export function whatsAppTemplateParams(eventType: WhatsAppBookingEventType, values: Record<string, unknown>): string[] {
  const definition = getWhatsAppBookingEvent(eventType);
  if (!definition) throw new TypeError(`Unknown WhatsApp booking event: ${eventType}`);
  return definition.parameters.map((key) => String(values[key] ?? ""));
}

export function validateWhatsAppEventSetting(input: {
  eventType: string;
  enabled: boolean;
  templateName: string;
  templateLanguage: string;
}): { enabled: boolean; templateName: string | null; templateLanguage: string } {
  if (!getWhatsAppBookingEvent(input.eventType)) throw new TypeError("Unknown WhatsApp booking notification.");
  const templateName = input.templateName.trim();
  const templateLanguage = input.templateLanguage.trim();
  if (templateName && !TEMPLATE_NAME_PATTERN.test(templateName)) {
    throw new TypeError("Enter the Meta template name using lowercase letters, digits and underscores only.");
  }
  if (!TEMPLATE_LANGUAGE_PATTERN.test(templateLanguage)) {
    throw new TypeError("Enter a template language code such as en_GB or cs.");
  }
  if (input.enabled && !templateName) {
    throw new TypeError("Enter the approved Meta template name before enabling this notification.");
  }
  return {
    enabled: input.enabled,
    templateName: templateName || null,
    templateLanguage
  };
}

export function isWhatsAppEventSendable(setting: WhatsAppEventSetting | undefined): setting is SendableWhatsAppEventSetting {
  return Boolean(setting?.enabled && setting.templateName);
}

async function runQuery<T extends Record<string, unknown>>(client: PoolClient | undefined, text: string, params: unknown[] = []) {
  return client ? client.query<T>(text, params) : query<T>(text, params);
}

type SettingRow = {
  event_type: WhatsAppBookingEventType;
  enabled: boolean;
  template_name: string | null;
  template_language: string;
  updated_at: string | null;
  updated_by_email: string | null;
};

function mapSetting(row: SettingRow): WhatsAppEventSetting {
  return {
    eventType: row.event_type,
    enabled: row.enabled,
    templateName: row.template_name,
    templateLanguage: row.template_language,
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email
  };
}

export async function listWhatsAppBookingNotificationSettings(client?: PoolClient): Promise<WhatsAppEventSetting[]> {
  const result = await runQuery<SettingRow>(client,
    `SELECT event_type, enabled, template_name, template_language, updated_at, updated_by_email
       FROM whatsapp_booking_notification_settings`
  );
  const byType = new Map(result.rows.map((row) => [row.event_type, mapSetting(row)]));
  return WHATSAPP_BOOKING_EVENTS.map((event) => byType.get(event.type) ?? {
    eventType: event.type,
    enabled: false,
    templateName: null,
    templateLanguage: "en_GB",
    updatedAt: null,
    updatedByEmail: null
  });
}

export async function getWhatsAppMessagingSwitch(client?: PoolClient): Promise<WhatsAppMessagingSwitch> {
  const result = await runQuery<{
    enabled: boolean;
    updated_at: string;
    updated_by_email: string | null;
  }>(client,
  `SELECT enabled, updated_at, updated_by_email
     FROM whatsapp_messaging_settings WHERE id = 1`);
  const row = result.rows[0];
  if (!row) throw new Error("WhatsApp messaging switch has not been initialized.");
  return { enabled: row.enabled, updatedAt: row.updated_at, updatedByEmail: row.updated_by_email };
}

export async function saveWhatsAppMessagingSwitch(input: {
  enabled: boolean;
  actorId: string;
  actorEmail: string;
}): Promise<WhatsAppMessagingSwitch> {
  const result = await query<{
    enabled: boolean;
    updated_at: string;
    updated_by_email: string | null;
  }>(
    `UPDATE whatsapp_messaging_settings
        SET enabled = $1, updated_at = CURRENT_TIMESTAMP,
            updated_by_account_id = $2, updated_by_email = $3
      WHERE id = 1
      RETURNING enabled, updated_at, updated_by_email`,
    [input.enabled, input.actorId, input.actorEmail]
  );
  const row = result.rows[0];
  if (!row) throw new Error("WhatsApp messaging switch has not been initialized.");
  return { enabled: row.enabled, updatedAt: row.updated_at, updatedByEmail: row.updated_by_email };
}

export async function getWhatsAppBookingNotificationSetting(eventType: string, client?: PoolClient): Promise<WhatsAppEventSetting | null> {
  if (!getWhatsAppBookingEvent(eventType)) return null;
  const settings = await listWhatsAppBookingNotificationSettings(client);
  return settings.find((setting) => setting.eventType === eventType) ?? null;
}

export async function saveWhatsAppBookingNotificationSetting(input: {
  eventType: string;
  enabled: boolean;
  templateName: string;
  templateLanguage: string;
  actorId: string;
  actorEmail: string;
}): Promise<WhatsAppEventSetting> {
  const valid = validateWhatsAppEventSetting(input);
  const result = await query<SettingRow>(
    `UPDATE whatsapp_booking_notification_settings
        SET enabled = $2, template_name = $3, template_language = $4,
            updated_by_account_id = $5, updated_by_email = $6, updated_at = CURRENT_TIMESTAMP
      WHERE event_type = $1
      RETURNING event_type, enabled, template_name, template_language, updated_at, updated_by_email`,
    [input.eventType, valid.enabled, valid.templateName, valid.templateLanguage, input.actorId, input.actorEmail]
  );
  const row = result.rows[0];
  if (!row) throw new Error("WhatsApp booking notification settings have not been initialized.");
  return mapSetting(row);
}

export async function loadSendableWhatsAppSettings(client?: PoolClient): Promise<Map<WhatsAppBookingEventType, SendableWhatsAppEventSetting>> {
  if (!(await getWhatsAppMessagingSwitch(client)).enabled) return new Map();
  const settings = await listWhatsAppBookingNotificationSettings(client);
  return new Map(settings.filter(isWhatsAppEventSendable).map((setting) => [setting.eventType, setting]));
}

type BookingNotificationRow = {
  reference: string;
  service_date: string;
  service_time: string | null;
  pickup: string;
  dropoff: string;
  passenger_name: string | null;
  passenger_phone: string | null;
  passenger_whatsapp_opt_in: boolean;
};

// Lifecycle notifications only go to the lead passenger; the outbox unique key on event_key (the status) prevents repeats.
export async function enqueueWhatsAppBookingLifecycleNotification(client: PoolClient, input: {
  bookingId: string;
  eventType: "booking_received" | "availability_review" | "booking_accepted";
  eventKey: string;
}): Promise<boolean> {
  const settings = await loadSendableWhatsAppSettings(client);
  if (!settings.has(input.eventType)) return false;
  const result = await client.query<BookingNotificationRow>(
    `SELECT reference, service_date, service_time, pickup, dropoff,
            passenger_name, passenger_phone, passenger_whatsapp_opt_in
       FROM customer_bookings WHERE id = $1`,
    [input.bookingId]
  );
  const booking = result.rows[0];
  if (!booking || !booking.passenger_whatsapp_opt_in || !booking.passenger_phone?.trim()) return false;
  const payload = {
    reference: booking.reference,
    serviceDateTime: `${booking.service_date}${booking.service_time ? ` ${booking.service_time}` : ""}`,
    pickup: booking.pickup,
    dropoff: booking.dropoff
  };
  const inserted = await client.query(
    `INSERT INTO booking_delivery_outbox (
       id, booking_id, event_type, event_key, recipient_type, channel, recipient_name, recipient_contact, payload, available_at
     ) VALUES ($1,$2,$3,$4,'lead_passenger','whatsapp',$5,$6,$7::jsonb,CURRENT_TIMESTAMP)
     ON CONFLICT (booking_id, event_type, event_key, recipient_type, channel, recipient_contact) DO NOTHING`,
    [randomUUID(), input.bookingId, input.eventType, input.eventKey,
      (booking.passenger_name || "Lead passenger").slice(0, 200), booking.passenger_phone.trim().slice(0, 254),
      JSON.stringify(payload)]
  );
  return (inserted.rowCount ?? 0) > 0;
}
