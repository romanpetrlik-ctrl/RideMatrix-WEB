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
