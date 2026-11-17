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

async function renderFixedFareSettings(): Promise<string> {
  return ejs.renderFile(path.join(process.cwd(), "src/views/pages/fare-settings.ejs"), {
    title: "Fare Settings: Fixed fares",
    appTitle: "RideMatrix Test",
    email: "operator@example.test",
    grantedByLabel: "Superuser",
    categories: [],
    category: {
      slug: "fixed-fares",
      title: "Fixed fares",
      description: "Configure directional fixed base fares.",
      configurable: true
    },
    breadcrumbs: [
      { label: "System Settings", href: "/settings" },
      { label: "Fare Settings", href: "/settings/fare-settings" },
      { label: "Fixed fares" }
    ],
    configuration: {
      distanceSlabs: [],
      minimumFareRules: [],
      fixedFares: [],
      dailySurcharge: { enabled: false, percentage: "", startTime: "", endTime: "" },
      bankHolidaySurcharge: { enabled: false, periods: [] }
    },
    fixedFareForms: [{
      id: "",
      name: "",
      originType: "",
      originPoiId: "",
      originPostcode: "",
      originPostcodeScope: "",
      destinationType: "",
      destinationPoiId: "",
      destinationPostcode: "",
      destinationPostcodeScope: "",
      baseFare: ""
    }],
    managedPois: [{ id: "rm-boh-internal-id", displayName: "Bournemouth Airport (BOH)" }],
    ruleForm: {},
    ruleFormId: "",
    ruleFormSubmitted: false,
    currentVersion: 0,
    history: [],
    errors: {},
    formError: "",
    saved: false,
    csrfField: ""
  });
}

async function renderMinimumFareRuleSettings(
  minimumFareRules: Array<{ id: string; name: string; poiId: string; minimumBaseFare: string }> = []
): Promise<string> {
  return ejs.renderFile(path.join(process.cwd(), "src/views/pages/fare-settings.ejs"), {
    title: "Fare Settings: Minimum Fare Rules",
    appTitle: "RideMatrix Test",
    email: "operator@example.test",
    grantedByLabel: "Superuser",
    categories: [],
    category: {
      slug: "minimum-fare-rules",
      title: "Minimum Fare Rules",
      description: "Configure minimum base fares.",
      configurable: true
    },
    breadcrumbs: [
      { label: "System Settings", href: "/settings" },
      { label: "Fare Settings", href: "/settings/fare-settings" },
      { label: "Minimum Fare Rules" }
    ],
    configuration: {
      distanceSlabs: [],
      minimumFareRules,
      dailySurcharge: { enabled: false, percentage: "", startTime: "", endTime: "" },
      bankHolidaySurcharge: { enabled: false, periods: [] }
    },
    managedPois: [{ id: "rm-boh-internal-id", displayName: "Bournemouth Airport (BOH)" }],
    ruleForm: {},
    ruleFormId: "",
    ruleFormSubmitted: false,
    currentVersion: 0,
    history: [],
    errors: {},
    formError: "",
    saved: false,
    csrfField: ""
  });
}

