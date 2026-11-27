import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../database/connection";
import { isIP } from "node:net";
import {
  decryptIntegrationConfig,
  encryptIntegrationConfig,
  integrationConfigEncryptionKey,
  type EncryptedConfiguration
} from "./integration-config-crypto";

export const EMAIL_TEMPLATE_EVENTS = [
  "booking_received",
  "payment_link",
  "payment_paid",
  "payment_cancelled",
  "driver_assignment"
] as const;
export type EmailTemplateEvent = (typeof EMAIL_TEMPLATE_EVENTS)[number];
export type EmailDeliveryMode = "ses" | "mailpit";
export type EmailDeliveryConfig = {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  auth?: { user: string; pass: string };
};
export type EmailDeliveryConfigInput = {
  host?: string;
  port?: string;
  username?: string;
  password?: string;
  from?: string;
};
type StoredEmailDeliveryConfigs = Partial<Record<EmailDeliveryMode, EmailDeliveryConfig>>;
type EmailSettingsRow = {
  enabled: boolean;
  delivery_mode: EmailDeliveryMode;
  updated_at: string;
  updated_by_email: string | null;
  encrypted_delivery_config: string | null;
  delivery_config_iv: string | null;
  delivery_config_auth_tag: string | null;
  verified_delivery_mode: EmailDeliveryMode | null;
};
type EmailDeliveryConfigSummary = {
  configured: boolean;
  host: string;
  port: number;
  from: string;
};
export type EmailTemplate = {
  eventType: EmailTemplateEvent;
  subjectTemplate: string;
  bodyTemplate: string;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

export function getEmailDeliveryConfig(
  mode: EmailDeliveryMode,
  env: NodeJS.ProcessEnv = process.env
): EmailDeliveryConfig | null {
  const portName = mode === "mailpit" ? "MAILPIT_SMTP_PORT" : "SES_SMTP_PORT";
  const hostName = mode === "mailpit" ? "MAILPIT_SMTP_HOST" : "SES_SMTP_HOST";
  const host = String(env[hostName] ?? "").trim();
  const port = Number(env[portName] || (mode === "mailpit" ? 1025 : 587));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  if (mode === "mailpit") {
    const config = {
      host,
      port,
      secure: false,
      from: String(env.MAILPIT_FROM_EMAIL ?? "").trim() || "ridematrix@localhost"
    };
    return isInternalMailpitHost(host) ? config : null;
  }

  const username = String(env.SES_SMTP_USERNAME ?? "").trim();
  const password = String(env.SES_SMTP_PASSWORD ?? "");
  const from = String(env.SES_FROM_EMAIL ?? "").trim();
  if (!username || !password || !from) return null;
  return {
    host,
    port,
    secure: port === 465,
    from,
    auth: { user: username, pass: password }
  };
}

export function isEmailDeliveryConfigured(
  mode: EmailDeliveryMode,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return getEmailDeliveryConfig(mode, env) !== null;
}

function isValidEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

function isReadyEmailDeliveryConfig(mode: EmailDeliveryMode, config: EmailDeliveryConfig | null): config is EmailDeliveryConfig {
  return Boolean(config && config.host && config.port >= 1 && config.port <= 65535 &&
    isValidEmailAddress(config.from) &&
    (mode !== "mailpit" || isInternalMailpitHost(config.host)) &&
    (mode === "mailpit" || (config.auth?.user && config.auth.pass)));
}

function isInternalMailpitHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127 || octets[0] === 192 && octets[1] === 168 ||
      octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 169 && octets[1] === 254;
  }
  if (ipVersion === 6) {
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized);
  }
  return normalized === "localhost" || !normalized.includes(".") ||
    normalized.endsWith(".local") || normalized.endsWith(".internal");
}

