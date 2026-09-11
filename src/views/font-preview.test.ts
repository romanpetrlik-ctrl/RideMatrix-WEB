import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("Variant B preview is opt-in and scoped to customer form pages", () => {
  const head = read("src/views/partials/head.ejs");
  const register = read("src/views/pages/customers/register.ejs");
  const edit = read("src/views/pages/customers/edit.ejs");
  const css = read("public/css/app.css");
  const routes = read("src/routes/customers.ts");

  assert.match(head, /typeof fontPreview !== "undefined" && fontPreview === "roboto-condensed"/);
  assert.match(head, /family=Roboto\+Condensed:wght@400;500;700/);
  assert.match(head, /family=Open\+Sans:wght@400;600;700/);
  assert.match(register, /font-preview--variant-b/);
  assert.match(edit, /font-preview--variant-b/);
  assert.match(routes, /fontPreview: String\(req\.query\.fontPreview \|\| ""\)/);
  assert.match(css, /body\.font-preview--variant-b \{\s*font-family: "Open Sans"/);
  assert.match(css, /body\.font-preview--variant-b h1,\s*body\.font-preview--variant-b h2 \{\s*font-family: "Roboto Condensed"/);
  assert.match(css, /body\.font-preview--variant-b button,\s*body\.font-preview--variant-b input,\s*body\.font-preview--variant-b select,\s*body\.font-preview--variant-b textarea \{\s*font-family: inherit;/);
  assert.doesNotMatch(css, /body\.font-preview--variant-b[^}]*font-size/);
});
