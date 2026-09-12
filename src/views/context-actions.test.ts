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
  const css = read("public/css/app.css");
  const siteHeaderAction = extractRuleBody(css, ".site-header__action");
  const contextBarDangerAction = extractRuleBody(css, ".context-bar__action--danger");

  assert.match(header, /headerContextActions\.length > 0/);
  assert.match(actions, /type="submit"/);
  assert.match(actions, /form="<%= action\.formId %>"/);
  assert.match(actions, /href="<%= action\.href \|\| '#' %>"/);
  assert.match(actions, /site-header__action context-bar__action/);
  assert.doesNotMatch(header, /Switch workspace/);
  assert.doesNotMatch(header, /action="\/exit"/);
  assert.match(css, /--rm-control-height:\s*3rem;/);
  assert.match(css, /--rm-control-padding-inline:\s*1rem;/);
  assert.match(css, /--rm-control-font-size:\s*0\.95rem;/);
  assert.match(css, /--rm-control-border-width:\s*1px;/);
  assert.match(css, /--rm-control-focus-outline:\s*2px solid var\(--rm-dark-cyan\);/);
  assert.match(css, /button:focus,\s*\.button:focus,\s*\.system-status-bar__account-action:focus,\s*input\[type="submit"\]:focus \{/);
  assert.match(siteHeaderAction, /height: var\(--rm-control-height\);/);
  assert.match(siteHeaderAction, /align-items: center;/);
  assert.match(contextBarDangerAction, /border-color: var\(--rm-golden-orange\);/);
  assert.match(css, /\.customer-register-panel--private > \.private-customer-page__heading \{[\s\S]*font-size: 30px;[\s\S]*line-height: 1\.1;[\s\S]*margin-block: 0 0\.35rem;/);
  assert.match(css, /\.customer-form-page--private \.customer-form-panel > p \{[\s\S]*margin-top: 0;[\s\S]*margin-bottom: 0\.75rem;/);
  assert.match(css, /\.customer-register-panel--private \.private-customer-form \{[\s\S]*margin-top: 0;/);
  assert.match(css, /\.system-status-bar__account-actions \{[\s\S]*flex-wrap: wrap;[\s\S]*min-width: 0;/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*\.system-status-bar__account-actions \{[\s\S]*justify-content: center;/);
  assert.match(css, /h1,\s*h2,\s*h3 \{[\s\S]*margin-top: 0;/);
  assert.doesNotMatch(css, /\.customer-form-page--private \.customer-form-panel > h1 \{[\s\S]*font-size: clamp\(1\.75rem, 2\.4vw, 2rem\);/);
  assert.match(header, /site-header__action-divider" aria-hidden="true"/);
  assert.match(header, /headerContextActions\.length > 0/);
  assert.doesNotMatch(header, /site-header__action-divider[\s\S]*headerContextActions\.length === 0/);
});