function readStoredEmailDeliveryConfigs(row: EmailSettingsRow): StoredEmailDeliveryConfigs {
  const { encrypted_delivery_config: ciphertext, delivery_config_iv: iv, delivery_config_auth_tag: authTag } = row;
  if (!ciphertext && !iv && !authTag) return {};
  if (!ciphertext || !iv || !authTag) throw new Error("Stored email delivery configuration is incomplete.");
  try {
    const parsed: unknown = JSON.parse(decryptIntegrationConfig({ ciphertext, iv, authTag }, integrationConfigEncryptionKey()));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Stored email delivery configuration has an invalid shape.");
    }
    const configs: StoredEmailDeliveryConfigs = {};
    for (const mode of ["ses", "mailpit"] as const) {
      const candidate = (parsed as Record<string, unknown>)[mode];
      if (candidate === undefined || candidate === null) continue;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("Stored email delivery configuration has an invalid shape.");
      }
      const item = candidate as Record<string, unknown>;
      if (typeof item.host !== "string" || typeof item.port !== "number" ||
          typeof item.secure !== "boolean" || typeof item.from !== "string") {
        throw new TypeError("Stored email delivery configuration has an invalid shape.");
      }
      let auth: EmailDeliveryConfig["auth"];
      if (item.auth !== undefined) {
        if (!item.auth || typeof item.auth !== "object" || Array.isArray(item.auth)) {
          throw new TypeError("Stored email delivery credentials have an invalid shape.");
        }
        const credentials = item.auth as Record<string, unknown>;
        if (typeof credentials.user !== "string" || typeof credentials.pass !== "string") {
          throw new TypeError("Stored email delivery credentials have an invalid shape.");
        }
        auth = { user: credentials.user, pass: credentials.pass };
      }
      configs[mode] = {
        host: item.host,
        port: item.port,
        secure: item.secure,
        from: item.from,
        ...(auth ? { auth } : {})
      };
    }
    return configs;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Set STRIPE_CONFIG_ENCRYPTION_KEY")) throw error;
    throw new Error("Email delivery configuration cannot be decrypted. Verify STRIPE_CONFIG_ENCRYPTION_KEY.");
  }
}

function getDeliveryConfigSummary(mode: EmailDeliveryMode, config: EmailDeliveryConfig | null): EmailDeliveryConfigSummary {
  return {
    configured: isReadyEmailDeliveryConfig(mode, config),
    host: config?.host ?? "",
    port: config?.port ?? (mode === "mailpit" ? 1025 : 587),
    from: config?.from ?? (mode === "mailpit" ? "ridematrix@localhost" : "")
  };
}

async function loadEmailSettingsRow(client?: PoolClient, lock = false): Promise<EmailSettingsRow> {
  const result = await query<EmailSettingsRow>(
    `SELECT enabled, delivery_mode, updated_at, updated_by_email,
            encrypted_delivery_config, delivery_config_iv, delivery_config_auth_tag,
            verified_delivery_mode
       FROM email_messaging_settings WHERE id = 1${lock ? " FOR UPDATE" : ""}`,
    [],
    client
  );
  const row = result.rows[0];
  if (!row) throw new Error("Email messaging settings have not been initialized.");
  return row;
}

export async function getStoredEmailDeliveryConfig(mode: EmailDeliveryMode): Promise<EmailDeliveryConfig | null> {
  const row = await loadEmailSettingsRow();
  const stored = readStoredEmailDeliveryConfigs(row)[mode];
  const config = stored ?? getEmailDeliveryConfig(mode);
  return isReadyEmailDeliveryConfig(mode, config) ? config : null;
}

export const EMAIL_TEMPLATE_VARIABLES = {
  passengerName: "Passenger name",
  bookingStatus: "Booking status",
  serviceDateTime: "Service date and time",
  pickup: "Pickup",
  dropoff: "Destination",
  payerName: "Payer name",
  reference: "Booking reference",
  paymentUrl: "Payment URL",
  amount: "Amount",
  currency: "Currency",
  driverName: "Assigned driver",
  vehicleRegistration: "Vehicle registration"
} as const;

