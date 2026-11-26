import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptStripeCredentials,
  encryptStripeCredentials
} from "./stripe-settings";

test("Stripe credentials are encrypted with authenticated encryption and decrypt only with the original key", () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptStripeCredentials("sk_test_private", key);
  assert.notEqual(encrypted.ciphertext, Buffer.from("sk_test_private").toString("base64"));
  assert.equal(decryptStripeCredentials(encrypted, key), "sk_test_private");
  assert.throws(() => decryptStripeCredentials(encrypted, Buffer.alloc(32, 8)));
});

test("Stripe credential encryption requires a 32-byte key", () => {
  assert.throws(() => encryptStripeCredentials("secret", Buffer.alloc(31)), /32 bytes/);
});
