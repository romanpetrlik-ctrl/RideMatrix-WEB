import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../database/connection";
import {
  decryptIntegrationConfig,
  encryptIntegrationConfig,
  integrationConfigEncryptionKey
} from "./integration-config-crypto";

export type MicrosoftDispatchCalendarCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  calendarUser: string;
  calendarId: string;
};

export type MicrosoftDispatchCalendarSettings = {
  tenantId: string;
  clientId: string;
  calendarUser: string;
  calendarId: string;
  configured: boolean;
  clientSecretSaved: boolean;
  enabled: boolean;
  tested: boolean;
  encryptionAvailable: boolean;
  source: "database" | "environment" | "none";
  updatedAt: string | null;
  updatedByEmail: string | null;
};

type SettingsRow = {
  enabled: boolean;
  tenant_id: string;
  client_id: string;
  calendar_user: string;
  calendar_id: string;
  encrypted_client_secret: string | null;
  encryption_iv: string | null;
  encryption_auth_tag: string | null;
  verified_fingerprint: string | null;
  updated_at: string | null;
  updated_by_account_id: string | null;
  updated_by_email: string | null;
};

const EMPTY_FIELDS = {
  tenantId: "",
  clientId: "",
  calendarUser: "",
  calendarId: ""
};

function hasSecret(row: SettingsRow): boolean {
  const fields = [row.encrypted_client_secret, row.encryption_iv, row.encryption_auth_tag];
  if (fields.every((field) => field === null)) return false;
  if (fields.some((field) => !field)) throw new Error("Stored Microsoft calendar credentials are incomplete.");
  return true;
}

function encryptionKey(): Buffer {
  return integrationConfigEncryptionKey();
}

