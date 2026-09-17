import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
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

function extractCustomPropertyValue(source: string, propertyName: string): string {
  const expression = new RegExp(`${escapeRegExp(propertyName)}:\\s*([^;]+);`);
  const match = source.match(expression);
  assert.ok(match, `Missing custom property: ${propertyName}`);
  return match[1].trim();
}

function remToPixels(value: string): number {
  const match = value.match(/^([0-9.]+)rem$/);
  assert.ok(match, `Expected rem value, received: ${value}`);
  return Number(match[1]) * 16;
}

test("customer registration and edit actions are supplied by the dynamic bar", () => {
  const register = read("src/views/pages/customers/register.ejs");
  const edit = read("src/views/pages/customers/edit.ejs");

  assert.match(register, /contextBarActions:\s*\[/);
  assert.match(register, /Back to customer type/);
  assert.match(register, /Cancel/);
  assert.match(register, /Create Customer/);
  assert.doesNotMatch(register, /hintsLabel:\s*"Registration"/);
  assert.match(register, /customer-form-page--private/);
  assert.match(register, /<h1 class="private-customer-page__heading">Private customer<\/h1>/);
  assert.match(register, /<p class="private-customer-page__intro">Fill in the individual's details below/);
  assert.match(edit, /customer-form-page customer-form-page--private/);
  assert.match(edit, /class="panel panel--compact customer-form-panel(?: customer-form-panel--centered)?"/);
  assert.match(register, /class="inline-form private-customer-form"/);
  assert.match(register, /id="private-customer-form"/);
  assert.match(register, /formId: "private-customer-form"/);
  assert.match(register, /data-address-autocomplete-browser-key="<%= typeof mapBrowserApiKey === 'string' \? mapBrowserApiKey : '' %>"/);
  assert.match(register, /id="addressSearch"/);
  assert.doesNotMatch(register, /<div class="action-row">[\s\S]*Create Customer/);

  assert.match(edit, /contextBarActions:\s*\[/);
  assert.match(edit, /Back to customer list/);
  assert.match(edit, /Save Changes/);
  assert.match(edit, /id="edit-customer-form"/);
  assert.match(edit, /formId: "edit-customer-form"/);
  assert.match(edit, /customer-form-panel customer-form-panel--centered/);
  assert.match(edit, /data-address-autocomplete-browser-key="<%= typeof mapBrowserApiKey === 'string' \? mapBrowserApiKey : '' %>"/);
  assert.match(edit, /id="addressSearch"/);
  assert.match(edit, /id="houseNameNumber"/);
  assert.match(edit, /id="addressLine1"/);
  assert.match(edit, /id="cityTown"/);
  assert.match(edit, /id="postcode"/);
  assert.match(edit, /customer-address-autocomplete\.js/);
  assert.doesNotMatch(edit, /<div class="action-row">[\s\S]*Save Changes/);
});

test("shared context action partial renders only supplied actions with semantic controls", () => {
  const header = read("src/views/partials/header.ejs");
  const actions = read("src/views/partials/context-actions.ejs");
  const customersIndex = read("src/views/pages/customers/index.ejs");
  const css = read("public/css/app.css");
  const siteHeaderAction = extractRuleBody(css, ".site-header__action");
  const systemBarAccountAction = extractRuleBody(css, ".system-status-bar__account-action");
  const operationsAction = extractRuleBody(css, ".operations-menu-prototype__action");
  const compactButton = extractRuleBody(css, ".button--small");
  const paginationLink = extractRuleBody(css, ".pagination-bar__link");
  const workspaceTile = extractRuleBody(css, ".workspace-tile");

  assert.match(header, /headerContextActions\.length > 0/);
  assert.match(actions, /type="submit"/);
  assert.match(actions, /form="<%= action\.formId %>"/);
  assert.match(actions, /href="<%= action\.href \|\| '#' %>"/);
  assert.match(actions, /button--dynamic-cta/);
  assert.doesNotMatch(actions, /button--admin-cta--dynamic|button--admin-cta--system/);
  assert.match(actions, /site-header__action context-bar__action/);
  assert.match(customersIndex, /customers-table__actions-list"/);
  assert.match(customersIndex, /button button--admin-cta button--small.*>View/);
  assert.match(customersIndex, /button button--admin-cta button--small.*>Edit/);
  assert.match(customersIndex, /button--admin-cta button--admin-cta--negative button--small.*>Delete/);
  assert.doesNotMatch(customersIndex, /customers-table__actions-list[\s\S]*button--secondary/);
  assert.doesNotMatch(header, /Switch workspace/);
  assert.doesNotMatch(header, /action="\/exit"/);
  assert.match(css, /--rm-control-height:\s*3rem;/);
  assert.match(css, /--rm-control-height-compact:\s*2\.5rem;/);
  assert.match(css, /--rm-control-padding-inline:\s*1rem;/);
  assert.match(css, /--rm-control-padding-inline-compact:\s*0\.75rem;/);
  assert.match(css, /--rm-control-font-size:\s*0\.95rem;/);
  assert.match(css, /--rm-control-font-size-compact:\s*0\.88rem;/);
  assert.match(css, /--rm-control-border-radius:\s*0\.25rem;/);
  assert.match(css, /--rm-control-focus-color:\s*var\(--rm-dark-cyan\);/);
  assert.match(css, /--rm-dashboard-action-width:\s*190px;/);
  assert.match(css, /--rm-cta-admin-height:\s*var\(--rm-control-height\);/);
  assert.match(css, /--rm-cta-dynamic-height:\s*2\.25rem;/);
  assert.match(css, /--rm-context-bar-min-height:\s*3\.5rem;/);
  assert.match(css, /--rm-context-bar-padding-block:\s*0\.625rem;/);
  assert.match(css, /--rm-cta-system-height:\s*2\.125rem;/);
  assert.match(css, /--rm-admin-cta-bg:\s*#fdf8f2;/);
  assert.match(css, /--rm-admin-cta-bg-hover:\s*var\(--rm-antique-white\);/);
  assert.match(css, /--rm-admin-cta-attention-bg:\s*#fff8e8;/);
  assert.match(css, /--rm-admin-critical-icon:\s*var\(--rm-warning-red\);/);
  assert.match(css, /--rm-admin-warning-icon-size:\s*1\.2rem;/);
  assert.match(css, /--rm-admin-warning-icon:\s*var\(--rm-golden-orange\);/);
  assert.match(css, /--rm-control-border-width:\s*1px;/);
  assert.match(css, /--rm-control-focus-outline:\s*2px solid var\(--rm-control-focus-color\);/);
  assert.match(css, /--rm-control-focus-shadow:\s*0 0 0 3px rgba\(10, 147, 150, 0\.22\);/);
  assert.match(css, /button:focus,[\s\S]*?\.button:focus,[\s\S]*?input\[type="submit"\]:focus,[\s\S]*?\.system-status-bar__account-action:focus,[\s\S]*?\.operations-menu-prototype__action:focus,[\s\S]*?\.pagination-bar__link:focus,[\s\S]*?\.workspace-tile:focus \{/);
  assert.match(css, /\.site-header button,\s*\.site-header a \{[\s\S]*font-family: inherit;/);
  assert.match(siteHeaderAction, /align-items: center;/);
  assert.doesNotMatch(siteHeaderAction, /min-height:/);
  assert.match(systemBarAccountAction, /flex: 0 0 auto;/);
  assert.match(operationsAction, /min-height: var\(--rm-control-height\);/);
  assert.match(operationsAction, /padding: var\(--rm-control-padding-block\) var\(--rm-control-padding-inline\);/);
  assert.match(operationsAction, /flex: 0 0 var\(--rm-dashboard-action-width\);/);
  assert.match(operationsAction, /width: var\(--rm-dashboard-action-width\);/);
  assert.match(operationsAction, /background: var\(--rm-admin-cta-bg\);/);
  assert.match(operationsAction, /color: var\(--rm-admin-cta-text\);/);
  assert.doesNotMatch(operationsAction, /background: var\(--rm-cta-helper-bg\);/);
  assert.match(compactButton, /min-height: var\(--rm-control-height-compact\);/);
  assert.match(compactButton, /font-size: var\(--rm-control-font-size-compact\);/);
  assert.match(paginationLink, /min-width: var\(--rm-control-height-compact\);/);
  assert.match(paginationLink, /min-height: var\(--rm-control-height-compact\);/);
  assert.match(paginationLink, /color: var\(--rm-admin-cta-text\);/);
  assert.match(paginationLink, /font: inherit;/);
  assert.match(paginationLink, /font-size: var\(--rm-control-font-size-compact\);/);
  assert.match(css, /\.pagination-bar__link:not\(\.pagination-bar__link--active\):visited \{[\s\S]*color: var\(--rm-admin-cta-text\);/);
  assert.match(css, /\.pagination-bar__link:not\(\.pagination-bar__link--active\):hover,\s*\.pagination-bar__link:not\(\.pagination-bar__link--active\):focus \{[\s\S]*color: var\(--rm-admin-cta-text\);/);
  assert.match(css, /\.operations-menu-prototype__action--amber \{[\s\S]*background: var\(--rm-admin-cta-attention-bg\);[\s\S]*color: var\(--rm-admin-cta-text\);/);
  assert.match(css, /\.operations-menu-prototype__warning-icon--warning \{[\s\S]*color: var\(--rm-admin-warning-icon\);/);
  assert.match(css, /\.operations-menu-prototype__action--red \{[\s\S]*background: var\(--rm-admin-cta-attention-bg\);/);
  assert.match(css, /\.operations-menu-prototype__warning-icon--critical \{[\s\S]*color: var\(--rm-admin-critical-icon\);/);
  assert.match(css, /\.operations-menu-prototype__status-icon,[\s\S]*width: var\(--rm-admin-warning-icon-size\);/);
  assert.match(css, /\.operations-menu-prototype__action:hover \{[\s\S]*background: var\(--rm-admin-cta-bg-hover\);/);
  assert.match(css, /\.operations-menu-prototype__action:focus \{[\s\S]*color: var\(--rm-admin-action-text\);/);
  assert.match(css, /--rm-cta-execute-bg:\s*var\(--rm-admin-cta-bg\);/);
  assert.match(css, /--rm-cta-negative-bg:\s*#c1121f;/);
  assert.match(css, /--rm-cta-negative-text:\s*#ffe66d;/);
  assert.match(css, /--rm-cta-helper-bg:\s*var\(--rm-admin-cta-bg\);/);
  assert.match(css, /--rm-admin-cta-negative-bg:\s*#fff4f2;/);
  assert.match(css, /\.button--execute,\s*\.button--primary \{[\s\S]*background: var\(--rm-cta-execute-bg\);/);
  assert.match(css, /\.button--execute-negative,\s*\.button--danger \{[\s\S]*background: var\(--rm-cta-negative-bg\);/);
  assert.match(css, /\.button--execute-helper,\s*\.button--secondary \{[\s\S]*background: var\(--rm-cta-helper-bg\);/);
  assert.match(css, /\.button--admin-cta,\s*\.button--dynamic-cta,\s*\.button--system-cta \{[\s\S]*min-height: var\(--rm-cta-admin-height\);[\s\S]*background: var\(--rm-admin-cta-bg\);[\s\S]*color: var\(--rm-admin-cta-text\);/);
  assert.match(css, /\.button--dynamic-cta \{[\s\S]*min-height: var\(--rm-cta-dynamic-height\);/);
  assert.match(css, /\.button--system-cta \{[\s\S]*min-height: var\(--rm-cta-system-height\);/);
  assert.match(css, /\.button--admin-cta\.button--admin-cta--negative,\s*\.button--dynamic-cta\.button--admin-cta--negative,\s*\.button--system-cta\.button--admin-cta--negative \{[\s\S]*background: var\(--rm-admin-cta-negative-bg\);[\s\S]*border-color: var\(--rm-admin-cta-negative-border\);/);
  assert.match(css, /\.button--admin-cta\.button--small,\s*\.button--dynamic-cta\.button--small,\s*\.button--system-cta\.button--small \{[\s\S]*min-height: var\(--rm-control-height-compact\);[\s\S]*font-size: var\(--rm-control-font-size-compact\);/);
  assert.match(workspaceTile, /min-height: 118px;/);
  assert.doesNotMatch(workspaceTile, /min-height: var\(--rm-control-height-compact\);/);
  assert.match(css, /\.customers-table__actions-list \{[\s\S]*display: flex;[\s\S]*flex-wrap: wrap;[\s\S]*gap: var\(--rm-control-gap\);[\s\S]*white-space: normal;/);
  assert.match(css, /\.context-toolbar \.button--dynamic-cta \{[\s\S]*line-height: var\(--rm-control-line-height\);/);
  assert.match(css, /\.customer-register-panel--private > \.private-customer-page__heading \{[\s\S]*font-size: 30px;[\s\S]*line-height: 1\.1;[\s\S]*margin-block: 0 0\.35rem;/);
  assert.match(css, /\.customer-form-page--private \.customer-form-panel > p \{[\s\S]*margin-top: 0;[\s\S]*margin-bottom: 0\.75rem;/);
  assert.match(css, /\.customer-form-panel--centered \{[\s\S]*width: min\(100%, 1040px\);[\s\S]*margin-inline: auto;/);
  assert.match(css, /\.customer-register-panel--private \.private-customer-form \{[\s\S]*margin-top: 0;/);
  assert.match(css, /\.private-customer-form__section-intro \{[\s\S]*color: var\(--rm-text-soft\);/);
  assert.match(css, /\.system-status-bar__account-actions \{[\s\S]*flex-wrap: wrap;[\s\S]*min-width: 0;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.system-status-bar__account-actions \{[\s\S]*justify-content: center;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.context-toolbar--customers \.context-toolbar__right \.button,[\s\S]*?\.context-toolbar--customers \.context-toolbar__right button \{[\s\S]*flex: 1 1 auto;/);
  assert.match(css, /@media \(max-width: 1200px\) \{[\s\S]*\.private-customer-form__grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 1200px\) \{[\s\S]*\.private-customer-form__column--map \{[\s\S]*grid-column: 1 \/ -1;/);
  assert.match(css, /h1,\s*h2,\s*h3 \{[\s\S]*margin-top: 0;/);
  assert.doesNotMatch(css, /\.customer-form-page--private \.customer-form-panel > h1 \{[\s\S]*font-size: clamp\(1\.75rem, 2\.4vw, 2rem\);/);
  assert.match(header, /site-header__action-divider" aria-hidden="true"/);
  assert.match(header, /headerContextActions\.length > 0/);
  assert.doesNotMatch(header, /site-header__action-divider[\s\S]*headerContextActions\.length === 0/);
  assert.doesNotMatch(css, /button--admin-cta--dynamic|button--admin-cta--system/);

  const adminHeight = extractCustomPropertyValue(css, "--rm-cta-admin-height");
  const dynamicHeight = extractCustomPropertyValue(css, "--rm-cta-dynamic-height");
  const systemHeight = extractCustomPropertyValue(css, "--rm-cta-system-height");

  assert.equal(adminHeight, "var(--rm-control-height)");
  assert.equal(dynamicHeight, "2.25rem");
  assert.equal(systemHeight, "2.125rem");
  assert.ok(remToPixels(dynamicHeight) >= remToPixels(systemHeight));
  assert.ok(remToPixels(adminHeight.replace("var(--rm-control-height)", "3rem")) > remToPixels(dynamicHeight));
});

test("customer context toolbar preserves controls and shared sizing", () => {
  const template = read("src/views/partials/header-context/customers-list.ejs");
  const customersIndex = read("src/views/pages/customers/index.ejs");
  const css = read("public/css/app.css");
  const toolbar = extractRuleBody(css, ".context-toolbar");
  const toolbarField = extractRuleBody(css, ".context-toolbar__field");
  const dynamicToolbarControl = css.match(/\.context-toolbar \.button--dynamic-cta\s*\{([^}]*)\}/)?.[1];

  assert.ok(dynamicToolbarControl);
  assert.match(template, /<nav class="context-tabs" aria-label="Customer status filters">/);
  assert.match(template, /id="customers-search"/);
  assert.match(template, /id="customers-per-page"/);
  assert.match(template, /context-toolbar__right[\s\S]*Records per page[\s\S]*customers-per-page[\s\S]*New customer/);
  assert.match(template, /customers-per-page[\s\S]*New customer/);
  assert.match(template, /class="button button--dynamic-cta" href="\/customers\/register">New customer/);
  assert.match(template, /class="context-control--dynamic"/);
  assert.doesNotMatch(template, /button--admin-cta--dynamic|button--admin-cta--system/);
  assert.match(template, /context-toolbar context-toolbar--customers/);
  assert.match(template, /class="context-tab context-tab--dynamic<%= tab\.isActive \? " context-tab--active" : "" %>" href="<%= tab\.href %>"<%= tab\.isActive \? ' aria-current="page"' : "" %>/);
  assert.equal((customersIndex.match(/Administration/g) || []).length, 0);
  assert.doesNotMatch(customersIndex, /context-toolbar[\s\S]*Administration[\s\S]*Customer management/);
  assert.match(css, /\.context-toolbar--customers \.context-tabs \.context-tab\.context-tab--dynamic \{[\s\S]*height: var\(--rm-cta-dynamic-height\);[\s\S]*min-height: var\(--rm-cta-dynamic-height\);/);
  assert.match(css, /\.context-toolbar--customers \.context-tabs \.context-tab\.context-tab--dynamic \{[\s\S]*width: 7\.25rem;[\s\S]*justify-content: center;[\s\S]*text-align: center;/);
  assert.match(css, /\.context-toolbar--customers \.context-tabs \.context-tab\.context-tab--dynamic \{[\s\S]*padding: 0 var\(--rm-cta-dynamic-padding-inline\);[\s\S]*font-size: var\(--rm-cta-dynamic-font-size\);/);
  assert.doesNotMatch(css, /^\s*\.context-tab\.context-tab--dynamic\s*\{[\s\S]*?width:/m);
  assert.match(css, /\.context-tab \{[\s\S]*background: var\(--rm-admin-cta-bg\);[\s\S]*border-radius: var\(--rm-control-border-radius\);/);
  assert.match(css, /--rm-dynamic-active-bg:\s*#fff8e8;/);
  assert.match(css, /--rm-dynamic-active-border:\s*var\(--rm-light-bronze\);/);
  assert.match(css, /--rm-dynamic-active-text:\s*var\(--rm-menu-action-text\);/);
  assert.match(css, /\.context-tab--active \{[\s\S]*background: var\(--rm-dynamic-active-bg\);[\s\S]*border-color: var\(--rm-dynamic-active-border\);[\s\S]*color: var\(--rm-dynamic-active-text\);/);
  assert.doesNotMatch(css, /\.context-tab--active \{[\s\S]*box-shadow: inset 0 -3px/);
  assert.match(css, /\.context-tab:focus-visible \{[\s\S]*outline: var\(--rm-control-focus-outline\);/);
  assert.match(css, /\.context-toolbar input\.context-control--dynamic,\s*\.context-toolbar select\.context-control--dynamic \{[\s\S]*min-height: var\(--rm-cta-dynamic-height\);[\s\S]*padding: 0 var\(--rm-cta-dynamic-padding-inline\);/);
  assert.match(css, /\.context-toolbar input\.context-control--dynamic,\s*\.context-toolbar select\.context-control--dynamic \{[\s\S]*background: var\(--rm-admin-cta-bg\);[\s\S]*border-color: var\(--rm-admin-cta-border\);/);
  assert.match(css, /\.context-toolbar \.button--dynamic-cta \{[\s\S]*line-height: var\(--rm-control-line-height\);[\s\S]*width: auto;/);
  assert.doesNotMatch(dynamicToolbarControl, /width:\s*(?:7\.25rem|6rem)/);
  assert.match(toolbarField, /display: grid;/);
  assert.match(toolbarField, /align-items: center;/);
  assert.match(toolbar, /display: flex;/);
  assert.match(css, /\.context-toolbar__form \{[\s\S]*display: grid;[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*gap: 0\.75rem;/);
  assert.match(css, /\.context-toolbar \{[\s\S]*display: flex;[\s\S]*align-items: center;[\s\S]*min-height: var\(--rm-context-bar-min-height\);[\s\S]*padding-block: var\(--rm-context-bar-padding-block\);/);
  assert.match(css, /\.site-header__inner \{[\s\S]*display: flex;[\s\S]*align-items: center;[\s\S]*min-height: var\(--rm-context-bar-min-height\);[\s\S]*padding-block: var\(--rm-context-bar-padding-block\);/);
  assert.match(css, /\.context-toolbar__right \{[\s\S]*justify-content: flex-end;[\s\S]*white-space: nowrap;/);
  assert.match(css, /\.context-toolbar__left,\s*\.context-toolbar__right,\s*\.context-toolbar__actions \{[\s\S]*gap: var\(--rm-control-gap\);[\s\S]*align-items: center;/);
  assert.match(css, /\.context-toolbar--customers \.context-tabs \{[\s\S]*flex: 0 0 auto;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.context-toolbar--customers \.context-tabs \.context-tab\.context-tab--dynamic \{[\s\S]*width: 6rem;/);
  assert.match(css, /\.context-toolbar--customers \.context-toolbar__left \{[\s\S]*flex-wrap: nowrap;/);
  assert.match(css, /\.context-toolbar--customers \.context-toolbar__field \{[\s\S]*flex: 1 1 18rem;/);
  assert.match(css, /\.context-toolbar--customers \.context-toolbar__right > \.button \{[\s\S]*flex: 0 0 auto;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.context-toolbar__field label \{[\s\S]*margin-bottom: 0;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.context-toolbar--customers \.context-toolbar__form \{[\s\S]*grid-template-columns: 1fr;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.site-header__inner \{[\s\S]*display: grid;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.context-toolbar__right \{[\s\S]*white-space: normal;/);
  assert.doesNotMatch(dynamicToolbarControl, /min-height:\s*40px/);
});

test("shared header keeps one system bar and no legacy navigation rows", () => {
  const baseLayout = read("src/views/layouts/base.ejs");
  const header = read("src/views/partials/header.ejs");
  const css = read("public/css/app.css");

  assert.equal((baseLayout.match(/system-status-bar/g) || []).length, 1);
  assert.doesNotMatch(header, /module-bar|module bar|breadcrumb/i);
  assert.doesNotMatch(css, /module-bar|breadcrumb/i);
  assert.equal((header.match(/context-toolbar/g) || []).length, 0);
  assert.match(header, /contextBarPartial/);
  assert.match(css, /\.context-toolbar \{[\s\S]*min-height: var\(--rm-context-bar-min-height\);/);
});
