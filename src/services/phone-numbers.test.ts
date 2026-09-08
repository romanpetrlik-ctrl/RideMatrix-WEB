import test from "node:test";
import assert from "node:assert/strict";
import {
  getPhoneCountry,
  getPhoneDisplayValue,
  getPhoneTelHref,
  getWhatsAppHref,
  isValidPhoneNumberValue,
  normalizePhoneToE164
} from "./phone-numbers";

test("normalizes supported local and international formats", () => {
  const cases = [
    ["00420724982564", "+420724982564"],
    ["0044207777888999", "+44207777888999"],
    ["00433612345678", "+33612345678"],
    ["07777 888 999", "+447777888999"],
    ["07777888999", "+447777888999"],
    ["0044 7777 888 999", "+447777888999"],
    ["+44 7777 888 999", "+447777888999"],
    ["+420 555 666 777", "+420555666777"],
    ["+33 6 12 34 56 78", "+33612345678"]
  ];

  for (const [value, expected] of cases) {
    assert.equal(normalizePhoneToE164(value), expected);
  }
});

test("rejects empty and invalid numbers", () => {
  assert.equal(isValidPhoneNumberValue(""), false);
  assert.equal(isValidPhoneNumberValue("123"), false);
  assert.equal(normalizePhoneToE164("not a phone"), null);
});

test("resolves country metadata and integration links", () => {
  assert.deepEqual(getPhoneCountry("+420 555 666 777"), {
    isoCode: "CZ",
    countryName: "Czechia",
    callingCode: "+420"
  });
  assert.deepEqual(getPhoneCountry("+447777888999"), {
    isoCode: "GB",
    countryName: "United Kingdom",
    callingCode: "+44"
  });
  assert.equal(getPhoneTelHref("00420724982564"), "tel:+420724982564");
  assert.equal(getWhatsAppHref("00420724982564"), "https://wa.me/420724982564");
  assert.equal(getPhoneTelHref("07777 888 999"), "tel:+447777888999");
  assert.equal(getWhatsAppHref("+420 555 666 777"), "https://wa.me/420555666777");
  assert.equal(getPhoneDisplayValue("+447777888999"), "+44 7777 888999");
});
