import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Manage VPS keeps the safe recovery placeholder as a button and relies on the global workspace action", () => {
  const template = fs.readFileSync("src/views/pages/role-section.ejs", "utf8");

  assert.match(template, /class="button button--execute-helper" href="\/recovery">Open reboot and recovery placeholder/);
  assert.match(template, /Safety notice:<\/strong> reboot and recovery are placeholders/);
  assert.doesNotMatch(template, /<p><a href="\/choose-role">Switch workspace<\/a><\/p>/);
});

test("System settings navigation uses the shared admin action-button style", () => {
  const template = fs.readFileSync("src/views/pages/role-section.ejs", "utf8");
  const css = fs.readFileSync("public/css/app.css", "utf8");
  const settingsNavigation = template.split('class="system-settings-destinations"')[1]?.split("</nav>")[0] ?? "";

  assert.match(settingsNavigation, /class="button button--admin-cta" href="\/settings\/payments\/stripe">Stripe \(On\/Off\)<\/a>/);
  assert.match(settingsNavigation, /class="button button--admin-cta" href="\/settings\/messaging\/email">Email \(On\/Off\)<\/a>/);
  assert.match(settingsNavigation, /class="button button--admin-cta" href="\/settings\/booking-integrations">Booking Integrations<\/a>/);
  assert.match(css, /\.system-settings-destinations__actions \{[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 15rem\), 1fr\)\);[\s\S]*gap: 1rem;/);
});
