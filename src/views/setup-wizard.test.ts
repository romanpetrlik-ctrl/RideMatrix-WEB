import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const wizard = fs.readFileSync("src/views/pages/setup/wizard.ejs", "utf8");
const css = fs.readFileSync("public/css/app.css", "utf8");

test("setup wizard fields use scoped single-column layout and separate actions", () => {
  assert.match(wizard, /<main class="container rm-page-shell setup-wizard">/);
  assert.equal((wizard.match(/class="setup-form__field"/g) || []).length, 12);
  assert.equal((wizard.match(/class="setup-form__actions"/g) || []).length, 8);
  assert.match(wizard, /class="setup-form__field setup-form__field--checkbox"/);
  assert.match(wizard, /enctype="multipart\/form-data"/);
  assert.match(css, /\.setup-wizard form \{[\s\S]*display: grid;[\s\S]*gap: 1rem;/);
  assert.match(
    css,
    /\.setup-wizard \.setup-form__field input:not\(\[type="checkbox"\]\):not\(\[type="file"\]\),[\s\S]*max-width: 40rem;/
  );
  assert.match(css, /\.setup-wizard \.setup-form__actions \{[\s\S]*display: flex;/);
});
