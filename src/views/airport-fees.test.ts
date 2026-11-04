import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";

const formMarkup = `
  <main class="panel toll-fees-page">
    <section class="airport-fees__form-section">
      <form class="airport-fees__form">
        <input type="hidden" name="id" value="">
        <div class="airport-fees__field">
          <label for="airport-display-name">Airport display name</label>
          <input id="airport-display-name" name="displayName" required>
        </div>
        ${["dropoff", "pickup"].map((operation) => {
          const title = operation === "dropoff" ? "Drop-off" : "Pick-up";
          return `
            <fieldset class="airport-fees__operation" data-operation="${operation}">
              <legend>${title}</legend>
              <div class="airport-fees__field">
                <label for="airport-${operation}-location">${title} location</label>
                <input id="airport-${operation}-location" name="${operation}LocationLabel" readonly required>
                <div class="airport-fees__autocomplete-host"><gmp-place-autocomplete></gmp-place-autocomplete></div>
                <p class="airport-fees__help">Select a Google Places result.</p>
              </div>
              <div class="airport-fees__field">
                <label for="airport-${operation}-fee">${title} fee (GBP)</label>
                <div class="airport-fees__amount"><span aria-hidden="true">£</span><input id="airport-${operation}-fee" name="${operation}Fee" type="number" step="0.01"></div>
                <p class="airport-fees__field-error">Enter an amount.</p>
              </div>
            </fieldset>`;
        }).join("")}
        <div class="airport-fees__actions"><button type="submit">Save airport and fees</button></div>
      </form>
    </section>
    <section class="airport-fees__records"><h2>Saved airports</h2></section>
  </main>`;

type AirportFormLayout = {
  gridTemplateColumns: string;
  columns: number;
  scrollWidth: number;
  clientWidth: number;
  formBottom: number;
  recordsTop: number;
  displayName: { left: number; right: number; top: number; width: number };
  dropoffLocation: { left: number; right: number; top: number; width: number };
  dropoffFee: { left: number; right: number; top: number; width: number };
  pickupLocation: { left: number; right: number; top: number; width: number };
  pickupFee: { left: number; right: number; top: number; width: number };
  save: { left: number; right: number; top: number; width: number };
};

test("Airport Fees form labels, field order, and saved list placement are accessible", () => {
  const template = fs.readFileSync(path.join(process.cwd(), "src/views/pages/toll-fees.ejs"), "utf8");
  const form = template.match(/<form class="airport-fees__form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form, "the page template should include the Airport Fees form");

  assert.ok(form.indexOf("name=\"displayName\"") < form.indexOf('["dropoff", "pickup"]'));
  assert.ok(form.indexOf('name="${operation}LocationLabel"') < form.indexOf('name="${operation}Fee"'));
  assert.ok(form.indexOf('["dropoff", "pickup"]') < form.indexOf("name=\"${operation}LocationLabel\""));
  for (const [id, label] of [
    ["airport-display-name", "Airport display name"],
    ["airport-dropoff-location", "Drop-off location"],
    ["airport-dropoff-fee", "Drop-off fee (GBP)"],
    ["airport-pickup-location", "Pick-up location"],
    ["airport-pickup-fee", "Pick-up fee (GBP)"]
  ]) {
    if (id.includes("display-name")) {
      assert.ok(form.includes(`<label for="${id}">${label}</label>`), `${label} should have an associated label`);
    } else {
      const field = id.endsWith("location") ? "${locationId}" : "${feeId}";
      assert.ok(form.includes(`<label for="${field}">\${title} ${label.replace(/^(Drop-off|Pick-up) /, "")}</label>`), `${label} should have an associated label`);
    }
  }
  assert.ok(template.indexOf("</form>") < template.indexOf('aria-labelledby="airport-fees-records-title"'));
  assert.match(form, /aria-describedby="\$\{locationId\}-help \$\{locationId\}-error"/);
  assert.match(form, /aria-describedby="\$\{feeId\}-error"/);
});

test("Airport Fees form fits desktop in one row and wraps without overflow on smaller screens", async (t) => {
  const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
  if (!fs.existsSync(executablePath)) {
    t.skip(`Chromium executable not found at ${executablePath}`);
    return;
  }

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(`<body style="margin:0">${formMarkup}</body>`);
    const css = fs.readFileSync(path.join(process.cwd(), "public/css/app.css"), "utf8")
      .replace(/^@import[^;]+;\s*/m, "");
    await page.addStyleTag({ content: css });

    for (const [width, columns] of [[1440, 4], [1280, 4], [1024, 2], [800, 1], [390, 1]] as const) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate<AirportFormLayout>(`(() => {
        const form = document.querySelector(".airport-fees__form");
        const formRect = form.getBoundingClientRect();
        const recordsRect = document.querySelector(".airport-fees__records").getBoundingClientRect();
        const rect = (selector) => {
          const element = document.querySelector(selector);
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, top: bounds.top, width: bounds.width };
        };
        return {
          gridTemplateColumns: getComputedStyle(form).gridTemplateColumns,
          columns: getComputedStyle(form).gridTemplateColumns.trim().split(" ").length,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          formBottom: formRect.bottom,
          recordsTop: recordsRect.top,
          displayName: rect("#airport-display-name"),
          dropoffLocation: rect("#airport-dropoff-location"),
          dropoffFee: rect("#airport-dropoff-fee"),
          pickupLocation: rect("#airport-pickup-location"),
          pickupFee: rect("#airport-pickup-fee"),
          save: rect(".airport-fees__actions button")
        };
      })()`);

      assert.equal(layout.columns, columns, `form columns at ${width}px (${layout.gridTemplateColumns})`);
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `page should not overflow at ${width}px`);
      assert.ok(layout.recordsTop >= layout.formBottom, "records should remain below the form");
      assert.ok(layout.dropoffFee.width >= 100, `drop-off fee input should be usable at ${width}px`);
      assert.ok(layout.pickupFee.width >= 100, `pick-up fee input should be usable at ${width}px`);

      if (width >= 1280) {
        const controls = [layout.displayName, layout.dropoffLocation, layout.dropoffFee, layout.pickupLocation, layout.pickupFee, layout.save];
        assert.ok(controls.every((control, index) => index === 0 || control.left > controls[index - 1].left), "desktop controls should appear in requested order");
        assert.ok(layout.dropoffLocation.width >= 200, "drop-off selector should have room for an operational location");
        assert.ok(layout.pickupLocation.width >= 200, "pick-up selector should have room for an operational location");
      }
    }

    assert.equal(await page.getByLabel("Airport display name").count(), 1);
    assert.equal(await page.getByLabel("Drop-off location").count(), 1);
    assert.equal(await page.getByLabel("Drop-off fee (GBP)").count(), 1);
    assert.equal(await page.getByLabel("Pick-up location").count(), 1);
    assert.equal(await page.getByLabel("Pick-up fee (GBP)").count(), 1);
  } finally {
    await browser?.close();
  }
});
