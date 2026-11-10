import assert from "node:assert/strict";
import ejs from "ejs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

async function renderDistanceSlabSettings(
  distanceSlabs = [{ startMiles: "0", endMiles: "", ratePerMile: "3.25" }]
): Promise<string> {
  return ejs.renderFile(path.join(process.cwd(), "src/views/pages/fare-settings.ejs"), {
    title: "Fare Settings: Distance Slabs",
    appTitle: "RideMatrix Test",
    email: "operator@example.test",
    grantedByLabel: "Superuser",
    categories: [],
    category: {
      slug: "distance-slabs",
      title: "Distance Slabs",
      description: "Configure progressive distance rates.",
      configurable: true
    },
    breadcrumbs: [
      { label: "System Settings", href: "/settings" },
      { label: "Fare Settings", href: "/settings/fare-settings" },
      { label: "Distance Slabs" }
    ],
    configuration: {
      distanceSlabs,
      dailySurcharge: { enabled: false, percentage: "", startTime: "", endTime: "" },
      bankHolidaySurcharge: { enabled: false, periods: [] }
    },
    currentVersion: 0,
    history: [],
    errors: {},
    formError: "",
    saved: false,
    csrfField: ""
  });
}

test("distance slab editor adds contiguous editable rows and preserves values", async (t) => {
  const numericFinalHtml = await renderDistanceSlabSettings([
    { startMiles: "0", endMiles: "10", ratePerMile: "3.25" }
  ]);
  assert.match(numericFinalHtml, /data-slab-title>Slab 1<\/th>[\s\S]*?value="10" placeholder=""/);

  const executablePath = process.env.CHROMIUM_PATH
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    t.skip("Chromium executable not found");
    return;
  }

  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    const html = (await renderDistanceSlabSettings())
      .replace(/<link\b[^>]*>/g, "")
      .replace(/<script\b[^>]*><\/script>/g, "");
    await page.setContent(html);
    const css = fs.readFileSync(path.join(process.cwd(), "public/css/app.css"), "utf8")
      .replace(/^@import[^;]+;\s*/m, "");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ path: path.join(process.cwd(), "public/js/distance-slab-calculator.js") });
    await page.addScriptTag({ path: path.join(process.cwd(), "public/js/fare-settings.js") });

    const renderedOrder = await page.evaluate(() => {
      const preview = document.querySelector("[aria-labelledby='distance-preview-title']")!;
      const table = document.querySelector(".fare-settings__slab-table-wrap")!;
      return preview.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    assert.ok(renderedOrder, "settings preview should appear before the distance slab table");

    await page.getByRole("button", { name: "Add distance slab" }).click();
    assert.equal(await page.locator("[data-distance-slab]").count(), 1);
    assert.match(await page.locator("[data-add-distance-slab-error]").textContent() ?? "", /end distance.*before adding/i);

    await page.locator('[name="distanceSlabs[0][endMiles]"]').fill("10");
    await page.locator("[data-test-distance]").fill("5");
    assert.doesNotMatch(await page.locator("[data-slab-title]").textContent() ?? "", /open-ended final slab/);
    assert.equal(await page.locator("[data-distance-preview-total]").textContent(), "—");
    assert.match(await page.locator("#distance-test-error").textContent() ?? "", /schedule is incomplete or invalid/i);
    await page.locator("[data-test-distance]").fill("");
    await page.getByRole("button", { name: "Add distance slab" }).click();
    assert.equal(await page.locator("[data-distance-slab]").count(), 2);
    assert.equal(await page.locator('[name="distanceSlabs[0][startMiles]"]').inputValue(), "0");
    assert.equal(await page.locator('[name="distanceSlabs[0][endMiles]"]').inputValue(), "10");
    assert.equal(await page.locator('[name="distanceSlabs[0][ratePerMile]"]').inputValue(), "3.25");
    assert.equal(await page.locator('[name="distanceSlabs[1][startMiles]"]').inputValue(), "10");
    assert.equal(await page.locator('[name="distanceSlabs[1][endMiles]"]').inputValue(), "");
    assert.equal(await page.locator('[name="distanceSlabs[1][ratePerMile]"]').isEditable(), true);
    assert.doesNotMatch(await page.locator("[data-slab-title]").nth(0).textContent() ?? "", /open-ended final slab/);
    assert.match(await page.locator("[data-slab-title]").nth(1).textContent() ?? "", /open-ended final slab/);
    assert.equal(await page.locator("[data-add-distance-slab-error]").isVisible(), false);

    await page.locator('[name="distanceSlabs[1][ratePerMile]"]').fill("2.70");
    await page.locator("[data-test-distance]").fill("12");
    assert.equal(await page.locator("[data-distance-preview-total]").textContent(), "£37.90");

    await page.getByRole("button", { name: "Add distance slab" }).click();
    assert.equal(await page.locator("[data-distance-slab]").count(), 2);
    assert.match(await page.locator("[data-add-distance-slab-error]").textContent() ?? "", /end distance.*before adding/i);
    await page.locator('[name="distanceSlabs[1][endMiles]"]').fill("invalid");
    await page.getByRole("button", { name: "Add distance slab" }).click();
    assert.equal(await page.locator("[data-distance-slab]").count(), 2);
    assert.match(await page.locator("[data-add-distance-slab-error]").textContent() ?? "", /valid non-negative end distance/i);

    await page.locator("[data-remove-distance-slab]").nth(1).click();
    assert.equal(await page.locator("[data-distance-slab]").count(), 1);
    assert.equal(await page.locator('[name="distanceSlabs[0][ratePerMile]"]').inputValue(), "3.25");
    await page.locator('[name="distanceSlabs[0][endMiles]"]').fill("");
    await page.evaluate(() => {
      document.querySelector("[data-distance-slab-form]")?.addEventListener("submit", (event) => event.preventDefault());
    });
    await page.getByRole("button", { name: "Save distance slabs" }).click();
    const submittedValues = await page.locator("[data-distance-slab-form]").evaluate((form) =>
      Array.from(new FormData(form as HTMLFormElement).entries())
    );
    assert.deepEqual(submittedValues.filter(([name]) => name.startsWith("distanceSlabs[")), [
      ["distanceSlabs[0][startMiles]", "0"],
      ["distanceSlabs[0][endMiles]", ""],
      ["distanceSlabs[0][ratePerMile]", "3.25"]
    ]);

    await page.setViewportSize({ width: 390, height: 844 });
    const previewLayout = await page.locator(".fare-settings__distance-preview").evaluate((preview) => ({
      scrollWidth: preview.scrollWidth,
      clientWidth: preview.clientWidth,
      columns: getComputedStyle(preview.querySelector(".fare-settings__preview-row")!).gridTemplateColumns
    }));
    assert.ok(previewLayout.scrollWidth <= previewLayout.clientWidth, "preview should not overflow at narrow widths");
    assert.equal(previewLayout.columns.trim().split(/\s+/).length, 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
