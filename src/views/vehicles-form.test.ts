import assert from "node:assert/strict";
import ejs from "ejs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("vehicle form renders grouped fields and responsive, scoped control styles", async () => {
  const html = await ejs.renderFile(path.join(process.cwd(), "src/views/pages/vehicles/form.ejs"), {
    title: "New vehicle",
    appTitle: "RideMatrix Test",
    vehicle: null,
    errors: [],
    csrfField: '<input type="hidden" name="_csrf" value="test-token">',
    fuelTypes: ["ICE", "HYBRID", "EV"],
    statuses: ["active", "maintenance", "inactive"],
    classes: [{ key: "standard", label: "Standard" }],
    baggageCategories: [
      { key: "xl_suitcase", label: "XL suitcase" },
      { key: "l_suitcase", label: "L suitcase" },
      { key: "cabin_bag", label: "CB cabin bag" },
      { key: "backpack", label: "BP backpack" }
    ],
    helpFor: (key: string) => ({ title: key, body: `Information about ${key}.` })
  });

  for (const heading of ["Basic details", "Vehicle class assignment", "Registered operator", "Accessibility", "Baggage capacity (maximum quantity)", "Notes"]) {
    assert.ok(html.includes(heading), `expected the ${heading} section`);
  }
  for (const name of [
    "registration", "make", "model", "fuelType", "passengerCapacity", "status",
    "classKeys", "year", "colour", "registeredKeeperDetails", "wheelchairAccessible",
    "capacity_xl_suitcase", "capacity_l_suitcase", "capacity_cabin_bag", "capacity_backpack", "notes"
  ]) {
    assert.match(html, new RegExp(`name="${name}"`), `expected the ${name} field`);
  }
  assert.match(html, /name="_csrf" value="test-token"/);
  assert.match(html, /class="help-button" type="button" aria-haspopup="dialog"/);
  assert.match(html, /aria-label="Help: vehicle\.fuelType"/);

  const css = fs.readFileSync(path.join(process.cwd(), "public/css/app.css"), "utf8");
  assert.match(css, /\.vehicle-form input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\),\s*\.vehicle-form select,\s*\.vehicle-form textarea\s*\{[\s\S]*width:100%;[\s\S]*max-width:none;/);
  assert.match(css, /@media \(max-width: 900px\)\s*\{\s*\.vehicle-form \.vehicle-form__fields \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\);/);
  assert.match(css, /@media \(max-width: 560px\)\s*\{\s*\.vehicle-form \.vehicle-form__fields,\s*\.vehicle-form \.vehicle-capacity-grid \{ grid-template-columns:minmax\(0,1fr\);/);
  assert.match(css, /\.vehicle-form \.help-button\s*\{[^}]*min-height:1\.25rem;[^}]*padding:0;/);
});
