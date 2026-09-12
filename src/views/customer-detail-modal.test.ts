import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("customer list opens the normal detail page in a new tab", () => {
  const index = read("src/views/pages/customers/index.ejs");

  assert.doesNotMatch(index, /data-customer-detail-modal|data-customer-detail-trigger/);
  assert.match(index, /class="customer-table__identity" href="<%= customer\.detailHref %>" target="_blank" rel="noopener noreferrer"/);
  assert.match(index, /href="<%= customer\.detailHref %>" target="_blank" rel="noopener noreferrer">View<\/a>/);
});

test("customer detail keeps a home address map area and readable context actions", () => {
  const detail = read("src/views/pages/customers/detail.ejs");
  const content = read("src/views/partials/customer-detail-content.ejs");
  const context = read("src/views/partials/header-context/customer-detail.ejs");
  const css = read("public/css/app.css");

  assert.match(detail, /customer-detail-content/);
  assert.match(content, /class="customer-detail-layout"/);
  assert.match(content, /class="customer-detail-layout__information"/);
  assert.match(content, /<aside class="panel customer-detail-layout__map"/);
  assert.match(content, /mapView,/);
  assert.match(content, /Home address map/);
  assert.match(content, /map-preview/);
  assert.match(css, /grid-template-columns: minmax\(0, 3fr\) minmax\(16rem, 1fr\)/);
  assert.match(css, /\.customer-detail-layout \{[\s\S]*?align-items: stretch;/);
  assert.match(css, /\.customer-detail-layout > \* \{[\s\S]*?height: 100%;/);
  assert.match(css, /\.customer-detail-layout__map \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
  assert.match(css, /\.customer-detail-layout__map \.address-map-preview,[\s\S]*?\.address-map-placeholder \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?grid-template-columns: 1fr/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.customer-detail-layout > \* \{[\s\S]*?height: auto;/);
  assert.match(css, /\.site-header \.context-bar__action,[\s\S]*?\.site-header \.context-bar__action:visited,[\s\S]*?\.site-header \.context-bar__action:hover,[\s\S]*?\.site-header \.context-bar__action:focus \{[\s\S]*?color: var\(--rm-antique-white\);/);
  assert.match(css, /\.site-header \.context-toolbar \.button,[\s\S]*?\.site-header \.context-toolbar \.button:visited,[\s\S]*?\.site-header \.context-toolbar \.button:hover,[\s\S]*?\.site-header \.context-toolbar \.button:focus \{[\s\S]*?color: var\(--rm-antique-white\);/);
  for (const label of ["Call", "Send WhatsApp message", "Send Email", "Edit Customer", "Suspend Customer", "Delete Record", "Back to Customers"]) {
    assert.match(context, new RegExp(`>${label}<`));
  }
  assert.match(content, /class="button button--secondary" href="<%= customer\.telHref %>">Call/);
  assert.match(content, /class="button button--secondary" href="<%= customer\.whatsappHref %>" target="_blank" rel="noopener noreferrer">Send WhatsApp message/);
});
