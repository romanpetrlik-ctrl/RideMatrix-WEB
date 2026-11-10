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
                <div class="airport-fees__amount"><span aria-hidden="true">£</span><input id="airport-${operation}-fee" name="${operation}Fee" type="number" min="0" max="999999.99" step="0.01" inputmode="decimal" required></div>
                <p class="airport-fees__field-error">Enter an amount.</p>
              </div>
              ${operation === "pickup" ? `
                <div class="airport-fees__field"><label for="airport-pickup-time-reference">Time reference</label><select id="airport-pickup-time-reference" name="pickupTimeReference" required><option value="" selected>Select a time reference</option><option value="ALT">Actual Landing Time (ALT)</option><option value="AGA">Actual Gate Arrival (AGA)</option></select></div>
                <div class="airport-fees__field"><label for="airport-pickup-deferred-policy">Deferred pick-up policy</label><select id="airport-pickup-deferred-policy" name="pickupDeferredPolicy" required><option value="" selected>Select Yes or No</option><option value="yes">Yes</option><option value="no">No</option></select></div>
                <div class="airport-fees__field"><label for="airport-pickup-deferred-minutes">Deferred period before fee-covered period begins (minutes)</label><select id="airport-pickup-deferred-minutes" name="pickupDeferredMinutes" required><option value="" selected>Select minutes</option>${["0", "15", "30", "45", "60"].map((minutes) => `<option value="${minutes}">${minutes}</option>`).join("")}</select></div>
                <div class="airport-fees__field"><label for="airport-pickup-fee-covered-minutes">Fee-covered period (minutes)</label><select id="airport-pickup-fee-covered-minutes" name="pickupFeeCoveredMinutes" required><option value="" selected>Select minutes</option>${["10", "15", "20", "30", "40", "45", "60"].map((minutes) => `<option value="${minutes}">${minutes}</option>`).join("")}</select></div>
              ` : ""}
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
  dropoffLocation: { left: number; right: number; top: number; width: number; height: number };
  dropoffFee: { left: number; right: number; top: number; width: number; height: number };
  pickupLocation: { left: number; right: number; top: number; width: number; height: number };
  pickupFee: { left: number; right: number; top: number; width: number; height: number };
  pickupTimeReference: { left: number; right: number; top: number; width: number; height: number };
  pickupDeferredPolicy: { left: number; right: number; top: number; width: number; height: number };
  pickupDeferredMinutes: { left: number; right: number; top: number; width: number; height: number };
  pickupFeeCoveredMinutes: { left: number; right: number; top: number; width: number; height: number };
  dropoffFeeStyle: { padding: string; font: string; borderColor: string; backgroundColor: string };
  pickupFeeStyle: { padding: string; font: string; borderColor: string; backgroundColor: string };
  dropoffLocationStyle: { padding: string; font: string; borderColor: string; backgroundColor: string };
  pickupLocationStyle: { padding: string; font: string; borderColor: string; backgroundColor: string };
  dropoffAmount: { right: number; width: number };
  pickupAmount: { right: number; width: number };
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
    ["airport-pickup-fee", "Pick-up fee (GBP)"],
    ["airport-pickup-time-reference", "Time reference"],
    ["airport-pickup-deferred-policy", "Deferred pick-up policy"],
    ["airport-pickup-deferred-minutes", "Deferred period before fee-covered period begins (minutes)"],
    ["airport-pickup-fee-covered-minutes", "Fee-covered period (minutes)"]
  ]) {
    if (id.includes("display-name")) {
      assert.ok(form.includes(`<label for="${id}">${label}</label>`), `${label} should have an associated label`);
    } else if (id.startsWith("airport-pickup-") && !id.endsWith("location") && !id.endsWith("fee")) {
      assert.ok(form.includes(`<label for="${id}">${label}</label>`), `${label} should have an associated label`);
    } else {
      const field = id.endsWith("location") ? "${locationId}" : "${feeId}";
      assert.ok(form.includes(`<label for="${field}">\${title} ${label.replace(/^(Drop-off|Pick-up) /, "")}</label>`), `${label} should have an associated label`);
    }
  }
  assert.ok(template.indexOf("</form>") < template.indexOf('aria-labelledby="airport-fees-records-title"'));
  assert.match(form, /aria-describedby="\$\{locationId\}-help \$\{locationId\}-error"/);
  assert.match(form, /aria-describedby="\$\{feeId\}-error"/);
  assert.match(form, /<span aria-hidden="true">£<\/span><input id="\$\{feeId\}" name="\$\{operation\}Fee" type="number" min="0" max="999999\.99" step="0\.01" inputmode="decimal" required/);
  assert.match(form, /Enter an amount with up to 2 decimal places; £0\.00 is allowed\./);
  assert.match(form, /This event anchors the customer-facing pick-up time window/);
  assert.match(form, /This is the waiting period before the configured pick-up fee's covered period begins/);
  assert.match(form, /This is the period covered by the configured pick-up fee, not fee effective dates/);
  assert.match(form, /option value="ALT"[^>]*>Actual Landing Time \(ALT\)/);
  assert.match(form, /option value="AGA"[^>]*>Actual Gate Arrival \(AGA\)/);
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
      .replace(/^@import[^\r\n]*\r?\n/, "");
    await page.addStyleTag({ content: css });

    for (const [width, columns] of [[1440, 4], [1280, 4], [1024, 2], [800, 1], [390, 1], [320, 1]] as const) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate<AirportFormLayout>(`(() => {
        const form = document.querySelector(".airport-fees__form");
        const formRect = form.getBoundingClientRect();
        const recordsRect = document.querySelector(".airport-fees__records").getBoundingClientRect();
        const rect = (selector) => {
          const element = document.querySelector(selector);
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, top: bounds.top, width: bounds.width, height: bounds.height };
        };
        const controlStyle = (selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return {
            padding: style.padding,
            font: style.font,
            borderColor: style.borderTopColor,
            backgroundColor: style.backgroundColor
          };
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
          pickupTimeReference: rect("#airport-pickup-time-reference"),
          pickupDeferredPolicy: rect("#airport-pickup-deferred-policy"),
          pickupDeferredMinutes: rect("#airport-pickup-deferred-minutes"),
          pickupFeeCoveredMinutes: rect("#airport-pickup-fee-covered-minutes"),
          dropoffFeeStyle: controlStyle("#airport-dropoff-fee"),
          pickupFeeStyle: controlStyle("#airport-pickup-fee"),
          dropoffLocationStyle: controlStyle("#airport-dropoff-location"),
          pickupLocationStyle: controlStyle("#airport-pickup-location"),
          dropoffAmount: rect(".airport-fees__operation[data-operation='dropoff'] .airport-fees__amount"),
          pickupAmount: rect(".airport-fees__operation[data-operation='pickup'] .airport-fees__amount"),
          save: rect(".airport-fees__actions button")
        };
      })()`);

      assert.equal(layout.columns, columns, `form columns at ${width}px (${layout.gridTemplateColumns})`);
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `page should not overflow at ${width}px`);
      assert.ok(layout.recordsTop >= layout.formBottom, "records should remain below the form");
      assert.ok(layout.dropoffFee.width >= 100, `drop-off fee input should be usable at ${width}px`);
      assert.ok(layout.pickupFee.width >= 100, `pick-up fee input should be usable at ${width}px`);
      for (const control of [layout.pickupTimeReference, layout.pickupDeferredPolicy, layout.pickupDeferredMinutes, layout.pickupFeeCoveredMinutes]) {
        assert.ok(control.width >= 100, `pick-up timing select should be usable at ${width}px`);
      }
      assert.equal(layout.dropoffFee.height, layout.dropoffLocation.height, "drop-off fee should match the location control height");
      assert.equal(layout.pickupFee.height, layout.pickupLocation.height, "pick-up fee should match the location control height");
      assert.deepEqual(layout.dropoffFeeStyle, layout.dropoffLocationStyle, "drop-off fee should match the location control styling");
      assert.deepEqual(layout.pickupFeeStyle, layout.pickupLocationStyle, "pick-up fee should match the location control styling");
      assert.ok(Math.abs(layout.dropoffFee.right - layout.dropoffAmount.right) < 1, "drop-off fee should fill its fee column");
      assert.ok(Math.abs(layout.pickupFee.right - layout.pickupAmount.right) < 1, "pick-up fee should fill its fee column");

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
    assert.equal(await page.getByLabel("Time reference").count(), 1);
    assert.equal(await page.getByLabel("Deferred pick-up policy").count(), 1);
    assert.equal(await page.getByLabel("Deferred period before fee-covered period begins (minutes)").count(), 1);
    assert.equal(await page.getByLabel("Fee-covered period (minutes)").count(), 1);
    for (const id of ["airport-dropoff-fee", "airport-pickup-fee"]) {
      await page.locator(`#${id}`).focus();
      const focusShadow = await page.evaluate(() => getComputedStyle(document.activeElement as Element).boxShadow);
      assert.notEqual(focusShadow, "none", `${id} should have a visible focus treatment`);
    }
  } finally {
    await browser?.close();
  }
});
