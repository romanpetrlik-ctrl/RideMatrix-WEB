import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedConfiguration = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

export function integrationConfigEncryptionKey(value = process.env.STRIPE_CONFIG_ENCRYPTION_KEY): Buffer {
  const key = Buffer.from(String(value ?? "").trim(), "base64");
  if (key.length !== 32) {
    throw new Error("Set STRIPE_CONFIG_ENCRYPTION_KEY to a base64-encoded 32-byte key before saving integration credentials.");
  }
  return key;
}

export function encryptIntegrationConfig(value: string, key: Buffer): EncryptedConfiguration {
  if (key.length !== 32) throw new TypeError("Integration configuration encryption key must be 32 bytes.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

export function decryptIntegrationConfig(value: EncryptedConfiguration, key: Buffer): string {
  if (key.length !== 32) throw new TypeError("Integration configuration encryption key must be 32 bytes.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}
