import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("customer list opens the normal detail page in a new tab", () => {
  const index = read("src/views/pages/customers/index.ejs");

  assert.doesNotMatch(index, /data-customer-detail-modal|data-customer-detail-trigger/);
  assert.match(index, /class="customer-table__identity" data-customer-detail-link href="<%= customer\.detailHref %>" target="_blank" rel="opener"/);
  assert.match(index, /data-customer-detail-link href="<%= customer\.detailHref %>" target="_blank" rel="opener">View<\/a>/);
});

test("customer detail links explicitly request the child-window layout", () => {
  const customersRoute = read("src/routes/customers.ts");
  const systemBar = read("src/views/partials/system-status-bar.ejs");

  assert.match(customersRoute, /layout: "child"/);
  assert.match(systemBar, /if \(!Boolean\(locals\.isChildWindow\)\)/);
  assert.doesNotMatch(systemBar, /display:\s*none/);
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
  assert.match(css, /\.site-header \.context-bar__action\.button--admin-cta,[\s\S]*?color: var\(--rm-admin-cta-text\);/);
  assert.doesNotMatch(css, /\.site-header \.context-toolbar \.button,[\s\S]*?color: var\(--rm-antique-white\);/);
  for (const label of ["Call", "Send WhatsApp message", "Send Email", "Edit Customer", "Suspend Customer", "Delete Record", "Close window"]) {
    assert.match(context, new RegExp(`>${label}<`));
  }
  assert.doesNotMatch(context, />Back to Customers</);
  assert.match(context, /data-close-detail-window/);
  assert.match(read("public/js/customer-window-coordination.js"), /event\.origin !== origin/);
  assert.match(read("public/js/customer-window-coordination.js"), /event\.source/);
  assert.match(content, /class="button button--secondary" href="<%= customer\.telHref %>">Call/);
  assert.match(content, /class="button button--secondary" href="<%= customer\.whatsappHref %>" target="_blank" rel="noopener noreferrer">Send WhatsApp message/);
  assert.match(context, /class="button button--admin-cta" href="<%= customer\.newBookingHref %>">New Booking/);
  assert.match(context, /class="button button--admin-cta button--admin-cta--negative" href="<%= customer\.deleteHref %>">Delete Record/);
});

test("customer detail map receives browser configuration and map id", () => {
  const detail = read("src/views/pages/customers/detail.ejs");
  const partial = read("src/views/partials/customer-detail-content.ejs");
  const map = read("src/views/partials/map-preview.ejs");
  const route = read("src/routes/customers.ts");

  assert.match(route, /mapBrowserApiKey: readMapConfiguration\(\)\.browserApiKey/);
  assert.match(route, /mapId: readMapConfiguration\(\)\.mapId/);
  assert.match(detail, /mapBrowserApiKey, mapId/);
  assert.match(partial, /mapBrowserApiKey,/);
  assert.match(partial, /mapId,/);
  assert.match(map, /data-map-browser-key="<%= typeof mapBrowserApiKey === 'string' \? mapBrowserApiKey : '' %>"/);
  assert.match(map, /data-map-id="<%= typeof mapId === 'string' \? mapId : '' %>"/);
});

test("customer edit uses server-rendered customer-specific action URLs and preserves child layout", () => {
  const edit = read("src/views/pages/customers/edit.ejs");
  const route = read("src/routes/customers.ts");

  assert.match(edit, /href: cancelHref/);
  assert.match(edit, /action="<%= editActionHref %>"/);
  assert.doesNotMatch(edit, /<%= customer\.id %>\/edit\?returnTo=/);
  assert.match(route, /editActionHref/);
  assert.match(route, /isChildWindowLayout\(req\.query\.layout\)/);
});
