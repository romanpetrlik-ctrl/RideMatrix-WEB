import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("customer list progressively enhances View links with an accessible dialog", () => {
  const index = read("src/views/pages/customers/index.ejs");
  const script = read("public/js/customer-detail-modal.js");

  assert.match(index, /data-customer-detail-trigger/);
  assert.match(index, /<dialog[^>]+data-customer-detail-modal/);
  assert.match(index, /aria-labelledby="customer-detail-modal-title"/);
  assert.match(script, /showModal\(\)/);
  assert.match(script, /addEventListener\("cancel"/);
  assert.match(script, /\.focus\(\)/);
});

test("customer detail keeps a home address map area and readable context actions", () => {
  const detail = read("src/views/pages/customers/detail.ejs");
  const content = read("src/views/partials/customer-detail-content.ejs");
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
  assert.match(content, /class="button button--secondary" href="<%= customer\.telHref %>">Call/);
  assert.match(content, /class="button button--secondary" href="<%= customer\.whatsappHref %>" target="_blank" rel="noopener noreferrer">Send WhatsApp message/);
});