const DEFAULT_EMAIL_TEMPLATES: Record<EmailTemplateEvent, Pick<EmailTemplate, "subjectTemplate" | "bodyTemplate">> = {
  booking_received: {
    subjectTemplate: "Booking received: {{reference}}",
    bodyTemplate: "Hello {{passengerName}},\n\nWe have received your booking {{reference}}.\n\nService: {{serviceDateTime}}\nPickup: {{pickup}}\nDestination: {{dropoff}}\nStatus: {{bookingStatus}}\n\nWe will contact you with any updates."
  },
  payment_link: {
    subjectTemplate: "Payment link for booking {{reference}}",
    bodyTemplate: "Hello {{payerName}},\n\nPayment of {{currency}} {{amount}} is due for booking {{reference}}.\n\nPay securely: {{paymentUrl}}\n\nThank you."
  },
  payment_paid: {
    subjectTemplate: "Payment received for booking {{reference}}",
    bodyTemplate: "Hello {{payerName}},\n\nWe have received {{currency}} {{amount}} for booking {{reference}}.\n\nThank you."
  },
  payment_cancelled: {
    subjectTemplate: "Booking {{reference}} cancelled",
    bodyTemplate: "Hello {{payerName}},\n\nBooking {{reference}} has been cancelled because payment was not received before the payment deadline. Please contact the booking team if you need help."
  },
  driver_assignment: {
    subjectTemplate: "Driver assigned to booking {{reference}}",
    bodyTemplate: "Hello {{passengerName}},\n\nA driver has been assigned to booking {{reference}}.\n\nService: {{serviceDateTime}}\nDriver: {{driverName}}\nVehicle: {{vehicleRegistration}}\nPickup: {{pickup}}\nDestination: {{dropoff}}\n\nPlease contact the booking team if you need help."
  }
};

type TemplateRow = {
  event_type: EmailTemplateEvent;
  subject_template: string;
  body_template: string;
  updated_at: string | null;
  updated_by_email: string | null;
};

export function validateEmailTemplate(input: {
  eventType: string;
  subjectTemplate: string;
  bodyTemplate: string;
}): { eventType: EmailTemplateEvent; subjectTemplate: string; bodyTemplate: string } {
  if (!EMAIL_TEMPLATE_EVENTS.includes(input.eventType as EmailTemplateEvent)) {
    throw new TypeError("Unknown email template event.");
  }
  const subjectTemplate = input.subjectTemplate.trim();
  const bodyTemplate = input.bodyTemplate.trim();
  if (!subjectTemplate || subjectTemplate.length > 180) {
    throw new TypeError("Email subject must be between 1 and 180 characters.");
  }
  if (/[\r\n]/.test(subjectTemplate)) {
    throw new TypeError("Email subject must be a single line.");
  }
  if (!bodyTemplate || bodyTemplate.length > 10_000) {
    throw new TypeError("Email body must be between 1 and 10000 characters.");
  }
  const placeholders = `${subjectTemplate}\n${bodyTemplate}`.match(/{{[^{}]*}}/g) ?? [];
  for (const placeholder of placeholders) {
    const name = placeholder.slice(2, -2);
    if (!Object.hasOwn(EMAIL_TEMPLATE_VARIABLES, name)) {
      throw new TypeError(`Unknown email template variable: ${placeholder}`);
    }
  }
  if (/{{|}}/.test(`${subjectTemplate}\n${bodyTemplate}`.replace(/{{[A-Za-z][A-Za-z0-9]*}}/g, ""))) {
    throw new TypeError("Use supported template variables in the form {{variableName}}.");
  }
  return {
    eventType: input.eventType as EmailTemplateEvent,
    subjectTemplate,
    bodyTemplate
  };
}

export function renderEmailTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/{{([A-Za-z][A-Za-z0-9]*)}}/g, (_match, name: string) => String(values[name] ?? ""));
}

