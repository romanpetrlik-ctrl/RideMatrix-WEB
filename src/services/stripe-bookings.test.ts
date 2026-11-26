import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  isStripeCheckoutPaymentValid,
  verifyStripeWebhookSignature
} from "./stripe-bookings";
import { checkStripeAccountApi } from "./stripe-settings";

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
  assert.equal(verifyStripeWebhookSignature(payload, header, undefined, timestamp), false);
});

test("Stripe paid sessions must match the booking amount in GBP", () => {
  assert.equal(isStripeCheckoutPaymentValid({ amount_total: 12500, currency: "gbp" }, "125.00"), true);
  assert.equal(isStripeCheckoutPaymentValid({ amount_total: 12499, currency: "gbp" }, "125.00"), false);
  assert.equal(isStripeCheckoutPaymentValid({ amount_total: 12500, currency: "usd" }, "125.00"), false);
  assert.equal(isStripeCheckoutPaymentValid({ amount_total: null, currency: "gbp" }, "125.00"), false);
});

test("Stripe account checks report status without exposing the provider response body", async () => {
  await assert.rejects(
    checkStripeAccountApi("sk_test_example", async () => new Response("sensitive provider response", { status: 401 })),
    (error: unknown) => error instanceof Error &&
      error.message.includes("HTTP 401") &&
      !error.message.includes("sensitive")
  );
});
