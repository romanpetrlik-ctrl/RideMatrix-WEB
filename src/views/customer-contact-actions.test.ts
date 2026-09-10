import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

test("registration and edit forms share a full-width contact actions partial", () => {
  const register = read("src/views/pages/customers/register.ejs");
  const edit = read("src/views/pages/customers/edit.ejs");
  const actions = read("src/views/partials/customer-contact-actions.ejs");

  assert.match(register, /form-row--contact[\s\S]*?<\/div>\s*<%- include\("\.\.\/\.\.\/partials\/customer-contact-actions"\) %>/);
  assert.match(edit, /form-row--contact[\s\S]*?<\/div>\s*<%- include\("\.\.\/\.\.\/partials\/customer-contact-actions"\) %>/);
  assert.doesNotMatch(read("src/views/partials/phone-number.ejs"), /data-phone-actions/);
  assert.match(actions, /data-phone-email/);
  assert.match(actions, /data-phone-tel/);
  assert.match(actions, /data-phone-whatsapp/);
});

test("phone actions are resolved from the shared form-level container", () => {
  const phoneScript = read("public/js/phone-number.js");

  assert.match(phoneScript, /form && form\.querySelector\("\[data-phone-actions\]"\)/);
  assert.match(phoneScript, /email\.hidden = !validEmail/);
  assert.match(phoneScript, /tel\.hidden = !validPhone/);
  assert.match(phoneScript, /whatsapp\.hidden = !validPhone/);
  assert.match(phoneScript, /email\.removeAttribute\("href"\)/);
  assert.match(phoneScript, /tel\.removeAttribute\("href"\)/);
  assert.match(phoneScript, /whatsapp\.removeAttribute\("href"\)/);
});
