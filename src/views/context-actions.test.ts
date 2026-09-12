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
  assert.match(edit, /class="panel panel--compact customer-form-panel"/);
  assert.match(register, /class="inline-form private-customer-form"/);
  assert.match(register, /id="private-customer-form"/);
  assert.match(register, /formId: "private-customer-form"/);
  assert.doesNotMatch(register, /<div class="action-row">[\s\S]*Create Customer/);

  assert.match(edit, /contextBarActions:\s*\[/);
  assert.match(edit, /Back to customer list/);
  assert.match(edit, /Save Changes/);
  assert.match(edit, /id="edit-customer-form"/);
  assert.match(edit, /formId: "edit-customer-form"/);
  assert.doesNotMatch(edit, /<div class="action-row">[\s\S]*Save Changes/);
});

test("shared context action partial renders only supplied actions with semantic controls", () => {
  const header = read("src/views/partials/header.ejs");
  const actions = read("src/views/partials/context-actions.ejs");
  const customersIndex = read("src/views/pages/customers/index.ejs");
  const css = read("public/css/app.css");
  const siteHeaderAction = extractRuleBody(css, ".site-header__action");
  const contextBarDangerAction = extractRuleBody(css, ".context-bar__action--danger");
  const systemBarAccountAction = extractRuleBody(css, ".system-status-bar__account-action");
  const operationsAction = extractRuleBody(css, ".operations-menu-prototype__action");
  const compactButton = extractRuleBody(css, ".button--small");
  const paginationLink = extractRuleBody(css, ".pagination-bar__link");
  const workspaceTile = extractRuleBody(css, ".workspace-tile");

  assert.match(header, /headerContextActions\.length > 0/);
  assert.match(actions, /type="submit"/);
  assert.match(actions, /form="<%= action\.formId %>"/);
  assert.match(actions, /href="<%= action\.href \|\| '#' %>"/);
  assert.match(actions, /site-header__action context-bar__action/);
  assert.match(customersIndex, /customers-table__actions-list"/);
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
  assert.match(css, /--rm-control-border-width:\s*1px;/);
  assert.match(css, /--rm-control-focus-outline:\s*2px solid var\(--rm-control-focus-color\);/);
  assert.match(css, /--rm-control-focus-shadow:\s*0 0 0 3px rgba\(10, 147, 150, 0\.22\);/);
  assert.match(css, /button:focus,[\s\S]*?\.button:focus,[\s\S]*?input\[type="submit"\]:focus,[\s\S]*?\.system-status-bar__account-action:focus,[\s\S]*?\.operations-menu-prototype__action:focus,[\s\S]*?\.pagination-bar__link:focus,[\s\S]*?\.workspace-tile:focus \{/);
  assert.match(siteHeaderAction, /min-height: var\(--rm-control-height\);/);
  assert.match(siteHeaderAction, /padding: var\(--rm-control-padding-block\) var\(--rm-control-padding-inline\);/);
  assert.match(siteHeaderAction, /align-items: center;/);
  assert.match(systemBarAccountAction, /min-height: var\(--rm-control-height\);/);
  assert.match(systemBarAccountAction, /font-size: var\(--rm-control-font-size\);/);
  assert.match(operationsAction, /min-height: var\(--rm-control-height\);/);
  assert.match(operationsAction, /padding: var\(--rm-control-padding-block\) var\(--rm-control-padding-inline\);/);
  assert.match(operationsAction, /flex: 0 0 var\(--rm-dashboard-action-width\);/);
  assert.match(operationsAction, /width: var\(--rm-dashboard-action-width\);/);
  assert.match(compactButton, /min-height: var\(--rm-control-height-compact\);/);
  assert.match(compactButton, /font-size: var\(--rm-control-font-size-compact\);/);
  assert.match(paginationLink, /min-width: var\(--rm-control-height-compact\);/);
  assert.match(paginationLink, /min-height: var\(--rm-control-height-compact\);/);
  assert.match(paginationLink, /color: var\(--rm-walnut-3\);/);
  assert.match(paginationLink, /font: inherit;/);
  assert.match(paginationLink, /font-size: var\(--rm-control-font-size-compact\);/);
  assert.match(css, /\.pagination-bar__link:not\(\.pagination-bar__link--active\):visited \{[\s\S]*color: var\(--rm-walnut-3\);/);
  assert.match(css, /\.pagination-bar__link:not\(\.pagination-bar__link--active\):hover,\s*\.pagination-bar__link:not\(\.pagination-bar__link--active\):focus \{[\s\S]*color: var\(--rm-walnut\);/);
  assert.match(contextBarDangerAction, /border-color: var\(--rm-golden-orange\);/);
  assert.match(css, /\.operations-menu-prototype__action--amber \{[\s\S]*border-bottom-color: var\(--rm-golden-orange\);/);
  assert.match(css, /\.operations-menu-prototype__action--red \{[\s\S]*border-bottom-color: var\(--rm-oxidized-iron\);/);
  assert.match(css, /\.button--danger \{[\s\S]*border-color: var\(--rm-brown-red\);/);
  assert.match(workspaceTile, /min-height: 118px;/);
  assert.doesNotMatch(workspaceTile, /min-height: var\(--rm-control-height-compact\);/);
  assert.match(css, /\.customers-table__actions-list \{[\s\S]*display: flex;[\s\S]*flex-wrap: wrap;[\s\S]*gap: var\(--rm-control-gap\);[\s\S]*white-space: normal;/);
  assert.match(css, /\.context-toolbar \.button:not\(\.button--small\),/);
  assert.match(css, /\.context-toolbar button:not\(\.button--small\),/);
  assert.match(css, /\.context-toolbar input\[type="submit"\]:not\(\.button--small\) \{[\s\S]*min-height: var\(--rm-control-height\);/);
  assert.match(css, /\.context-toolbar \.button--small,/);
  assert.match(css, /\.context-toolbar button\.button--small,/);
  assert.match(css, /\.context-toolbar input\[type="submit"\]\.button--small \{[\s\S]*min-height: var\(--rm-control-height-compact\);/);
  assert.match(css, /\.customer-register-panel--private > \.private-customer-page__heading \{[\s\S]*font-size: 30px;[\s\S]*line-height: 1\.1;[\s\S]*margin-block: 0 0\.35rem;/);
  assert.match(css, /\.customer-form-page--private \.customer-form-panel > p \{[\s\S]*margin-top: 0;[\s\S]*margin-bottom: 0\.75rem;/);
  assert.match(css, /\.customer-register-panel--private \.private-customer-form \{[\s\S]*margin-top: 0;/);
  assert.match(css, /\.system-status-bar__account-actions \{[\s\S]*flex-wrap: wrap;[\s\S]*min-width: 0;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.system-status-bar__account-actions \{[\s\S]*justify-content: center;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.context-toolbar \.button,[\s\S]*?\.context-toolbar button \{[\s\S]*flex: 1 1 auto;/);
  assert.match(css, /h1,\s*h2,\s*h3 \{[\s\S]*margin-top: 0;/);
  assert.doesNotMatch(css, /\.customer-form-page--private \.customer-form-panel > h1 \{[\s\S]*font-size: clamp\(1\.75rem, 2\.4vw, 2rem\);/);
  assert.match(header, /site-header__action-divider" aria-hidden="true"/);
  assert.match(header, /headerContextActions\.length > 0/);
  assert.doesNotMatch(header, /site-header__action-divider[\s\S]*headerContextActions\.length === 0/);
});

test("customer context toolbar preserves controls and shared sizing", () => {
  const template = read("src/views/partials/header-context/customers-list.ejs");
  const css = read("public/css/app.css");
  const toolbar = extractRuleBody(css, ".context-toolbar");
  const toolbarField = extractRuleBody(css, ".context-toolbar__field");
  const toolbarControls = css.match(/\.context-toolbar \.button:not\(\.button--small\),[\s\S]*?\.context-toolbar input\[type="submit"\]:not\(\.button--small\)\s*\{([^}]*)\}/)?.[1];

  assert.ok(toolbarControls);
  assert.match(template, /<nav class="context-tabs" aria-label="Customer status filters">/);
  assert.match(template, /id="customers-search"/);
  assert.match(template, /id="customers-per-page"/);
  assert.match(template, /class="button button--primary" href="\/customers\/register">New customer/);
  assert.match(css, /\.context-tab \{[\s\S]*height: var\(--rm-control-height\);[\s\S]*min-height: var\(--rm-control-height\);/);
  assert.match(css, /\.context-toolbar input,\s*\.context-toolbar select \{[\s\S]*min-height: var\(--rm-control-height\);[\s\S]*padding: 0 var\(--rm-control-padding-inline\);/);
  assert.match(css, /\.context-toolbar \.button:not\(\.button--small\),[\s\S]*?\.context-toolbar input\[type="submit"\]:not\(\.button--small\) \{[\s\S]*min-height: var\(--rm-control-height\);[\s\S]*padding: var\(--rm-control-padding-block\) var\(--rm-control-padding-inline\);/);
  assert.match(toolbarField, /display: grid;/);
  assert.match(toolbarField, /align-items: center;/);
  assert.match(toolbar, /flex-wrap: wrap;/);
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.context-toolbar__field label \{[\s\S]*margin-bottom: 0;/);
  assert.doesNotMatch(toolbarControls, /min-height:\s*40px/);
});
