import { createHmac, timingSafeEqual } from "node:crypto";
import { query, withTransaction } from "../database/connection";
import { enqueueDelivery } from "./booking-delivery";

type StripeCheckoutSession = {
  id: string;
  url: string | null;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  status: "open" | "complete" | "expired";
  metadata?: Record<string, string>;
};

function stripeKey(): string {
  const key = String(process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
  return key;
}

async function stripeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${stripeKey()}`,
      ...(init?.headers ?? {})
    },
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Stripe API returned ${response.status}: ${body.slice(0, 1000)}`);
  return JSON.parse(body) as T;
}

export async function createBookingCheckoutSession(input: {
  bookingId: string;
  reference: string;
  amount: number;
  payerEmail: string;
  payerName: string;
  deadlineAt: Date | null;
  idempotencyKey: string;
}): Promise<StripeCheckoutSession> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new TypeError("Booking amount must be positive.");
  if (!input.payerEmail.trim()) throw new TypeError("A payer email is required for a Stripe payment link.");
  const baseUrl = String(process.env.APP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl || !/^https:\/\//i.test(baseUrl)) throw new Error("APP_BASE_URL must be an HTTPS URL for payment return links.");
  const amountPence = Math.round(input.amount * 100);
  if (amountPence < 1 || amountPence > 99_999_999) throw new TypeError("Booking total is outside the Stripe-supported GBP range.");
  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "gbp",
    "line_items[0][price_data][product_data][name]": `Taxi booking ${input.reference}`,
    "line_items[0][price_data][unit_amount]": String(amountPence),
    "line_items[0][quantity]": "1",
    customer_email: input.payerEmail.trim(),
    "metadata[booking_id]": input.bookingId,
    "metadata[booking_reference]": input.reference,
    "payment_intent_data[metadata][booking_id]": input.bookingId,
    success_url: `${baseUrl}/payment/return?result=received`,
    cancel_url: `${baseUrl}/payment/return?result=cancelled`
  });
  if (input.deadlineAt && input.deadlineAt.getTime() >= Date.now() + 30 * 60_000) {
    params.set("expires_at", String(Math.floor(input.deadlineAt.getTime() / 1000)));
  }
  return stripeRequest<StripeCheckoutSession>("checkout/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": input.idempotencyKey
    },
    body: params
  });
}

export async function retrieveBookingCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>(`checkout/sessions/${encodeURIComponent(sessionId)}`);
}

