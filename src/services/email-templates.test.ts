import assert from "node:assert/strict";
import test from "node:test";
import {
  EMAIL_TEMPLATE_EVENTS,
  getEmailDeliveryConfig,
  isEmailDeliveryConfigured,
  renderEmailTemplate,
  validateEmailTemplate
} from "./email-templates";
import {
  decryptIntegrationConfig,
  encryptIntegrationConfig,
  integrationConfigEncryptionKey
} from "./integration-config-crypto";

test("email delivery configuration validates SES credentials and allows unauthenticated Mailpit SMTP", () => {
  assert.equal(isEmailDeliveryConfigured("ses", {
    SES_SMTP_HOST: "email-smtp.example",
    SES_SMTP_USERNAME: "user",
    SES_SMTP_PASSWORD: "password",
    SES_FROM_EMAIL: "sender@example.test"
  }), true);
  assert.equal(isEmailDeliveryConfigured("ses", {}), false);
  assert.equal(isEmailDeliveryConfigured("mailpit", { MAILPIT_SMTP_HOST: "mailpit" }), true);
  assert.equal(isEmailDeliveryConfigured("mailpit", { MAILPIT_SMTP_HOST: "smtp.example.com" }), false);
  assert.equal(isEmailDeliveryConfigured("mailpit", { MAILPIT_SMTP_HOST: "mailpit", MAILPIT_SMTP_PORT: "0" }), false);
  assert.equal(isEmailDeliveryConfigured("mailpit", {}), false);
  assert.deepEqual(getEmailDeliveryConfig("mailpit", { MAILPIT_SMTP_HOST: "mailpit" }), {
    host: "mailpit",
    port: 1025,
    secure: false,
    from: "ridematrix@localhost"
  });
});

test("email templates accept supported variables and render missing values safely", () => {
  const valid = validateEmailTemplate({
    eventType: "payment_link",
    subjectTemplate: "Payment for {{reference}}",
    bodyTemplate: "Hello {{payerName}}: {{paymentUrl}}"
  });
  assert.equal(valid.eventType, "payment_link");
  assert.equal(
    renderEmailTemplate(valid.bodyTemplate, { payerName: "Rider", paymentUrl: "https://pay.example" }),
    "Hello Rider: https://pay.example"
  );
  assert.equal(renderEmailTemplate("Hello {{payerName}}", {}), "Hello ");
});

test("email templates reject unsupported events, variables, and malformed placeholders", () => {
  assert.throws(() => validateEmailTemplate({
    eventType: "unknown",
    subjectTemplate: "Subject",
    bodyTemplate: "Body"
  }), /Unknown email template event/);
  assert.throws(() => validateEmailTemplate({
    eventType: "payment_link",
    subjectTemplate: "Subject",
    bodyTemplate: "{{accountSecret}}"
  }), /Unknown email template variable/);
  assert.throws(() => validateEmailTemplate({
    eventType: "payment_link",
    subjectTemplate: "Subject",
    bodyTemplate: "{{invalid"
  }), /supported template variables/);
});

test("manual booking email templates accept confirmation and driver assignment variables", () => {
  assert.ok(EMAIL_TEMPLATE_EVENTS.includes("booking_received"));
  assert.ok(EMAIL_TEMPLATE_EVENTS.includes("driver_assignment"));
  assert.equal(validateEmailTemplate({
    eventType: "booking_received",
    subjectTemplate: "Booking received: {{reference}}",
    bodyTemplate: "{{passengerName}} · {{serviceDateTime}} · {{bookingStatus}} · {{pickup}} · {{dropoff}}"
  }).eventType, "booking_received");
  assert.equal(validateEmailTemplate({
    eventType: "driver_assignment",
    subjectTemplate: "Driver for {{reference}}",
    bodyTemplate: "{{driverName}} · {{vehicleRegistration}}"
  }).eventType, "driver_assignment");
});

test("integration configuration encryption protects saved email credentials", () => {
  const key = Buffer.alloc(32, 7);
  const secret = "smtp-password-that-must-not-be-plaintext";
  const encrypted = encryptIntegrationConfig(secret, key);
  assert.equal(decryptIntegrationConfig(encrypted, key), secret);
  assert.equal(JSON.stringify(encrypted).includes(secret), false);
  assert.equal(integrationConfigEncryptionKey(key.toString("base64")).length, 32);
  assert.throws(() => integrationConfigEncryptionKey("invalid"));
});
