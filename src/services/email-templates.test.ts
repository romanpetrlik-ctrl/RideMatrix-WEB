import assert from "node:assert/strict";
import test from "node:test";
import {
  renderEmailTemplate,
  validateEmailTemplate
} from "./email-templates";

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
