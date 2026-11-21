import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyStripeWebhookSignature } from "./stripe-bookings";

test("Stripe webhook signature accepts valid payloads and rejects tampering or stale signatures", () => {
  const secret = "whsec_test";
  const timestamp = 1_800_000_000;
  const payload = Buffer.from('{"id":"evt_test","type":"checkout.session.completed"}');
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(payload).digest("hex");
  const header = `t=${timestamp},v1=${digest}`;

  assert.equal(verifyStripeWebhookSignature(payload, header, secret, timestamp), true);
  assert.equal(verifyStripeWebhookSignature(Buffer.from(`${payload.toString()} `), header, secret, timestamp), false);
  assert.equal(verifyStripeWebhookSignature(payload, header, secret, timestamp + 301), false);
  assert.equal(verifyStripeWebhookSignature(payload, header, "", timestamp), false);
  assert.equal(verifyStripeWebhookSignature(payload, "invalid", secret, timestamp), false);
});