export async function expireBookingCheckoutSession(sessionId: string): Promise<void> {
  await stripeRequest<StripeCheckoutSession>(`checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
    method: "POST"
  });
}

export function verifyStripeWebhookSignature(
  payload: Buffer,
  signatureHeader: string | undefined,
  secret = String(process.env.STRIPE_WEBHOOK_SECRET ?? "").trim(),
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!signatureHeader || !secret) return false;
  const pieces = signatureHeader.split(",").map((piece) => piece.split("=", 2));
  const timestamp = pieces.find(([key]) => key === "t")?.[1];
  const signatures = pieces.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 300 || !signatures.length) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(payload).digest();
  return signatures.some((signature) => {
    if (!/^[\da-f]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export async function handleStripeWebhookEvent(event: {
  id: string;
  type: string;
  data?: { object?: { id: string; payment_status?: string; metadata?: Record<string, string> } };
}): Promise<void> {
  if (!event.id || !event.type) throw new TypeError("Stripe webhook event is incomplete.");
  await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO stripe_webhook_events (event_id, event_type)
       VALUES ($1,$2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [event.id, event.type]
    );
    if (!inserted.rowCount) return;
    const session = event.data?.object;
    if (!session) return;
    const bookingId = session.metadata?.booking_id;
    if (!bookingId || !session.id) return;
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      if (session.payment_status !== "paid") return;
      const updated = await client.query<{ id: string }>(
        `UPDATE customer_bookings
            SET payment_status = 'paid', payment_paid_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND stripe_checkout_session_id = $2 AND payment_status <> 'paid'
          RETURNING id`,
        [bookingId, session.id]
      );
      if (updated.rowCount) {
        await client.query(
          `UPDATE booking_delivery_outbox SET delivery_status = 'skipped'
            WHERE booking_id = $1 AND event_type = 'payment_link'
              AND delivery_status IN ('pending', 'failed')`,
          [bookingId]
        );
      }
    } else if (event.type === "checkout.session.expired") {
      await client.query(
        `UPDATE customer_bookings
            SET payment_status = 'failed'
          WHERE id = $1 AND stripe_checkout_session_id = $2 AND payment_status = 'link_sent'`,
        [bookingId, session.id]
      );
    }
  });
}

export async function sendBookingPaymentLink(input: {
  bookingId: string;
  now?: Date;
}): Promise<"sent" | "not-due" | "not-payable"> {
  const result = await query<{
    reference: string;
    status: string;
    archived_at: string | null;
    payment_method: string | null;
    payment_status: string;
    payment_due_at: string | null;
    payment_deadline_at: string | null;
    total_fare_amount: string | number | null;
    payer_name: string | null;
    payer_email: string | null;
    payer_phone: string | null;
    stripe_checkout_session_id: string | null;
    stripe_checkout_url: string | null;
  }>(
    `SELECT reference, status, archived_at, payment_method, payment_status,
            payment_due_at, payment_deadline_at, total_fare_amount,
            payer_name, payer_email, payer_phone, stripe_checkout_session_id, stripe_checkout_url
       FROM customer_bookings WHERE id = $1`,
    [input.bookingId]
  );
  const booking = result.rows[0];
  if (!booking || booking.archived_at || booking.status !== "Driver assigned" ||
      booking.payment_method !== "payment-link" || booking.payment_status === "paid" ||
      booking.payment_status === "expired") return "not-payable";
  const now = input.now ?? new Date();
  if (!booking.payment_due_at || new Date(booking.payment_due_at).getTime() > now.getTime()) return "not-due";
  const amount = Number(booking.total_fare_amount);
  if (!booking.payer_email || !booking.payer_name || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Booking ${input.bookingId} has incomplete payer details or total fare; Stripe checkout cannot be created.`);
  }
  let sessionId = booking.stripe_checkout_session_id;
  let paymentUrl = booking.stripe_checkout_url;
  if (!sessionId || !paymentUrl) {
    const session = await createBookingCheckoutSession({
      bookingId: input.bookingId,
      reference: booking.reference,
      amount,
      payerEmail: booking.payer_email,
      payerName: booking.payer_name,
      deadlineAt: booking.payment_deadline_at ? new Date(booking.payment_deadline_at) : null,
      idempotencyKey: `booking-checkout-${input.bookingId}-${new Date(booking.payment_due_at).getTime()}`
    });
    if (!session.url) throw new Error(`Stripe returned no checkout URL for booking ${input.bookingId}.`);
    sessionId = session.id;
    paymentUrl = session.url;
    const updated = await query(
      `UPDATE customer_bookings
          SET stripe_checkout_session_id = $2, stripe_checkout_url = $3,
              payment_status = 'link_sent', payment_link_sent_at = COALESCE(payment_link_sent_at, $4)
        WHERE id = $1 AND status = 'Driver assigned' AND archived_at IS NULL
          AND payment_status <> 'paid'`,
      [input.bookingId, sessionId, paymentUrl, now.toISOString()]
    );
    if (!updated.rowCount) return "not-payable";
  }
  const payload = {
    reference: booking.reference,
    paymentUrl,
    amount: amount.toFixed(2),
    currency: "GBP"
  };
  await enqueueDelivery({
    bookingId: input.bookingId,
    eventType: "payment_link",
    recipientType: "payer",
    channel: "email",
    recipientName: booking.payer_name,
    recipientContact: booking.payer_email,
    payload
  });
  return "sent";
}
