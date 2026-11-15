import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const wizard = fs.readFileSync("src/views/pages/setup/wizard.ejs", "utf8");
const css = fs.readFileSync("public/css/app.css", "utf8");
const autocomplete = fs.readFileSync("public/js/setup-address-autocomplete.js", "utf8");

test("setup wizard fields use scoped single-column layout and separate actions", () => {
  assert.match(wizard, /<main class="container rm-page-shell setup-wizard">/);
  assert.equal((wizard.match(/class="setup-form__field"/g) || []).length, 13);
  assert.equal((wizard.match(/class="setup-form__actions"/g) || []).length, 6);
  assert.match(wizard, /class="setup-form__field setup-form__field--checkbox"/);
  assert.match(wizard, /enctype="multipart\/form-data"/);
  assert.match(wizard, /Search for your operating address in the UK/);
  assert.doesNotMatch(wizard, /Formatted address \*/);
  assert.match(autocomplete, /includedRegionCodes = \["gb"\]/);
  assert.match(wizard, /data-address-autocomplete-browser-key="<%= mapBrowserApiKey %>"/);
  assert.match(wizard, /providerPlaceId/);
  assert.match(wizard, /setup-address-autocomplete\.js/);
  assert.match(css, /\.setup-wizard form \{[\s\S]*display: grid;[\s\S]*gap: 1rem;/);
  assert.match(
    css,
    /\.setup-wizard form \{[\s\S]*width: 100%;[\s\S]*max-width: none;[\s\S]*\}/
  );
  assert.match(
    css,
    /\.setup-wizard \.setup-form__field input:not\(\[type="checkbox"\]\):not\(\[type="file"\]\),[\s\S]*width: 100%;[\s\S]*max-width: none;[\s\S]*box-sizing: border-box;/
  );
  assert.match(css, /\.setup-wizard \.setup-form__actions \{[\s\S]*display: flex;/);
});
