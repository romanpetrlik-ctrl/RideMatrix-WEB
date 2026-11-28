import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync("public/css/app.css", "utf8");

test("customer, driver and booking cards use the shared square surface", () => {
  assert.match(css, /\.rm-card,\s*\.panel,\s*\.customer-list-card,\s*\.staff-card,\s*\.vehicle-card\s*\{[^}]*border:\s*1px solid var\(--rm-border\);[^}]*border-radius:\s*0;[^}]*background:\s*var\(--rm-surface\);[^}]*box-shadow:\s*var\(--rm-shadow-soft\);/);
  assert.match(css, /\.vehicle-list-page \.vehicle-card\.rm-card\s*\{\s*padding:\s*0;\s*\}/);
  assert.match(css, /\.new-booking-page \.new-booking-block\.rm-card\s*\{\s*padding:\s*1\.25rem;\s*\}/);

  const customers = readFileSync("src/views/pages/customers/index.ejs", "utf8");
  const drivers = readFileSync("src/views/pages/drivers/index.ejs", "utf8");
  const bookings = readFileSync("src/views/pages/bookings/new.ejs", "utf8");
  assert.match(customers, /class="rm-card customer-list-card"/);
  assert.match(drivers, /class="rm-card vehicle-card"/);
  assert.match(bookings, /class="panel rm-card new-booking-block/);
});

test("page templates version the global stylesheet so browsers fetch its updates", () => {
  const head = readFileSync("src/views/partials/head.ejs", "utf8");
  const authorization = readFileSync("src/views/pages/booking-authorization.ejs", "utf8");
  assert.match(head, /href="\/css\/app\.css\?v=20261128-1"/);
  assert.match(authorization, /href="\/css\/app\.css\?v=20261128-1"/);
});