test("minimum fare forms omit radius for both new and saved rules", async () => {
  const savedRule = {
    id: "minimum-rule",
    name: "BOH minimum",
    poiId: "rm-boh-internal-id",
    minimumBaseFare: "25.00"
  };
  const html = await renderMinimumFareRuleSettings([savedRule]);
  assert.doesNotMatch(html, /Radius \(miles\)|name="radiusMiles"|minimum-rule-radius/);
  assert.match(html, /name="poiId"/);
  assert.match(html, /name="minimumBaseFare"/);
  assert.match(html, /value="25\.00"/);
  assert.match(html, /internal ID rm-boh-internal-id/);
});

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

    await page.locator("[data-test-distance]").fill("12");
    await page.getByRole("button", { name: "Add distance slab" }).click();
    assert.equal(await page.locator("[data-distance-slab]").count(), 2);
    assert.equal(await page.locator('[name="distanceSlabs[0][startMiles]"]').inputValue(), "0");
    assert.equal(await page.locator('[name="distanceSlabs[0][endMiles]"]').inputValue(), "");
    assert.equal(await page.locator('[name="distanceSlabs[0][ratePerMile]"]').inputValue(), "3.25");
    assert.equal(await page.locator('[name="distanceSlabs[1][startMiles]"]').inputValue(), "");
    assert.equal(await page.locator('[name="distanceSlabs[1][endMiles]"]').inputValue(), "");
    assert.equal(await page.locator('[name="distanceSlabs[1][ratePerMile]"]').isEditable(), true);
    assert.equal(await page.locator("[data-slab-title]").nth(0).textContent(), "Slab 1");
    assert.match(await page.locator("[data-slab-title]").nth(1).textContent() ?? "", /open-ended final slab/);
    assert.equal(await page.locator("[data-slab-start-instruction]").nth(1).isVisible(), true);
    assert.equal(await page.locator('[name="distanceSlabs[1][startMiles]"]').evaluate((input) => input === document.activeElement), true);
    assert.equal(await page.locator("[data-add-distance-slab-error]").isVisible(), false);
    assert.equal(await page.locator("[data-test-distance]").inputValue(), "12");
    assert.equal(await page.locator("[data-distance-preview-total]").textContent(), "—");
    assert.match(await page.locator("#distance-test-error").textContent() ?? "", /schedule is incomplete or invalid/i);

    await page.locator("[data-remove-distance-slab]").nth(1).click();
    assert.equal(await page.locator("[data-distance-slab]").count(), 1);
    assert.equal(await page.locator('[name="distanceSlabs[0][endMiles]"]').inputValue(), "");
    assert.match(await page.locator("[data-slab-title]").textContent() ?? "", /open-ended final slab/);
    await page.getByRole("button", { name: "Add distance slab" }).click();

    await page.locator('[name="distanceSlabs[1][startMiles]"]').fill("10");
    assert.equal(await page.locator('[name="distanceSlabs[0][endMiles]"]').inputValue(), "10");
    assert.equal(await page.locator('[name="distanceSlabs[1][startMiles]"]').inputValue(), "10");
    assert.equal(await page.locator("[data-slab-start-instruction]").nth(1).isVisible(), false);
    await page.locator("[data-distance-slab-form]").evaluate((form) => {
      (window as typeof window & { submitWasPrevented?: boolean }).submitWasPrevented = false;
      form.addEventListener("submit", (event) => {
        (window as typeof window & { submitWasPrevented?: boolean }).submitWasPrevented = event.defaultPrevented;
        event.preventDefault();
      });
    });
    await page.getByRole("button", { name: "Save distance slabs" }).click();
    assert.equal(await page.evaluate(() => (window as typeof window & { submitWasPrevented?: boolean }).submitWasPrevented), true);
    assert.equal(await page.locator("[data-distance-slab-submit-error]").isVisible(), true);
    assert.match(await page.locator("[data-distance-slab-submit-error]").textContent() ?? "", /rate for every slab.*before saving/i);

    await page.locator('[name="distanceSlabs[1][ratePerMile]"]').fill("2.70");
    assert.equal(await page.locator("[data-distance-preview-total]").textContent(), "£37.90");
    assert.equal(await page.locator("[data-distance-slab-submit-error]").isVisible(), false);

    await page.locator('[name="distanceSlabs[1][endMiles]"]').fill("15");
    await page.getByRole("button", { name: "Add distance slab" }).click();
    assert.equal(await page.locator("[data-distance-slab]").count(), 3);
    assert.equal(await page.locator('[name="distanceSlabs[2][startMiles]"]').inputValue(), "15");
    assert.equal(await page.locator('[name="distanceSlabs[1][endMiles]"]').inputValue(), "15");
    assert.equal(await page.locator('[name="distanceSlabs[2][endMiles]"]').inputValue(), "");
    assert.match(await page.locator("[data-slab-title]").nth(2).textContent() ?? "", /open-ended final slab/);

    await page.locator("[data-remove-distance-slab]").nth(2).click();
    assert.equal(await page.locator("[data-distance-slab]").count(), 2);
    assert.equal(await page.locator('[name="distanceSlabs[1][endMiles]"]').inputValue(), "");
    assert.match(await page.locator("[data-slab-title]").nth(1).textContent() ?? "", /open-ended final slab/);
    await page.locator("[data-distance-slab-form]").evaluate((form) => {
      form.addEventListener("submit", (event) => event.preventDefault());
    });
    await page.getByRole("button", { name: "Save distance slabs" }).click();
    const submittedValues = await page.locator("[data-distance-slab-form]").evaluate((form) =>
      Array.from(new FormData(form as HTMLFormElement).entries())
    );
    assert.deepEqual(submittedValues.filter(([name]) => name.startsWith("distanceSlabs[")), [
      ["distanceSlabs[0][startMiles]", "0"],
      ["distanceSlabs[0][endMiles]", "10"],
      ["distanceSlabs[0][ratePerMile]", "3.25"],
      ["distanceSlabs[1][startMiles]", "10"],
      ["distanceSlabs[1][endMiles]", ""],
      ["distanceSlabs[1][ratePerMile]", "2.70"]
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

test("fixed-fare endpoint selector switches required identity fields and preserves explicit postcode scope", async (t) => {
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
    const html = (await renderFixedFareSettings())
      .replace(/<link\b[^>]*>/g, "")
      .replace(/<script\b[^>]*><\/script>/g, "");
    await page.setContent(html);
    const css = fs.readFileSync(path.join(process.cwd(), "public/css/app.css"), "utf8")
      .replace(/^@import[^;]+;\s*/m, "");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ path: path.join(process.cwd(), "public/js/fare-settings.js") });

    const origin = page.locator("[data-fixed-endpoint]").first();
    const identification = origin.locator('select[name="originType"]');
    const managedPoi = origin.locator('select[name="originPoiId"]');
    const postcode = origin.locator('input[name="originPostcode"]');
    const scope = origin.locator('select[name="originPostcodeScope"]');

    await identification.selectOption("poi");
    assert.equal(await managedPoi.isVisible(), true);
    assert.equal(await managedPoi.evaluate((input) => (input as HTMLSelectElement).required), true);
    assert.equal(await postcode.isVisible(), false);
    assert.equal(await postcode.isDisabled(), true);

    await identification.selectOption("postcode");
    assert.equal(await managedPoi.isVisible(), false);
    assert.equal(await managedPoi.evaluate((input) => (input as HTMLSelectElement).required), false);
    assert.equal(await postcode.isVisible(), true);
    assert.equal(await postcode.evaluate((input) => (input as HTMLInputElement).required), true);
    assert.equal(await scope.evaluate((input) => (input as HTMLSelectElement).required), true);

    await scope.selectOption("full");
    await postcode.fill("BH1 1AA");
    assert.equal(await postcode.evaluate((input) => (input as HTMLInputElement).checkValidity()), true);
    await postcode.fill("bh1 1aa");
    assert.equal(await postcode.evaluate((input) => (input as HTMLInputElement).checkValidity()), true);
    await postcode.fill("Q1 1AA");
    assert.equal(await postcode.evaluate((input) => (input as HTMLInputElement).checkValidity()), false);
    await postcode.fill("BH1 1CI");
    assert.equal(await postcode.evaluate((input) => (input as HTMLInputElement).checkValidity()), false);
    await postcode.fill("not a postcode");
    assert.equal(await postcode.evaluate((input) => (input as HTMLInputElement).checkValidity()), false);

    await scope.selectOption("outward");
    await postcode.fill("Q1");
    assert.equal(await postcode.evaluate((input) => (input as HTMLInputElement).checkValidity()), false);
    await postcode.fill("bh1");
    assert.equal(await postcode.evaluate((input) => (input as HTMLInputElement).checkValidity()), true);

    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await origin.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth
    }));
    assert.ok(layout.scrollWidth <= layout.clientWidth, "endpoint form should not overflow at narrow widths");
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

