import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("multiple business phone fields work without action buttons and allow an empty optional phone", async () => {
  const submit: Array<(event: any) => void> = [];
  const form = {
    querySelector: () => null,
    addEventListener: (_event: string, handler: (event: any) => void) => submit.push(handler)
  };
  const values = ["020 7946 0018", "07777 888999", ""];
  const inputs = values.map((value, index) => ({
    value,
    required: index < 2,
    validity: "",
    closest: () => form,
    addEventListener() {},
    setCustomValidity(message: string) { this.validity = message; },
    reportValidity() {}
  }));
  const components = inputs.map((input) => {
    const element = { textContent: "", hidden: false, setAttribute() {}, removeAttribute() {} };
    return { querySelector: (selector: string) => selector === "[data-phone-input]" ? input : { ...element } };
  });
  const window: any = { PhoneFlags: { flagForIso: () => "🇬🇧" } };
  const context = vm.createContext({
    window,
    document: { querySelectorAll: () => components },
    setTimeout: (handler: () => void) => { handler(); return 0; },
    clearTimeout() {},
    fetch: async () => ({
      ok: true, json: async () => ({ valid: true, normalized: "+442079460018", country: null })
    })
  });
  vm.runInContext(fs.readFileSync("public/js/phone-preview-state.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("public/js/phone-number.js", "utf8"), context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  let blocked = false;
  submit.forEach((handler) => handler({ preventDefault: () => { blocked = true; } }));
  assert.equal(blocked, false);
  assert.equal(inputs[2].value, "");
  assert.equal(inputs[2].validity, "");
  assert.equal(inputs[0].value, "+442079460018");
});

function createPhoneHarness(options: {
  value: string;
  required?: boolean;
  label?: string;
  preview: (value: string) => any;
  summaryForm?: boolean;
}) {
  const submitHandlers: Array<(event: any) => void> = [];
  const inputHandlers: Record<string, Array<() => void>> = {};
  const timers: Array<() => void> = [];
  const requestSubmits: any[] = [];
  const fetches: string[] = [];
  let reported = 0;
  const form: any = {
    querySelector: () => null,
    hasAttribute: (name: string) => Boolean(options.summaryForm) && name === "data-error-summary-form",
    addEventListener: (_event: string, handler: (event: any) => void) => submitHandlers.push(handler),
    requestSubmit: (submitter?: any) => requestSubmits.push(submitter)
  };
  const attributes: Record<string, string> = { "aria-describedby": "accountsPhone-help" };
  const input: any = {
    value: options.value,
    required: Boolean(options.required),
    validity: "",
    closest: () => form,
    addEventListener: (event: string, handler: () => void) => {
      (inputHandlers[event] ||= []).push(handler);
    },
    setCustomValidity(message: string) { this.validity = message; },
    reportValidity() { reported++; },
    getAttribute: (name: string) => attributes[name] ?? null,
    setAttribute: (name: string, value: string) => { attributes[name] = value; },
    removeAttribute: (name: string) => { delete attributes[name]; }
  };
  const error: any = { id: "accountsPhone-error", textContent: "", hidden: true, setAttribute() {}, removeAttribute() {} };
  const label = { textContent: options.label ?? "Accounts phone number" };
  const component = {
    querySelector: (selector: string) => {
      if (selector === "[data-phone-input]") return input;
      if (selector === "[data-phone-error]") return error;
      if (selector === "label") return label;
      return { textContent: "", hidden: false, setAttribute() {}, removeAttribute() {} };
    }
  };
  const context = vm.createContext({
    window: { PhoneFlags: { flagForIso: () => "🇬🇧" } },
    document: { querySelectorAll: () => [component] },
    setTimeout: (handler: () => void) => { timers.push(handler); return timers.length; },
    clearTimeout() {},
    fetch: async (url: string) => {
      const value = decodeURIComponent(url.split("value=")[1] || "");
      fetches.push(value);
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => options.preview(value)
      };
    }
  });
  vm.runInContext(fs.readFileSync("public/js/phone-preview-state.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("public/js/phone-number.js", "utf8"), context);
  const flush = async () => {
    while (timers.length) timers.shift()!();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const fire = (event: string) => (inputHandlers[event] || []).forEach((handler) => handler());
  const submit = (submitter: any = null) => {
    let blocked = false;
    submitHandlers.forEach((handler) => handler({ submitter, preventDefault: () => { blocked = true; } }));
    return blocked;
  };
  return { input, error, attributes, form, flush, fire, submit, requestSubmits, fetches, reported: () => reported };
}

const ukPreview = (value: string) => {
  const digits = value.replace(/[^\d+]/g, "");
  const normalized = /^\+441202353570$/.test(digits) ? digits : /^01202353570$/.test(digits) ? "+441202353570" : null;
  return normalized
    ? { valid: true, normalized, country: { isoCode: "GB", countryName: "United Kingdom", callingCode: "+44" } }
    : { valid: false, normalized: null, country: null };
};

test("a resolved accounts phone is not discarded when the submit button blurs the field", async () => {
  const phone = createPhoneHarness({ value: "+441202353570", preview: ukPreview, summaryForm: true });
  await phone.flush();
  const fetchesBefore = phone.fetches.length;
  // Clicking the header "Create Customer" button blurs the last edited field before submit.
  phone.fire("blur");
  assert.equal(phone.submit(), false);
  assert.equal(phone.fetches.length, fetchesBefore);
  assert.equal(phone.input.value, "+441202353570");
  assert.equal(phone.input.validity, "");
  assert.equal(phone.error.hidden, true);
});

test("a submit while the phone preview is still pending waits and resubmits instead of rejecting", async () => {
  const phone = createPhoneHarness({ value: "", preview: ukPreview, summaryForm: true });
  await phone.flush();
  phone.input.value = "01202 353570";
  phone.fire("input");
  const submitter = { form: phone.form };
  assert.equal(phone.submit(submitter), true);
  assert.equal(phone.input.validity, "");
  assert.equal(phone.error.hidden, true);
  assert.equal(phone.reported(), 0);
  await phone.flush();
  assert.equal(phone.requestSubmits.length, 1);
  assert.equal(phone.requestSubmits[0], submitter);
  assert.equal(phone.input.value, "+441202353570");
  assert.equal(phone.submit(submitter), false);
});

test("an empty optional accounts phone submits without errors", async () => {
  const phone = createPhoneHarness({ value: "", preview: ukPreview, summaryForm: true });
  await phone.flush();
  phone.fire("blur");
  assert.equal(phone.submit(), false);
  assert.equal(phone.input.validity, "");
  assert.equal(phone.error.hidden, true);
  assert.equal(phone.attributes["aria-invalid"], undefined);
});

test("an invalid accounts phone shows a field-specific inline error and keeps the entered value", async () => {
  const phone = createPhoneHarness({ value: "12345", preview: ukPreview, summaryForm: true });
  await phone.flush();
  phone.fire("blur");
  assert.equal(phone.submit(), true);
  assert.equal(phone.input.value, "12345");
  assert.match(phone.input.validity, /^Accounts phone number must be a valid phone number/);
  assert.equal(phone.error.hidden, false);
  assert.equal(phone.error.textContent, phone.input.validity);
  assert.equal(phone.attributes["aria-invalid"], "true");
  assert.equal(phone.attributes["aria-describedby"], "accountsPhone-help accountsPhone-error");
  // The business form reports through its error summary instead of a validation bubble.
  assert.equal(phone.reported(), 0);

  phone.input.value = "01202 353570";
  phone.fire("input");
  await phone.flush();
  assert.equal(phone.error.hidden, true);
  assert.equal(phone.attributes["aria-invalid"], undefined);
  assert.equal(phone.submit(), false);
});

test("forms without an error summary still use native validity reporting for invalid phones", async () => {
  const phone = createPhoneHarness({ value: "12345", required: true, label: "Phone / WhatsApp *", preview: ukPreview });
  await phone.flush();
  assert.equal(phone.submit(), true);
  assert.equal(phone.reported(), 1);
  assert.match(phone.input.validity, /^Phone \/ WhatsApp must be a valid phone number/);
});