export async function getEmailMessagingSettings(): Promise<{
  enabled: boolean;
  deliveryMode: EmailDeliveryMode;
  sesConfig: EmailDeliveryConfigSummary;
  mailpitConfig: EmailDeliveryConfigSummary;
  deliveryConfigured: boolean;
  verifiedDeliveryMode: EmailDeliveryMode | null;
  deliveryTested: boolean;
  updatedAt: string;
  updatedByEmail: string | null;
}> {
  const row = await loadEmailSettingsRow();
  const stored = readStoredEmailDeliveryConfigs(row);
  const ses = stored.ses ?? getEmailDeliveryConfig("ses");
  const mailpit = stored.mailpit ?? getEmailDeliveryConfig("mailpit");
  const selectedConfig = row.delivery_mode === "ses" ? ses : mailpit;
  return {
    enabled: row.enabled,
    deliveryMode: row.delivery_mode,
    sesConfig: getDeliveryConfigSummary("ses", ses),
    mailpitConfig: getDeliveryConfigSummary("mailpit", mailpit),
    deliveryConfigured: isReadyEmailDeliveryConfig(row.delivery_mode, selectedConfig),
    verifiedDeliveryMode: row.verified_delivery_mode,
    deliveryTested: row.verified_delivery_mode === row.delivery_mode,
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email
  };
}

export async function saveEmailMessagingSettings(input: {
  enabled: boolean;
  deliveryMode: EmailDeliveryMode;
  sesConfig?: EmailDeliveryConfigInput;
  mailpitConfig?: EmailDeliveryConfigInput;
  actorId: string;
  actorEmail: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const row = await loadEmailSettingsRow(client, true);
    const previous = readStoredEmailDeliveryConfigs(row);
    const previousSes = previous.ses ?? getEmailDeliveryConfig("ses");
    const previousMailpit = previous.mailpit ?? getEmailDeliveryConfig("mailpit");
    const next = {
      ses: mergeEmailDeliveryConfig("ses", previousSes, input.sesConfig),
      mailpit: mergeEmailDeliveryConfig("mailpit", previousMailpit, input.mailpitConfig)
    };
    const credentialsChanged = JSON.stringify(previousSes) !== JSON.stringify(next.ses) ||
      JSON.stringify(previousMailpit) !== JSON.stringify(next.mailpit);
    if (row.enabled && (row.delivery_mode !== input.deliveryMode || credentialsChanged)) {
      throw new TypeError("Switch email messaging off and save before changing delivery mode or SMTP settings.");
    }
    if (input.enabled && !isReadyEmailDeliveryConfig(input.deliveryMode, next[input.deliveryMode])) {
      throw new TypeError("Configure a valid SMTP host, sender address, and credentials before switching email on.");
    }
    if (input.enabled && row.verified_delivery_mode !== input.deliveryMode) {
      throw new TypeError("Test the selected SMTP connection before switching email on.");
    }

    const key = integrationConfigEncryptionKey();
    const encrypted: EncryptedConfiguration = encryptIntegrationConfig(JSON.stringify(next), key);
    await query(
      `UPDATE email_messaging_settings
          SET enabled = $1, delivery_mode = $2, updated_by_account_id = $3,
              updated_by_email = $4, updated_at = CURRENT_TIMESTAMP,
              encrypted_delivery_config = $5, delivery_config_iv = $6,
              delivery_config_auth_tag = $7,
              verified_delivery_mode = CASE WHEN $8 THEN NULL ELSE verified_delivery_mode END
        WHERE id = 1`,
      [input.enabled, input.deliveryMode, input.actorId, input.actorEmail, encrypted.ciphertext,
        encrypted.iv, encrypted.authTag, credentialsChanged],
      client
    );
  });
}

