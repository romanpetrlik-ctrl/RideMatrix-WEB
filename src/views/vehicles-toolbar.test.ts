import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const template = fs.readFileSync("src/views/pages/vehicles/index.ejs", "utf8");
const css = fs.readFileSync("public/css/app.css", "utf8");

test("vehicle search toolbar gives search and status equal responsive space", () => {
  assert.match(css, /\.vehicle-toolbar\s*\{[^}]*grid-template-columns:\s*auto minmax\(15rem,1fr\) auto minmax\(15rem,1fr\) auto;/);
  assert.match(css, /\.vehicle-toolbar input\[name="q"\],\s*\.vehicle-toolbar select\[name="status"\]\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*none;/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)\s*\{[^}]*\.vehicle-toolbar\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,1fr\);[^}]*\}[^}]*\.vehicle-toolbar button\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*width:\s*100%;/);
});

test("vehicle search and status filters remain in one GET form with a submit button", () => {
  assert.match(template, /<form class="vehicle-toolbar" method="get" action="\/vehicles">/);
  assert.match(template, /<input id="vehicle-search" name="q"/);
  assert.match(template, /<select id="vehicle-status" name="status">/);
  assert.match(template, /<button class="button button--secondary" type="submit">Search<\/button><\/form>/);
});
