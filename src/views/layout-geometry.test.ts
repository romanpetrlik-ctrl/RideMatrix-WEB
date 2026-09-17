import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractRuleBody(source: string, selector: string): string {
  const expression = new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`);
  const match = source.match(expression);
  assert.ok(match, `Missing rule for selector: ${selector}`);
  return match[1];
}

function extractBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Missing block marker: ${marker}`);
  const openBraceIndex = source.indexOf("{", markerIndex);
  assert.notEqual(openBraceIndex, -1, `Missing opening brace for: ${marker}`);

  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, index);
      }
    }
  }

  assert.fail(`Unterminated block for: ${marker}`);
}

function computePageEdgeSpace(viewportWidth: number): number {
  return Math.max(16, Math.min(viewportWidth * 0.02, 48));
}

test("shell geometry keeps consistent full-width edges across audited viewports", () => {
  const css = read("public/css/app.css");
  const baseLayout = read("src/views/layouts/base.ejs");
  const header = read("src/views/partials/header.ejs");
  const systemStatus = read("src/views/partials/system-status-bar.ejs");
  const footer = read("src/views/partials/footer.ejs");

  assert.match(css, /--rm-page-edge-space:\s*clamp\(1rem, 2vw, 3rem\);/);
  assert.match(css, /\.rm-page-shell,\s*\.container \{[\s\S]*display: block;[\s\S]*width: auto;[\s\S]*max-width: none;[\s\S]*margin-inline: var\(--rm-page-edge-space\);[\s\S]*min-width: 0;[\s\S]*box-sizing: border-box;/);
  assert.match(css, /main\.container,\s*main\.rm-page-shell \{[\s\S]*padding: 0\.75rem 0 1\.5rem;/);
  assert.match(baseLayout, /<main class="container rm-page-shell">/);
  assert.match(header, /class="container rm-page-shell site-header__inner"/);
  assert.match(header, /class="container rm-page-shell site-header__context"/);
  assert.match(systemStatus, /class="container rm-page-shell system-status-bar__inner"/);
  assert.match(footer, /class="container rm-page-shell"/);
  assert.doesNotMatch(css, /--rm-page-shell-max-width|--rm-page-shell-edge-space|--rm-top-bar-edge-space|--rm-main-content-edge-space/);

  for (const viewportWidth of [1920, 1600, 1440, 1280, 1024, 820, 390]) {
    const edge = computePageEdgeSpace(viewportWidth);
    const leftGap = edge;
    const rightGap = edge;
    const shellWidth = viewportWidth - (edge * 2);

    assert.ok(edge <= 80, `Viewport ${viewportWidth} produced an artificial shell gap of ${edge}px`);
    assert.ok(Math.abs(leftGap - rightGap) <= 2, `Viewport ${viewportWidth} shell gaps are not symmetric`);
    assert.ok(shellWidth > 0, `Viewport ${viewportWidth} produced a non-positive shell width`);
  }

  assert.ok(1920 - (computePageEdgeSpace(1920) * 2) > 1320);
  assert.ok(1600 - (computePageEdgeSpace(1600) * 2) > 1320);
});

test("dashboard and private-customer layouts stay full width without non-table overflow", () => {
  const css = read("public/css/app.css");
  const chooseRole = read("src/views/pages/choose-role.ejs");
  const dashboard = read("src/views/pages/dashboard.ejs");
  const register = read("src/views/pages/customers/register.ejs");
  const edit = read("src/views/pages/customers/edit.ejs");
  const mobile1200 = extractBlock(css, "@media (max-width: 1200px)");
  const mobile760 = extractBlock(css, "@media (max-width: 760px)");
  const detailLayout = extractRuleBody(css, ".customer-detail-layout");
  const detailPhoneActions = extractRuleBody(css, ".customer-detail-list .phone-number-actions");

  for (const selector of [
    ".dashboard-hero",
    ".dashboard-layout",
    ".workspace-tile-grid",
    ".operations-menu-prototype"
  ]) {
    const rule = extractRuleBody(css, selector);
    assert.match(rule, /width: 100%;/);
    assert.match(rule, /max-width: none;/);
    assert.match(rule, /min-width: 0;/);
    assert.match(rule, /box-sizing: border-box;/);
  }

  const actionsRule = extractRuleBody(css, ".operations-menu-prototype__actions");
  assert.match(actionsRule, /flex-wrap: wrap;/);
  assert.match(actionsRule, /width: 100%;/);
  assert.doesNotMatch(actionsRule, /overflow-x:/);

  const centeredPanel = extractRuleBody(css, ".customer-form-panel--centered");
  assert.match(centeredPanel, /width: 100%;/);
  assert.match(centeredPanel, /max-width: none;/);
  assert.match(centeredPanel, /margin-inline: 0;/);
  assert.match(centeredPanel, /min-width: 0;/);
  assert.match(centeredPanel, /box-sizing: border-box;/);

  const formGrid = extractRuleBody(css, ".private-customer-form__grid");
  assert.match(formGrid, /grid-template-columns: minmax\(20rem, 1fr\) minmax\(30rem, 1\.35fr\) minmax\(20rem, 1fr\);/);
  assert.match(formGrid, /width: 100%;/);
  assert.match(formGrid, /max-width: none;/);
  assert.match(formGrid, /min-width: 0;/);
  assert.match(formGrid, /box-sizing: border-box;/);

  assert.match(mobile1200, /\.private-customer-form__grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(mobile1200, /\.private-customer-form__column--map\s*\{[^}]*grid-column: 1 \/ -1;/);
  assert.match(mobile760, /\.private-customer-form__grid\s*\{[^}]*grid-template-columns: 1fr;/);
  assert.match(detailLayout, /width: 100%;/);
  assert.match(detailLayout, /max-width: none;/);
  assert.match(detailLayout, /min-width: 0;/);
  assert.match(detailLayout, /box-sizing: border-box;/);
  assert.match(detailPhoneActions, /grid-template-columns: 1fr;/);

  assert.match(chooseRole, /class="dashboard-layout"/);
  assert.match(chooseRole, /class="workspace-tile-grid"/);
  assert.match(dashboard, /class="operations-menu-prototype"/);
  assert.match(register, /class="inline-form private-customer-form"/);
  assert.match(edit, /class="inline-form private-customer-form"/);
});

test("wrapper-only horizontal overflow stays limited to table wrappers", () => {
  const css = read("public/css/app.css");
  const customers = read("src/views/pages/customers/index.ejs");
  const detail = read("src/views/partials/customer-detail-content.ejs");
  const staff = read("src/views/pages/staff/index.ejs");
  const vehicles = read("src/views/pages/vehicles/index.ejs");
  const htmlRule = extractRuleBody(css, "html");
  const bodyRule = extractRuleBody(css, "body");
  const shellRule = css.match(/\.rm-page-shell,\s*\.container\s*\{([^}]*)\}/)?.[1];
  const mainRule = css.match(/main\.container,\s*main\.rm-page-shell\s*\{([^}]*)\}/)?.[1];

  assert.equal((css.match(/overflow-x\s*:/g) || []).length, 1);
  assert.match(css, /\.customers-table-wrapper,\s*\.staff-table-wrapper,\s*\.vehicle-table-wrapper,\s*\.table-wrapper \{[\s\S]*overflow-x: auto;/);
  assert.ok(shellRule);
  assert.ok(mainRule);
  assert.doesNotMatch(htmlRule, /overflow-x:/);
  assert.doesNotMatch(bodyRule, /overflow-x:/);
  assert.doesNotMatch(shellRule, /overflow-x:/);
  assert.doesNotMatch(mainRule, /overflow-x:/);

  assert.match(customers, /class="customers-table-wrapper"/);
  assert.match(detail, /class="customers-table-wrapper"/);
  assert.match(staff, /class="staff-table-wrapper"/);
  assert.match(vehicles, /class="vehicle-table-wrapper"/);
});
