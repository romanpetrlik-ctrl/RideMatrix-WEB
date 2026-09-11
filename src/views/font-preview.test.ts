import assert from "node:assert/strict";
import ejs from "ejs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

async function render(file: string, data: Record<string, unknown>) {
  return ejs.renderFile(path.join(root, file), data);
}

test("head and stylesheet permanently load Open Sans for body text and Lato for h1/h2", () => {
  const head = read("src/views/partials/head.ejs");
  const css = read("public/css/app.css");

  assert.match(head, /family=Lato:wght@400;700&family=Open\+Sans:wght@400;600;700&display=swap/);
  assert.doesNotMatch(head, /fontPreview/);
  assert.match(css, /^\s*@import url\("https:\/\/fonts.googleapis.com\/css2\?family=Lato:wght@400;700&display=swap"\);/);
  assert.ok(
    css.indexOf('@import url("https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap");') <
      css.indexOf(":root {")
  );
  assert.match(css, /--rm-font-sans: "Open Sans", Arial, Helvetica, sans-serif;/);
  assert.match(css, /html \{[\s\S]*font-family: var\(--rm-font-sans\);/);
  assert.match(css, /body \{[\s\S]*font-family: inherit;/);
  assert.match(css, /h1,\s*h2 \{[\s\S]*font-family: "Lato", Arial, Helvetica, sans-serif;[\s\S]*font-weight: 700;/);
  assert.match(
    css,
    /\.customer-register-panel--private > \.private-customer-page__heading \{[\s\S]*font-size: 30px;[\s\S]*line-height: 1\.1;[\s\S]*margin-block: 0 0\.35rem;/
  );
  assert.doesNotMatch(css, /font-preview--lato-headings/);
  assert.doesNotMatch(css, /\bRoboto\b|\bInter\b|Roboto\+Condensed/);
});

test("customer routes and templates no longer contain font preview plumbing", () => {
  const register = read("src/views/pages/customers/register.ejs");
  const edit = read("src/views/pages/customers/edit.ejs");
  const routes = read("src/routes/customers.ts");

  assert.doesNotMatch(register, /fontPreview|font-preview--lato-headings/);
  assert.doesNotMatch(edit, /fontPreview|font-preview--lato-headings/);
  assert.doesNotMatch(routes, /req\.query\.fontPreview|fontPreview:/);
});

test("customer register template renders without a fontPreview view model", async () => {
  const register = await render("src/views/pages/customers/register.ejs", {
    title: "New Customer",
    appTitle: "RideMatrix Test",
    email: "admin@example.com",
    activeRoleLabel: "Administration",
    customerType: "private",
    formData: {},
    errors: [],
    csrfField: ""
  });

  assert.match(register, /family=Lato:wght@400;700&family=Open\+Sans:wght@400;600;700&display=swap/);
  assert.match(register, /<body>/);
  assert.doesNotMatch(register, /font-preview--lato-headings/);
  assert.doesNotMatch(register, /\bRoboto\b|\bInter\b|Roboto\+Condensed/);
});