function mergeEmailDeliveryConfig(
  mode: EmailDeliveryMode,
  previous: EmailDeliveryConfig | null,
  input: EmailDeliveryConfigInput | undefined
): EmailDeliveryConfig {
  const hostInput = String(input?.host ?? "").trim();
  const host = hostInput || previous?.host || "";
  const isHostIp = isIP(host.replace(/^\[|\]$/g, "")) > 0;
  if (host && (host.length > 253 || (!isHostIp && /[\s/@:]/.test(host)))) {
    throw new TypeError("SMTP host must be a hostname or IP address without a protocol or port.");
  }
  if (mode === "mailpit" && host && !isInternalMailpitHost(host)) {
    throw new TypeError("Mailpit must use an internal service hostname or private IP address.");
  }
  const portInput = String(input?.port ?? "").trim();
  const port = portInput ? Number(portInput) : previous?.port ?? (mode === "mailpit" ? 1025 : 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("SMTP port must be a number between 1 and 65535.");
  }
  const fromInput = String(input?.from ?? "").trim();
  const from = fromInput || previous?.from || (mode === "mailpit" ? "ridematrix@localhost" : "");
  if (from && !isValidEmailAddress(from)) throw new TypeError("Enter a valid sender email address.");
  if (mode === "mailpit") return { host, port, secure: false, from };
  const username = String(input?.username ?? "").trim() || previous?.auth?.user || "";
  const password = String(input?.password ?? "") || previous?.auth?.pass || "";
  return {
    host,
    port,
    secure: port === 465,
    from,
    ...(username || password ? { auth: { user: username, pass: password } } : {})
  };
}

export async function markEmailDeliveryTested(input: {
  deliveryMode: EmailDeliveryMode;
  configFingerprint: string;
  actorId: string;
  actorEmail: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const row = await loadEmailSettingsRow(client, true);
    const config = readStoredEmailDeliveryConfigs(row)[input.deliveryMode] ?? getEmailDeliveryConfig(input.deliveryMode);
    if (!isReadyEmailDeliveryConfig(input.deliveryMode, config)) {
      throw new TypeError("Configure a valid SMTP connection before testing it.");
    }
    if (getEmailDeliveryConfigFingerprint(config) !== input.configFingerprint) {
      throw new TypeError("SMTP settings changed during the connection test. Run the test again.");
    }
    await query(
      `UPDATE email_messaging_settings
          SET verified_delivery_mode = $1, updated_by_account_id = $2,
              updated_by_email = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`,
      [input.deliveryMode, input.actorId, input.actorEmail],
      client
    );
  });
}

export function getEmailDeliveryConfigFingerprint(config: EmailDeliveryConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export async function listEmailTemplates(): Promise<EmailTemplate[]> {
  const result = await query<TemplateRow>(
    `SELECT event_type, subject_template, body_template, updated_at, updated_by_email
       FROM email_templates ORDER BY event_type`
  );
  const templates = new Map(result.rows.map((row) => [row.event_type, {
    eventType: row.event_type,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email
  } satisfies EmailTemplate]));
  return EMAIL_TEMPLATE_EVENTS.map((eventType) => templates.get(eventType) ?? {
    eventType,
    ...DEFAULT_EMAIL_TEMPLATES[eventType],
    updatedAt: null,
    updatedByEmail: null
  });
}

export async function getEmailTemplate(eventType: string): Promise<EmailTemplate | null> {
  const template = (await listEmailTemplates()).find((item) => item.eventType === eventType);
  return template ?? null;
}

export async function saveEmailTemplate(input: {
  eventType: string;
  subjectTemplate: string;
  bodyTemplate: string;
  actorId: string;
  actorEmail: string;
}): Promise<EmailTemplate> {
  const valid = validateEmailTemplate(input);
  const result = await query<TemplateRow>(
    `INSERT INTO email_templates (
       event_type, subject_template, body_template, updated_by_account_id, updated_by_email
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (event_type) DO UPDATE SET
       subject_template = EXCLUDED.subject_template,
       body_template = EXCLUDED.body_template,
       updated_by_account_id = EXCLUDED.updated_by_account_id,
       updated_by_email = EXCLUDED.updated_by_email,
       updated_at = CURRENT_TIMESTAMP
     RETURNING event_type, subject_template, body_template, updated_at, updated_by_email`,
    [valid.eventType, valid.subjectTemplate, valid.bodyTemplate, input.actorId, input.actorEmail]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Email template save did not return a result.");
  return {
    eventType: row.event_type,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email
  };
}
