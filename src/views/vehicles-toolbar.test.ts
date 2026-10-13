import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const template = fs.readFileSync("src/views/pages/vehicles/index.ejs", "utf8");
const css = fs.readFileSync("public/css/app.css", "utf8");

test("vehicle search toolbar uses desktop grid and responsive breakpoints", () => {
  assert.match(css, /\.vehicle-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(320px,\s*1\.4fr\)\s+260px\s+auto;[^}]*align-items:\s*end;[^}]*gap:\s*16px;/);
  assert.match(css, /\.vehicle-toolbar__field--search\s*\{[^}]*max-width:\s*640px;/);
  assert.match(css, /@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.vehicle-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+260px;/);
  assert.match(css, /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?\.vehicle-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*gap:\s*12px;[\s\S]*?\.vehicle-toolbar button\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*width:\s*100%;/);
});

test("vehicle search and status controls share identical toolbar control styling", () => {
  assert.match(css, /\.vehicle-toolbar__control\s*\{[^}]*height:\s*44px;[^}]*padding:\s*0 12px;[^}]*border:\s*1px solid #d6dee8;[^}]*border-radius:\s*8px;[^}]*background:\s*#fff;[^}]*font-size:\s*16px;[^}]*line-height:\s*1\.4;/);
  assert.match(css, /\.vehicle-toolbar__control::placeholder\s*\{[^}]*color:\s*var\(--rm-text-soft\);/);
  assert.match(css, /\.vehicle-toolbar__control:focus-visible\s*\{[^}]*border-color:\s*var\(--rm-control-focus-color\);[^}]*box-shadow:\s*var\(--rm-control-focus-shadow\);/);
});

test("vehicle search and status filters remain in one GET form with a submit button", () => {
  assert.match(template, /<form class="vehicle-toolbar" method="get" action="\/vehicles">/);
  assert.match(template, /class="vehicle-toolbar__field vehicle-toolbar__field--search"/);
  assert.match(template, /class="vehicle-toolbar__field vehicle-toolbar__field--status"/);
  assert.match(template, /<input class="vehicle-toolbar__control" id="vehicle-search" name="q"/);
  assert.match(template, /<select class="vehicle-toolbar__control" id="vehicle-status" name="status">/);
  assert.match(template, /<button class="button button--secondary" type="submit">Search<\/button>/);
});