function fingerprint(config: MicrosoftDispatchCalendarCredentials): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function validateCredentials(input: MicrosoftDispatchCalendarCredentials): MicrosoftDispatchCalendarCredentials {
  const config = {
    tenantId: input.tenantId.trim(),
    clientId: input.clientId.trim(),
    clientSecret: input.clientSecret.trim(),
    calendarUser: input.calendarUser.trim(),
    calendarId: input.calendarId.trim()
  };
  if (Object.values(config).some((value) => !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new TypeError("Enter all Microsoft calendar credentials and identifiers.");
  }
  if (/\s/.test(config.tenantId) || /\s/.test(config.clientId) || /\s/.test(config.calendarUser)) {
    throw new TypeError("Tenant ID, application ID, and calendar user must not contain spaces.");
  }
  return config;
}

function decryptStoredCredentials(row: SettingsRow): MicrosoftDispatchCalendarCredentials | null {
  if (!hasSecret(row)) return null;
  try {
    const raw = decryptIntegrationConfig({
      ciphertext: row.encrypted_client_secret!,
      iv: row.encryption_iv!,
      authTag: row.encryption_auth_tag!
    }, encryptionKey());
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Stored Microsoft calendar credentials have an invalid shape.");
    }
    const item = parsed as Record<string, unknown>;
    if (typeof item.clientSecret !== "string") {
      throw new TypeError("Stored Microsoft calendar secret has an invalid shape.");
    }
    return validateCredentials({
      tenantId: row.tenant_id,
      clientId: row.client_id,
      clientSecret: item.clientSecret,
      calendarUser: row.calendar_user,
      calendarId: row.calendar_id
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Set STRIPE_CONFIG_ENCRYPTION_KEY")) throw error;
    throw new Error("Microsoft calendar credentials cannot be decrypted. Verify STRIPE_CONFIG_ENCRYPTION_KEY.");
  }
}

async function loadRow(client?: PoolClient, lock = false): Promise<SettingsRow> {
  const result = await query<SettingsRow>(
    `SELECT enabled, tenant_id, client_id, calendar_user, calendar_id,
            encrypted_client_secret, encryption_iv, encryption_auth_tag,
            verified_fingerprint, updated_at, updated_by_account_id, updated_by_email
       FROM microsoft_dispatch_calendar_settings
      WHERE id = 1${lock ? " FOR UPDATE" : ""}`,
    [],
    client
  );
  const row = result.rows[0];
  if (!row) throw new Error("Microsoft dispatch calendar settings have not been initialized.");
  return row;
}

function environmentCredentials(env: NodeJS.ProcessEnv = process.env): MicrosoftDispatchCalendarCredentials | null {
  const values = {
    tenantId: String(env.M365_TENANT_ID ?? "").trim(),
    clientId: String(env.M365_CLIENT_ID ?? "").trim(),
    clientSecret: String(env.M365_CLIENT_SECRET ?? "").trim(),
    calendarUser: String(env.M365_CALENDAR_USER ?? "").trim(),
    calendarId: String(env.M365_CALENDAR_ID ?? "").trim()
  };
  if (Object.values(values).some((value) => !value)) return null;
  try {
    return validateCredentials(values);
  } catch {
    return null;
  }
}

function encryptionIsAvailable(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

export async function getMicrosoftDispatchCalendarSettings(): Promise<MicrosoftDispatchCalendarSettings> {
  const row = await loadRow();
  const secretSaved = hasSecret(row);
  const keyAvailable = encryptionIsAvailable();
  if (secretSaved) {
    const credentials = keyAvailable ? decryptStoredCredentials(row) : null;
    const tested = Boolean(credentials && row.verified_fingerprint === fingerprint(credentials));
    return {
      tenantId: row.tenant_id,
      clientId: row.client_id,
      calendarUser: row.calendar_user,
      calendarId: row.calendar_id,
      configured: Boolean(credentials),
      clientSecretSaved: true,
      enabled: row.enabled,
      tested,
      encryptionAvailable: keyAvailable,
      source: "database",
      updatedAt: row.updated_at,
      updatedByEmail: row.updated_by_email
    };
  }

  const legacy = environmentCredentials();
  const legacyEnabled = Boolean(legacy && !(row.updated_by_account_id && !row.enabled));
  return {
    ...EMPTY_FIELDS,
    ...(legacy ? {
      tenantId: legacy.tenantId,
      clientId: legacy.clientId,
      calendarUser: legacy.calendarUser,
      calendarId: legacy.calendarId
    } : {}),
    configured: Boolean(legacy),
    clientSecretSaved: false,
    enabled: legacyEnabled,
    tested: Boolean(legacy),
    encryptionAvailable: keyAvailable,
    source: legacy ? "environment" : "none",
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email
  };
}

export async function getMicrosoftDispatchCalendarForSync(): Promise<MicrosoftDispatchCalendarCredentials | null> {
  const row = await loadRow();
  if (hasSecret(row)) {
    const credentials = decryptStoredCredentials(row);
    if (!credentials || !row.enabled || row.verified_fingerprint !== fingerprint(credentials)) return null;
    return credentials;
  }
  if (row.updated_by_account_id && !row.enabled) return null;
  return environmentCredentials();
}

export async function saveMicrosoftDispatchCalendarCredentials(input: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  calendarUser: string;
  calendarId: string;
  actorId: string;
  actorEmail: string;
}): Promise<MicrosoftDispatchCalendarSettings> {
  await withTransaction(async (client) => {
    const row = await loadRow(client, true);
    let existingSecret = "";
    if (!input.clientSecret.trim() && hasSecret(row)) {
      const current = decryptStoredCredentials(row);
      existingSecret = current?.clientSecret ?? "";
    }
    const credentials = validateCredentials({
      tenantId: input.tenantId,
      clientId: input.clientId,
      clientSecret: input.clientSecret.trim() || existingSecret,
      calendarUser: input.calendarUser,
      calendarId: input.calendarId
    });
    const encrypted = encryptIntegrationConfig(JSON.stringify({ clientSecret: credentials.clientSecret }), encryptionKey());
    await client.query(
      `UPDATE microsoft_dispatch_calendar_settings
          SET tenant_id = $1, client_id = $2, calendar_user = $3, calendar_id = $4,
              encrypted_client_secret = $5, encryption_iv = $6, encryption_auth_tag = $7,
              enabled = FALSE, verified_fingerprint = NULL,
              updated_by_account_id = $8, updated_by_email = $9, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`,
      [credentials.tenantId, credentials.clientId, credentials.calendarUser, credentials.calendarId,
        encrypted.ciphertext, encrypted.iv, encrypted.authTag, input.actorId, input.actorEmail]
    );
  });
  return getMicrosoftDispatchCalendarSettings();
}

async function requestApplicationToken(
  credentials: MicrosoftDispatchCalendarCredentials,
  fetcher: typeof fetch
): Promise<{ accessToken: string; expiresIn: number }> {
  let response: Response;
  try {
    response = await fetcher(
      `https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: "client_credentials",
          scope: "https://graph.microsoft.com/.default"
        }),
        signal: AbortSignal.timeout(15_000)
      }
    );
  } catch {
    throw new Error("Microsoft connection test could not reach the identity service.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Microsoft rejected the calendar application credentials (HTTP ${response.status}).`);
  }
  let payload: { access_token?: unknown; expires_in?: unknown };
  try {
    payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
  } catch {
    throw new Error("Microsoft returned an invalid application-token response.");
  }
  if (typeof payload.access_token !== "string" || !payload.access_token ||
      typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in)) {
    throw new Error("Microsoft returned an invalid application-token response.");
  }
  return { accessToken: payload.access_token, expiresIn: payload.expires_in };
}

export async function checkMicrosoftDispatchCalendarAccess(
  input: MicrosoftDispatchCalendarCredentials,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const credentials = validateCredentials(input);
  const token = await requestApplicationToken(credentials, fetcher);
  let response: Response;
  try {
    response = await fetcher(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(credentials.calendarUser)}/calendars/${encodeURIComponent(credentials.calendarId)}?$select=id,name`,
      { headers: { authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(15_000) }
    );
  } catch {
    throw new Error("Microsoft calendar access test could not reach Microsoft Graph.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Microsoft Graph could not access the configured calendar (HTTP ${response.status}).`);
  }
  await response.body?.cancel();
}