async function renderAdditionalSlabEditor(baseSlabs: Array<{ startMiles: string; endMiles: string; ratePerMile: string }>): Promise<string> {
  const escapedJson = JSON.stringify(baseSlabs).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return ejs.renderFile(path.join(process.cwd(), "src/views/pages/fare-settings.ejs"), {
    title: "Fare Settings: Create additional distance slabs set",
    appTitle: "RideMatrix Test",
    email: "operator@example.test",
    grantedByLabel: "Superuser",
    categories: [],
    category: {
      slug: "additional-distance-slabs",
      title: "Additional distance slabs",
      description: "Configure independent slab sets.",
      configurable: true
    },
    breadcrumbs: [
      { label: "System Settings", href: "/settings" },
      { label: "Fare Settings", href: "/settings/fare-settings" },
      { label: "Additional distance slabs", href: "/settings/fare-settings/additional-distance-slabs" },
      { label: "Create additional distance slabs set" }
    ],
    configuration: {
      distanceSlabs: baseSlabs,
      dailySurcharge: { enabled: false, percentage: "", startTime: "", endTime: "" },
      bankHolidaySurcharge: { enabled: false, periods: [] }
    },
    additionalSets: [],
    additionalEditor: {
      id: "",
      name: "",
      targetKey: "",
      unavailableTargetLabel: "",
      distanceSlabs: [{ startMiles: "", endMiles: "", ratePerMile: "" }]
    },
    additionalRemoveSet: null,
    additionalCopied: false,
    managedTargets: {
      airports: [{ key: "airport:rm-boh", displayName: "Bournemouth Airport (BOH)" }],
      pois: [{ key: "poi:poi-pier", displayName: "Bournemouth Pier" }]
    },
    baseSlabsJson: escapedJson,
    baseSlabCount: baseSlabs.length,
    currentVersion: 3,
    history: [],
    errors: {},
    formError: "",
    saved: false,
    csrfField: ""
  });
}

