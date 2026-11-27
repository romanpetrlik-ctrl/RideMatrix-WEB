import type { PoolClient } from "pg";
import { query, withTransaction } from "../database/connection";
import {
  decryptIntegrationConfig,
  encryptIntegrationConfig,
  integrationConfigEncryptionKey,
  type EncryptedConfiguration
} from "./integration-config-crypto";

export type StripeMode = "test" | "live";
export type StripeCredentialSet = {
  publishableKey: string;
  secretKey: string;
  webhookSecret: string;
};
export type StripeCredentials = Record<StripeMode, StripeCredentialSet>;
export type StripeSettingsSummary = {
  enabled: boolean;
  mode: StripeMode;
  testConfigured: boolean;
  liveConfigured: boolean;
  encryptionAvailable: boolean;
  publicUrlConfigured: boolean;
  verifiedMode: StripeMode | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

const EMPTY_CREDENTIALS: StripeCredentials = {
  test: { publishableKey: "", secretKey: "", webhookSecret: "" },
  live: { publishableKey: "", secretKey: "", webhookSecret: "" }
};

export function isValidStripeReturnUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

type EncryptedValue = EncryptedConfiguration;
type SettingsRow = {
  enabled: boolean;
  mode: StripeMode;
  encrypted_credentials: string | null;
  encryption_iv: string | null;
  encryption_auth_tag: string | null;
  verified_mode: StripeMode | null;
  updated_at: string | null;
  updated_by_email: string | null;
};

function encryptionKey(value = process.env.STRIPE_CONFIG_ENCRYPTION_KEY): Buffer {
  return integrationConfigEncryptionKey(value);
}

export function encryptStripeCredentials(value: string, key: Buffer): EncryptedValue {
  return encryptIntegrationConfig(value, key);
}

export function decryptStripeCredentials(value: EncryptedValue, key: Buffer): string {
  return decryptIntegrationConfig(value, key);
}

function hasSecret(row: SettingsRow): boolean {
  return Boolean(row.encrypted_credentials && row.encryption_iv && row.encryption_auth_tag);
}

async function loadRow(client?: PoolClient, lock = false): Promise<SettingsRow> {
  const result = await query<SettingsRow>(
    `SELECT enabled, mode, encrypted_credentials, encryption_iv, encryption_auth_tag,
            verified_mode, updated_at, updated_by_email
       FROM stripe_payment_settings WHERE id = 1${lock ? " FOR UPDATE" : ""}`,
    [],
    client
  );
  const row = result.rows[0];
  if (!row) throw new Error("Stripe settings have not been initialized.");
  return row;
}

function decryptRow(row: SettingsRow): StripeCredentials {
  if (!hasSecret(row)) return structuredClone(EMPTY_CREDENTIALS);
  try {
    const plaintext = decryptStripeCredentials({
      ciphertext: row.encrypted_credentials!,
      iv: row.encryption_iv!,
      authTag: row.encryption_auth_tag!
    }, encryptionKey());
    const parsed: unknown = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid encrypted configuration.");
    return parsed as StripeCredentials;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Set STRIPE_CONFIG_ENCRYPTION_KEY")) throw error;
    throw new Error("Stripe credentials cannot be decrypted. Verify STRIPE_CONFIG_ENCRYPTION_KEY.");
  }
}

function modeHasCredentials(credentials: StripeCredentialSet, mode: StripeMode): boolean {
  return Boolean(credentials.publishableKey && credentials.secretKey && credentials.webhookSecret) &&
    credentials.publishableKey.startsWith(mode === "test" ? "pk_test_" : "pk_live_") &&
    credentials.secretKey.startsWith(mode === "test" ? "sk_test_" : "sk_live_") &&
    credentials.webhookSecret.startsWith("whsec_");
}

export async function getStripeSettingsSummary(): Promise<StripeSettingsSummary> {
  const row = await loadRow();
  const encryptionAvailable = (() => {
    try {
      encryptionKey();
      return true;
    } catch {
      return false;
    }
  })();
  const credentials = hasSecret(row) && encryptionAvailable
    ? decryptRow(row)
    : structuredClone(EMPTY_CREDENTIALS);
  return {
    enabled: row.enabled,
    mode: row.mode,
    testConfigured: modeHasCredentials(credentials.test, "test"),
    liveConfigured: modeHasCredentials(credentials.live, "live"),
    encryptionAvailable,
    publicUrlConfigured: isValidStripeReturnUrl(String(process.env.APP_BASE_URL ?? "")),
    verifiedMode: row.verified_mode,
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email
  };
}

export async function getStripeCredentials(options: { allowDisabled?: boolean } = {}): Promise<{
  mode: StripeMode;
  credentials: StripeCredentialSet;
  enabled: boolean;
}> {
  const row = await loadRow();
  if (!row.enabled && !options.allowDisabled) throw new Error("Stripe payments are switched off in Settings.");
  const credentials = decryptRow(row)[row.mode];
  if (!modeHasCredentials(credentials, row.mode)) {
    throw new Error(`Stripe ${row.mode} credentials are incomplete or invalid.`);
  }
  return { mode: row.mode, credentials, enabled: row.enabled };
}

export async function getStripeWebhookSecrets(): Promise<string[]> {
  const row = await loadRow();
  const credentials = decryptRow(row);
  return (["test", "live"] as const)
    .map((mode) => credentials[mode].webhookSecret)
    .filter((secret) => secret.startsWith("whsec_"));
}

export async function saveStripeCredentials(input: {
  mode: StripeMode;
  publishableKey: string;
  secretKey: string;
  webhookSecret: string;
  actorId: string;
  actorEmail: string;
}): Promise<StripeSettingsSummary> {
  if (input.mode !== "test" && input.mode !== "live") throw new TypeError("Select Stripe test or live mode.");
  await withTransaction(async (client) => {
    const row = await loadRow(client, true);
    if (row.enabled) throw new TypeError("Switch Stripe payments off before changing the mode or credentials.");
    const credentials = hasSecret(row) ? decryptRow(row) : structuredClone(EMPTY_CREDENTIALS);
    const set = credentials[input.mode];
    if (input.mode !== row.mode || input.publishableKey.trim() || input.secretKey.trim() || input.webhookSecret.trim()) {
      const pending = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM customer_bookings
            WHERE payment_method = 'payment-link'
              AND stripe_checkout_session_id IS NOT NULL
              AND payment_status IN ('link_sent', 'failed')
         ) AS exists`
      );
      if (pending.rows[0]?.exists) {
        throw new TypeError("Resolve outstanding Stripe payments before changing the Stripe mode or credentials.");
      }
    }
    const next = {
      publishableKey: input.publishableKey.trim() || set.publishableKey,
      secretKey: input.secretKey.trim() || set.secretKey,
      webhookSecret: input.webhookSecret.trim() || set.webhookSecret
    };
    if (next.publishableKey && !next.publishableKey.startsWith(input.mode === "test" ? "pk_test_" : "pk_live_")) {
      throw new TypeError(`The publishable key does not match Stripe ${input.mode} mode.`);
    }
    if (next.secretKey && !next.secretKey.startsWith(input.mode === "test" ? "sk_test_" : "sk_live_")) {
      throw new TypeError(`The secret key does not match Stripe ${input.mode} mode.`);
    }
    if (next.webhookSecret && !next.webhookSecret.startsWith("whsec_")) {
      throw new TypeError("The webhook signing secret must start with whsec_.");
    }
    credentials[input.mode] = next;
    const encrypted = encryptStripeCredentials(JSON.stringify(credentials), encryptionKey());
    await client.query(
      `UPDATE stripe_payment_settings
          SET mode = $1, enabled = FALSE, verified_mode = NULL,
              encrypted_credentials = $2, encryption_iv = $3, encryption_auth_tag = $4,
              updated_by_account_id = $5, updated_by_email = $6, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`,
      [input.mode, encrypted.ciphertext, encrypted.iv, encrypted.authTag, input.actorId, input.actorEmail]
    );
    await client.query(
      `INSERT INTO stripe_payment_settings_history (mode, action, actor_account_id, actor_email)
       VALUES ($1, 'credentials_saved', $2, $3)`,
      [input.mode, input.actorId, input.actorEmail]
    );
  });
  return getStripeSettingsSummary();
}

export async function checkStripeAccountApi(secretKey: string, fetcher: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetcher("https://api.stripe.com/v1/account", {
      headers: { authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error("Stripe connection test failed. Check server network access and try again.");
  }
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`Stripe rejected the configured key (HTTP ${response.status}). Verify the key in Stripe Dashboard.`);
  }
}

export async function testStripeConnection(input: {
  actorId: string;
  actorEmail: string;
}, fetcher: typeof fetch = fetch): Promise<StripeMode> {
  const row = await loadRow();
  const credentials = decryptRow(row)[row.mode];
  if (!modeHasCredentials(credentials, row.mode)) {
    throw new TypeError(`Save complete valid Stripe ${row.mode} credentials before testing the connection.`);
  }
  await checkStripeAccountApi(credentials.secretKey, fetcher);
  await withTransaction(async (client) => {
    const current = await loadRow(client, true);
    if (current.mode !== row.mode || decryptRow(current)[current.mode].secretKey !== credentials.secretKey) {
      throw new TypeError("Stripe credentials changed during the connection test. Test the current configuration again.");
    }
    await client.query(
      `UPDATE stripe_payment_settings
          SET verified_mode = mode, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`
    );
    await client.query(
      `INSERT INTO stripe_payment_settings_history (mode, action, actor_account_id, actor_email)
       VALUES ($1, 'connection_tested', $2, $3)`,
      [row.mode, input.actorId, input.actorEmail]
    );
  });
  return row.mode;
}

export async function setStripePaymentsEnabled(input: {
  enabled: boolean;
  actorId: string;
  actorEmail: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const row = await loadRow(client, true);
    if (input.enabled) {
      const credentials = decryptRow(row)[row.mode];
      if (!modeHasCredentials(credentials, row.mode) || row.verified_mode !== row.mode) {
        throw new TypeError("Save complete credentials and successfully test the connection before enabling Stripe.");
      }
      if (!isValidStripeReturnUrl(String(process.env.APP_BASE_URL ?? ""))) {
        throw new TypeError("Set APP_BASE_URL to the public HTTPS application URL before enabling Stripe.");
      }
    }
    await client.query(
      `UPDATE stripe_payment_settings
          SET enabled = $1, updated_by_account_id = $2, updated_by_email = $3,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`,
      [input.enabled, input.actorId, input.actorEmail]
    );
    await client.query(
      `INSERT INTO stripe_payment_settings_history (mode, action, actor_account_id, actor_email)
       VALUES ($1, $2, $3, $4)`,
      [row.mode, input.enabled ? "enabled" : "disabled", input.actorId, input.actorEmail]
    );
  });
}