export async function getMicrosoftDispatchCalendarAccessToken(
  credentials: MicrosoftDispatchCalendarCredentials
): Promise<string> {
  const key = fingerprint(credentials);
  if (applicationToken?.key === key && applicationToken.expiresAt > Date.now() + 60_000) {
    return applicationToken.value;
  }
  const token = await requestApplicationToken(credentials, fetch);
  applicationToken = {
    key,
    value: token.accessToken,
    expiresAt: Date.now() + token.expiresIn * 1000
  };
  return token.accessToken;
}

let applicationToken: { key: string; value: string; expiresAt: number } | null = null;

export async function testMicrosoftDispatchCalendarConnection(input: {
  actorId: string;
  actorEmail: string;
}, fetcher: typeof fetch = fetch): Promise<void> {
  const original = await loadRow();
  const credentials = decryptStoredCredentials(original);
  if (!credentials) throw new TypeError("Save Microsoft dispatch calendar credentials before testing the connection.");
  await checkMicrosoftDispatchCalendarAccess(credentials, fetcher);

  const expectedFingerprint = fingerprint(credentials);
  await withTransaction(async (client) => {
    const current = await loadRow(client, true);
    const currentCredentials = decryptStoredCredentials(current);
    if (!currentCredentials || fingerprint(currentCredentials) !== expectedFingerprint) {
      throw new TypeError("Microsoft calendar credentials changed during the connection test. Test the current configuration again.");
    }
    await client.query(
      `UPDATE microsoft_dispatch_calendar_settings
          SET verified_fingerprint = $1, updated_by_account_id = $2,
              updated_by_email = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`,
      [expectedFingerprint, input.actorId, input.actorEmail]
    );
  });
}

export async function setMicrosoftDispatchCalendarEnabled(input: {
  enabled: boolean;
  actorId: string;
  actorEmail: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const row = await loadRow(client, true);
    if (input.enabled) {
      const credentials = decryptStoredCredentials(row);
      if (!credentials || row.verified_fingerprint !== fingerprint(credentials)) {
        throw new TypeError("Save and successfully test the Microsoft dispatch calendar before enabling synchronization.");
      }
    }
    await client.query(
      `UPDATE microsoft_dispatch_calendar_settings
          SET enabled = $1, updated_by_account_id = $2,
              updated_by_email = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`,
      [input.enabled, input.actorId, input.actorEmail]
    );
  });
}