test("additional slab editor copies base slabs into the shared editor with the same live preview", async (t) => {
  const baseSlabs = [
    { startMiles: "0", endMiles: "10", ratePerMile: "3.00" },
    { startMiles: "10", endMiles: "", ratePerMile: "2.70" }
  ];
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
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });
    const html = (await renderAdditionalSlabEditor(baseSlabs))
      .replace(/<link\b[^>]*>/g, "")
      .replace(/<script\b[^>]*><\/script>/g, "");
    await page.setContent(html);
    await page.addScriptTag({ path: path.join(process.cwd(), "public/js/distance-slab-calculator.js") });
    await page.addScriptTag({ path: path.join(process.cwd(), "public/js/fare-settings.js") });

    assert.equal(await page.getByLabel("Select POI or Place to link it").isVisible(), true);
    assert.equal(await page.getByLabel("Test distance (miles)").isVisible(), true);
    assert.equal(await page.locator("[data-distance-slab]").count(), 1);

    await page.locator("[data-test-distance]").fill("12");
    assert.equal(await page.locator("[data-distance-preview-total]").textContent(), "—");

    await page.getByRole("button", { name: "Copy base slabs data" }).click();
    assert.deepEqual(dialogs, [], "an empty editor is replaced without confirmation");
    assert.equal(await page.locator("[data-distance-slab]").count(), 2);
    const values = await page.locator("[data-distance-slab-form]").evaluate((form) =>
      Array.from(new FormData(form as HTMLFormElement).entries()).filter(([name]) => String(name).startsWith("distanceSlabs["))
    );
    assert.deepEqual(values, [
      ["distanceSlabs[0][startMiles]", "0"],
      ["distanceSlabs[0][endMiles]", "10"],
      ["distanceSlabs[0][ratePerMile]", "3.00"],
      ["distanceSlabs[1][startMiles]", "10"],
      ["distanceSlabs[1][endMiles]", ""],
      ["distanceSlabs[1][ratePerMile]", "2.70"]
    ]);
    assert.match(await page.locator("[data-slab-title]").nth(1).textContent() ?? "", /open-ended final slab/);
    assert.equal(await page.locator("[data-open-ended-note]").nth(1).isVisible(), true);
    assert.match(await page.locator("[data-copy-base-status]").textContent() ?? "", /Copied 2 base slabs.*base slabs are unchanged/);
    assert.equal(await page.locator("[data-distance-preview-total]").textContent(), "£35.40");

    await page.locator('[name="distanceSlabs[0][ratePerMile]"]').fill("3.50");
    assert.equal(await page.locator("[data-distance-preview-total]").textContent(), "£40.40");
    assert.equal(
      await page.locator("[data-copy-base-slabs]").getAttribute("data-base-slabs"),
      JSON.stringify(baseSlabs),
      "editing the copy leaves the base snapshot unchanged"
    );

    await page.locator('[name="distanceSlabs[1][startMiles]"]').fill("11");
    assert.equal(await page.locator("[data-distance-preview-total]").textContent(), "—");

    await page.getByRole("button", { name: "Add distance slab" }).click();
    assert.equal(await page.locator("[data-distance-slab]").count(), 3);
    assert.match(await page.locator("[data-slab-title]").nth(2).textContent() ?? "", /open-ended final slab/);

    await page.getByRole("button", { name: "Copy base slabs data" }).click();
    assert.equal(dialogs.length, 1, "replacing edited rows asks for confirmation");
    assert.equal(await page.locator("[data-distance-slab]").count(), 2);
    assert.equal(await page.locator('[name="distanceSlabs[0][ratePerMile]"]').inputValue(), "3.00");
    assert.equal(await page.locator("[data-distance-preview-total]").textContent(), "£35.40");
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
