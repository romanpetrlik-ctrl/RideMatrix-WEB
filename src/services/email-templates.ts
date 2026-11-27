import { query } from "../database/connection";

export const EMAIL_TEMPLATE_EVENTS = ["payment_link", "payment_paid", "payment_cancelled"] as const;
export type EmailTemplateEvent = (typeof EMAIL_TEMPLATE_EVENTS)[number];
export type EmailDeliveryMode = "ses" | "mailpit";
export type EmailDeliveryConfig = {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  auth?: { user: string; pass: string };
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
    return {
      host,
      port,
      secure: false,
      from: String(env.MAILPIT_FROM_EMAIL ?? "").trim() || "ridematrix@localhost"
    };
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

export const EMAIL_TEMPLATE_VARIABLES = {
  payerName: "Payer name",
  reference: "Booking reference",
  paymentUrl: "Payment URL",
  amount: "Amount",
  currency: "Currency"
} as const;

const DEFAULT_EMAIL_TEMPLATES: Record<EmailTemplateEvent, Pick<EmailTemplate, "subjectTemplate" | "bodyTemplate">> = {
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
  updatedAt: string;
  updatedByEmail: string | null;
}> {
  const result = await query<{
    enabled: boolean;
    delivery_mode: EmailDeliveryMode;
    updated_at: string;
    updated_by_email: string | null;
  }>(`SELECT enabled, delivery_mode, updated_at, updated_by_email FROM email_messaging_settings WHERE id = 1`);
  const row = result.rows[0];
  if (!row) throw new Error("Email messaging settings have not been initialized.");
  return {
    enabled: row.enabled,
    deliveryMode: row.delivery_mode,
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email
  };
}

export async function saveEmailMessagingSettings(input: {
  enabled: boolean;
  deliveryMode: EmailDeliveryMode;
  actorId: string;
  actorEmail: string;
}): Promise<void> {
  await query(
    `UPDATE email_messaging_settings
        SET enabled = $1, delivery_mode = $2, updated_by_account_id = $3,
            updated_by_email = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`,
    [input.enabled, input.deliveryMode, input.actorId, input.actorEmail]
  );
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
