import { query } from "../database/connection";

export const EMAIL_TEMPLATE_EVENTS = ["payment_link", "payment_paid", "payment_cancelled"] as const;
export type EmailTemplateEvent = (typeof EMAIL_TEMPLATE_EVENTS)[number];
export type EmailTemplate = {
  eventType: EmailTemplateEvent;
  subjectTemplate: string;
  bodyTemplate: string;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

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
  updatedAt: string;
  updatedByEmail: string | null;
}> {
  const result = await query<{
    enabled: boolean;
    updated_at: string;
    updated_by_email: string | null;
  }>(`SELECT enabled, updated_at, updated_by_email FROM email_messaging_settings WHERE id = 1`);
  const row = result.rows[0];
  if (!row) throw new Error("Email messaging settings have not been initialized.");
  return { enabled: row.enabled, updatedAt: row.updated_at, updatedByEmail: row.updated_by_email };
}

export async function saveEmailMessagingSettings(input: {
  enabled: boolean;
  actorId: string;
  actorEmail: string;
}): Promise<void> {
  await query(
    `UPDATE email_messaging_settings
        SET enabled = $1, updated_by_account_id = $2, updated_by_email = $3,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`,
    [input.enabled, input.actorId, input.actorEmail]
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
