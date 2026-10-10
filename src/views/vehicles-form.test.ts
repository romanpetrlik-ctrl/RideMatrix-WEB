import assert from "node:assert/strict";
import ejs from "ejs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

async function renderVehicleForm(vehicle: any = null): Promise<string> {
  return ejs.renderFile(path.join(process.cwd(), "src/views/pages/vehicles/form.ejs"), {
    title: "New vehicle",
    appTitle: "RideMatrix Test",
    vehicle,
    errors: [],
    csrfField: '<input type="hidden" name="_csrf" value="test-token">',
    fuelTypes: ["ICE", "HYBRID", "EV"],
    statuses: ["active", "maintenance", "inactive"],
    classes: [
      { key: "standard", label: "Standard" },
      { key: "wheelchair_accessible", label: "Wheelchair Accessible" }
    ],
    baggageCategories: [
      { key: "xl_suitcase", label: "XL suitcase" },
      { key: "l_suitcase", label: "L suitcase" },
      { key: "cabin_bag", label: "CB cabin bag" },
      { key: "backpack", label: "BP backpack" }
    ],
    helpFor: (key: string) => ({ title: key, body: `Information about ${key}.` })
  });
}

test("vehicle form renders grouped fields and responsive, scoped control styles", async () => {
  const html = await renderVehicleForm();

  for (const heading of ["Basic details", "Vehicle class assignment", "Registered operator", "Baggage capacity (maximum quantity)", "Notes"]) {
    assert.ok(html.includes(heading), `expected the ${heading} section`);
  }
  for (const name of [
    "registration", "make", "model", "fuelType", "passengerCapacity", "status",
    "classKeys", "year", "colour", "registeredKeeperDetails",
    "capacity_xl_suitcase", "capacity_l_suitcase", "capacity_cabin_bag", "capacity_backpack", "notes"
  ]) {
    assert.match(html, new RegExp(`name="${name}"`), `expected the ${name} field`);
  }
  assert.match(html, /name="_csrf" value="test-token"/);
  assert.match(html, /class="help-button" type="button" aria-haspopup="dialog"/);
  assert.match(html, /aria-label="Help: vehicle\.fuelType"/);
  assert.match(html, /name="classKeys" value="wheelchair_accessible"/);
  assert.doesNotMatch(html, /name="wheelchairAccessible"/);
  assert.doesNotMatch(html, /Wheelchair accessibility capability/);
  assert.match(html, /Year of first registration/);

  const yearOptions = /<select name="year">([\s\S]*?)<\/select>/.exec(html)?.[1];
  assert.ok(yearOptions);
  const years = Array.from(yearOptions.matchAll(/<option value="(\d{4})"/g), (match) => Number(match[1]));
  const currentYear = new Date().getFullYear();
  assert.deepEqual(years, Array.from({ length: currentYear - 2004 }, (_, index) => 2005 + index));
  assert.match(yearOptions, /<option value="" selected>Not set<\/option>/);

  const capacities = /<select name="capacity_xl_suitcase">([\s\S]*?)<\/select>/.exec(html)?.[1];
  assert.ok(capacities);
  assert.match(capacities, /<option value="" selected>Not set<\/option>/);
  assert.deepEqual(Array.from(capacities.matchAll(/<option value="(\d+)"/g), (match) => Number(match[1])), [1, 2, 3, 4, 5, 6, 7, 8]);

  const legacyHtml = await renderVehicleForm({
    id: "vehicle-1",
    year: 2000,
    capacities: [
      { categoryKey: "xl_suitcase", maxQuantity: 0 },
      { categoryKey: "l_suitcase", maxQuantity: 10 }
    ],
    classes: [{ key: "wheelchair_accessible", label: "Wheelchair Accessible" }]
  });
  assert.match(legacyHtml, /<option value="2000" selected>2000 \(legacy\)<\/option>/);
  assert.match(legacyHtml, /<option value="0" selected>0 \(legacy\)<\/option>/);
  assert.match(legacyHtml, /<option value="10" selected>10 \(legacy\)<\/option>/);
  assert.match(legacyHtml, /name="classKeys" value="wheelchair_accessible" checked/);

  const css = fs.readFileSync(path.join(process.cwd(), "public/css/app.css"), "utf8");
  assert.match(css, /\.vehicle-form input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\),\s*\.vehicle-form select,\s*\.vehicle-form textarea\s*\{[\s\S]*width:100%;[\s\S]*max-width:none;/);
  assert.match(css, /@media \(max-width: 900px\)\s*\{\s*\.vehicle-form \.vehicle-form__fields \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\);/);
  assert.match(css, /@media \(max-width: 560px\)\s*\{\s*\.vehicle-form \.vehicle-form__fields,\s*\.vehicle-form \.vehicle-capacity-grid \{ grid-template-columns:minmax\(0,1fr\);/);
  assert.match(css, /\.vehicle-form \.help-button\s*\{[^}]*min-height:1\.25rem;[^}]*padding:0;/);
});

test("vehicle form controls use responsive columns without horizontal overflow", async (t) => {
  const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
  if (!fs.existsSync(executablePath)) {
    t.skip(`Chromium executable not found at ${executablePath}`);
    return;
  }

  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<main class="vehicle-page"><section class="vehicle-card vehicle-form">
      <div class="vehicle-form__fields">${[1, 2, 3].map((n) => `<label><span class="vehicle-form__label">Field ${n}</span><input></label>`).join("")}</div>
      <div class="vehicle-capacity-grid">${[1, 2, 3, 4].map((n) => `<label><span class="vehicle-form__label">Bag ${n}</span><select><option>1</option></select></label>`).join("")}</div>
    </section></main>`);
    const css = fs.readFileSync(path.join(process.cwd(), "public/css/app.css"), "utf8")
      .replace(/^@import[^;]+;\s*/m, "");
    await page.addStyleTag({ content: css });

    for (const [width, expectedColumns] of [[1200, 3], [800, 2], [390, 1]] as const) {
      await page.setViewportSize({ width, height: 800 });
      const layout = await page.evaluate(() => ({
        formColumns: getComputedStyle(document.querySelector(".vehicle-form__fields")!).gridTemplateColumns.trim().split(/\s+/).length,
        capacityColumns: getComputedStyle(document.querySelector(".vehicle-capacity-grid")!).gridTemplateColumns.trim().split(/\s+/).length,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }));
      assert.equal(layout.formColumns, expectedColumns, `basic field columns at ${width}px`);
      assert.equal(layout.capacityColumns, expectedColumns === 3 ? 4 : expectedColumns, `baggage columns at ${width}px`);
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `vehicle form overflows at ${width}px`);
    }
  } finally {
    await browser.close();
  }
});
