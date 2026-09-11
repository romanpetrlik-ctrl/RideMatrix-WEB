import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("customer registration and edit actions are supplied by the dynamic bar", () => {
  const register = read("src/views/pages/customers/register.ejs");
  const edit = read("src/views/pages/customers/edit.ejs");

  assert.match(register, /contextBarActions:\s*\[/);
  assert.match(register, /Back to customer type/);
  assert.match(register, /Cancel/);
  assert.match(register, /Create Customer/);
  assert.doesNotMatch(register, /hintsLabel:\s*"Registration"/);
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

  assert.match(header, /headerContextActions\.length > 0/);
  assert.match(actions, /type="submit"/);
  assert.match(actions, /form="<%= action\.formId %>"/);
  assert.match(actions, /href="<%= action\.href \|\| '#' %>"/);
  assert.match(header, /site-header__action-divider" aria-hidden="true"/);
  assert.match(header, /headerContextActions\.length > 0/);
  assert.doesNotMatch(header, /site-header__action-divider[\s\S]*headerContextActions\.length === 0/);
});
