import assert from "node:assert/strict";
import test from "node:test";
import {
  isWhatsAppEventSendable,
  validateWhatsAppEventSetting,
  whatsAppTemplateParams,
  WHATSAPP_BOOKING_EVENTS
} from "./whatsapp-booking-notifications";

test("enabling a WhatsApp notification requires an approved template name", () => {
  assert.throws(
    () => validateWhatsAppEventSetting({ eventType: "booking_accepted", enabled: true, templateName: " ", templateLanguage: "en_GB" }),
    /template name/
  );
});

test("template names and languages are restricted to Meta-compatible formats", () => {
  assert.throws(
    () => validateWhatsAppEventSetting({ eventType: "booking_accepted", enabled: false, templateName: "Booking Accepted", templateLanguage: "en_GB" }),
    /lowercase/
  );
  assert.throws(
    () => validateWhatsAppEventSetting({ eventType: "booking_accepted", enabled: false, templateName: "", templateLanguage: "english" }),
    /language/
  );
});

test("unknown events cannot be configured", () => {
  assert.throws(
    () => validateWhatsAppEventSetting({ eventType: "not_a_booking_event", enabled: false, templateName: "", templateLanguage: "en_GB" }),
    /Unknown/
  );
});

test("only enabled settings with a template are sendable", () => {
  const base = { eventType: "booking_received" as const, templateLanguage: "en_GB", updatedAt: null, updatedByEmail: null };
  assert.equal(isWhatsAppEventSendable({ ...base, enabled: false, templateName: "booking_received" }), false);
  assert.equal(isWhatsAppEventSendable({ ...base, enabled: true, templateName: null }), false);
  assert.equal(isWhatsAppEventSendable(undefined), false);
  assert.equal(isWhatsAppEventSendable({ ...base, enabled: true, templateName: "booking_received" }), true);
});

test("template parameters follow the documented order for each event", () => {
  const values = {
    reference: "RM-1",
    serviceDateTime: "2030-01-02 09:00",
    pickup: "A",
    dropoff: "B",
    status: "En route",
    paymentUrl: "https://checkout.stripe.com/pay/example",
    amount: "42.00",
    currency: "GBP",
    driverName: "Alex Driver",
    vehicleRegistration: "AB12 CDE"
  };
  assert.deepEqual(whatsAppTemplateParams("booking_received", values), ["RM-1", "2030-01-02 09:00", "A", "B"]);
  assert.deepEqual(whatsAppTemplateParams("payment_link", values), [
    "RM-1", "https://checkout.stripe.com/pay/example", "42.00", "GBP"
  ]);
  assert.deepEqual(whatsAppTemplateParams("driver_assignment", values), [
    "RM-1", "2030-01-02 09:00", "Alex Driver", "AB12 CDE"
  ]);
  assert.deepEqual(whatsAppTemplateParams("booking_accepted", values), ["RM-1", "2030-01-02 09:00", "A", "B"]);
  assert.deepEqual(whatsAppTemplateParams("driver_reminder_24h", values), ["RM-1", "2030-01-02 09:00", "A"]);
  assert.deepEqual(whatsAppTemplateParams("live_status", values), ["RM-1", "En route"]);
});

test("registry includes manually resendable WhatsApp notifications with defined recipients", () => {
  const types = WHATSAPP_BOOKING_EVENTS.map((event) => event.type);
  assert.ok(types.includes("booking_received"));
  assert.ok(types.includes("payment_link"));
  assert.ok(types.includes("driver_assignment"));
  assert.ok(types.includes("availability_review"));
  assert.ok(types.includes("booking_accepted"));
  assert.equal(types.includes("payment_cancelled" as never), false);
});
