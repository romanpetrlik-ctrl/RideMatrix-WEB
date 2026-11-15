import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";

test("POI management forms expose labeled fields, linked fee details, and configuration-only messaging", () => {
  const template = fs.readFileSync(path.join(process.cwd(), "src/views/pages/poi-management.ejs"), "utf8");

  for (const [id, label] of [
    ["poi-display-name", "POI display name"],
    ["poi-category", "POI type or category"],
    ["poi-location-label", "Operational location"],
    ["poi-notes", "Operator notes or instructions"],
    ["poi-fee-poi", "POI"],
    ["poi-fee-action", "Applicable action or service"],
    ["poi-fee-amount", "Amount (GBP)"],
    ["poi-fee-basis", "Fee basis or unit"],
    ["poi-fee-notes", "Notes or source"]
  ]) {
    assert.ok(template.includes(`for="${id}">${label}`), `${label} should have a programmatically associated label`);
    assert.ok(template.includes(`id="${id}"`), `${id} should exist`);
  }
  assert.match(template, /aria-label="Breadcrumb"/);
  assert.match(template, /aria-label="System Settings destinations"/);
  assert.match(template, /aria-describedby="poi-location-help poi-location-error"/);
  assert.match(template, /aria-describedby="poi-fee-amount-error"/);
  assert.match(template, /<span aria-hidden="true">£<\/span><input id="poi-fee-amount"/);
  assert.match(template, /not applied to booking prices, totals, customer charges, or payments/);
  assert.match(template, /explicit confirmation that the optional service is used/);
  assert.match(template, /Stable internal ID|stable internal ID/i);
});

test("POI management content remains usable without horizontal overflow at mobile and desktop widths", async (t) => {
  const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
  if (!fs.existsSync(executablePath)) {
    t.skip(`Chromium executable not found at ${executablePath}`);
    return;
  }

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.setContent(`
      <main class="panel poi-management">
        <h1>POI Fees</h1>
        <nav class="poi-management__nav" aria-label="System Settings destinations">
          <a href="/settings/pois">POIs</a><a href="/settings/poi-fees" aria-current="page">POI Fees</a>
        </nav>
        <form class="poi-management__form poi-management__form--fee">
          <div class="poi-management__field"><label for="name">A long configured POI name</label><input id="name" type="text" value="Station name" /></div>
          <div class="poi-management__field">
            <label for="amount">Amount (GBP)</label>
            <div class="poi-management__amount"><span aria-hidden="true">£</span><input id="amount" name="amount" type="number" min="0" max="999999.99" step="0.01" inputmode="decimal" required /></div>
          </div>
          <fieldset class="poi-management__trigger"><legend>When is this fee applicable?</legend><label><input type="radio" />Optional service</label></fieldset>
          <div class="poi-management__actions"><button type="submit">Save POI Fee</button></div>
        </form>
        <article class="poi-management__record">
          <div class="poi-management__record-heading"><h3>Long configured POI name — EV charging</h3></div>
          <dl><div><dt>Linked POI ID</dt><dd><code>00000000-0000-0000-0000-000000000000</code></dd></div></dl>
        </article>
      </main>`);
    const css = fs.readFileSync(path.join(process.cwd(), "public/css/app.css"), "utf8")
      .replace(/^@import[^\r\n]*\r?\n/, "");
    await page.addStyleTag({ content: css });

    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        columns: getComputedStyle(document.querySelector(".poi-management__form")!).gridTemplateColumns
          .trim().split(/\s+/).length,
        amountWidth: document.querySelector("#amount")!.getBoundingClientRect().width
      }));
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `page should not overflow at ${width}px`);
      assert.equal(layout.columns, width <= 640 ? 1 : 2);
      assert.ok(layout.amountWidth > 0, `amount field should remain visible at ${width}px`);
    }

    const neighborStyle = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#name")!;
      const style = getComputedStyle(input);
      return {
        height: input.getBoundingClientRect().height,
        fontSize: style.fontSize,
        padding: style.padding,
        border: style.border,
        backgroundColor: style.backgroundColor,
        color: style.color
      };
    });
    const amountStyle = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#amount")!;
      const style = getComputedStyle(input);
      return {
        height: input.getBoundingClientRect().height,
        fontSize: style.fontSize,
        padding: style.padding,
        border: style.border,
        backgroundColor: style.backgroundColor,
        color: style.color,
        label: input.labels?.[0]?.textContent?.trim(),
        currency: input.parentElement?.querySelector("span")?.textContent?.trim(),
        currencyIsHidden: input.parentElement?.querySelector("span")?.getAttribute("aria-hidden")
      };
    });
    assert.equal(amountStyle.height, neighborStyle.height, "amount control should match neighboring control height");
    assert.equal(amountStyle.fontSize, neighborStyle.fontSize);
    assert.equal(amountStyle.padding, neighborStyle.padding);
    assert.equal(amountStyle.border, neighborStyle.border);
    assert.equal(amountStyle.backgroundColor, neighborStyle.backgroundColor);
    assert.equal(amountStyle.color, neighborStyle.color);
    assert.equal(amountStyle.label, "Amount (GBP)");
    assert.equal(amountStyle.currency, "£");
    assert.equal(amountStyle.currencyIsHidden, "true");

    await page.getByLabel("A long configured POI name").focus();
    await page.keyboard.press("Tab");
    await page.getByLabel("Amount (GBP)").waitFor();
    const focusStyle = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
    assert.notEqual(focusStyle, "none", "keyboard focus should be visible");
    assert.deepEqual(consoleErrors, [], "browser console should not report errors");
  } finally {
    await browser?.close();
  }
});
