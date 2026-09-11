import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("Lato headings preview is opt-in and scoped to customer form pages", () => {
  const head = read("src/views/partials/head.ejs");
  const register = read("src/views/pages/customers/register.ejs");
  const edit = read("src/views/pages/customers/edit.ejs");
  const css = read("public/css/app.css");
  const routes = read("src/routes/customers.ts");

  assert.match(head, /typeof fontPreview !== "undefined" && fontPreview === "lato-headings"/);
  assert.match(head, /family=Lato:wght@400;700/);
  assert.match(head, /family=Open\+Sans:wght@400;600;700/);
  assert.match(register, /font-preview--lato-headings/);
  assert.match(edit, /font-preview--lato-headings/);
  assert.match(routes, /fontPreview: String\(req\.query\.fontPreview \|\| ""\)/);
  assert.match(css, /body\.font-preview--lato-headings \{\s*font-family: "Open Sans"/);
  assert.match(css, /body\.font-preview--lato-headings h1,\s*body\.font-preview--lato-headings h2 \{\s*font-family: "Lato"/);
  assert.match(css, /body\.font-preview--lato-headings button,\s*body\.font-preview--lato-headings input,\s*body\.font-preview--lato-headings select,\s*body\.font-preview--lato-headings textarea \{\s*font-family: "Open Sans"/);
  assert.doesNotMatch(css, /body\.font-preview--lato-headings[^}]*font-size/);
  assert.doesNotMatch(head, /Roboto|Inter|Roboto\+Condensed/);
});
