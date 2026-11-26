import express, { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import {
  handleStripeWebhookEvent,
  verifyStripeWebhookSignature
} from "../services/stripe-bookings";
import { getStripeWebhookSecrets } from "../services/stripe-settings";

export function createBookingPaymentsRouter(): Router {
  const router = Router();

  router.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req: Request, res: Response, next: NextFunction) => {
      if (!Buffer.isBuffer(req.body)) return res.status(400).send("Invalid webhook payload.");
      let webhookSecrets: string[];
      try {
        webhookSecrets = await getStripeWebhookSecrets();
      } catch {
        return res.status(400).send("Stripe webhook is not configured.");
      }
      if (!webhookSecrets.some((secret) => verifyStripeWebhookSignature(req.body, req.header("stripe-signature"), secret))) {
        return res.status(400).send("Invalid webhook signature.");
      }
      let event: unknown;
      try {
        event = JSON.parse(req.body.toString("utf8"));
      } catch {
        return res.status(400).send("Invalid webhook JSON.");
      }
      try {
        await handleStripeWebhookEvent(event as {
          id: string;
          type: string;
          data?: { object?: { id: string; payment_status?: string; metadata?: Record<string, string> } };
        });
        return res.status(200).json({ received: true });
      } catch (error) {
        return next(error);
      }
    }
  );

  router.get("/payment/return", (req, res) => {
    const cancelled = req.query.result === "cancelled";
    res.status(200).type("html").send(`<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Payment ${cancelled ? "not completed" : "received"} | RideMatrix</title></head>
      <body><main><h1>${cancelled ? "Payment not completed" : "Payment received"}</h1>
      <p>${cancelled
        ? "Your booking payment was not completed. You can return to the payment link or contact the booking team."
        : "Thank you. Your payment status is being confirmed; the booking team will send an update."}</p>
      </main></body></html>`);
  });

  return router;
}
