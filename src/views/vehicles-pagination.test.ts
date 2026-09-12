import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const vehiclePagination = fs.readFileSync("src/views/partials/vehicles-pagination.ejs", "utf8");
const customerPagination = fs.readFileSync("src/views/partials/customers-pagination.ejs", "utf8");
const css = fs.readFileSync("public/css/app.css", "utf8");

test("vehicle pagination uses the shared link classes and preserves navigation parameters", () => {
  assert.match(vehiclePagination, /<a class="pagination-bar__link" href="\/vehicles\?q=<%= encodeURIComponent\(search\) %>&page=<%= page - 1 %>">Previous<\/a>/);
  assert.match(vehiclePagination, /<a class="pagination-bar__link<%= n === page \? ' pagination-bar__link--active' : '' %>" href="\/vehicles\?q=<%= encodeURIComponent\(search\) %>&page=<%= n %>" aria-current="<%= n === page \? 'page' : 'false' %>"><%= n %><\/a>/);
  assert.match(vehiclePagination, /<a class="pagination-bar__link" href="\/vehicles\?q=<%= encodeURIComponent\(search\) %>&page=<%= page \+ 1 %>">Next<\/a>/);
  assert.doesNotMatch(vehiclePagination, /is-active/);
  assert.match(vehiclePagination, /if \(page > 1\)/);
  assert.match(vehiclePagination, /if \(page < totalPages\)/);
  assert.match(vehiclePagination, /aria-current="<%= n === page \? 'page' : 'false' %>"/);
});

test("customer pagination uses the same active-state convention", () => {
  assert.match(customerPagination, /class="pagination-bar__link<%= pageLink\.isActive \? " pagination-bar__link--active" : "" %>"/);
  assert.match(customerPagination, /aria-current="<%= pageLink\.isActive \? "page" : "false" %>"/);
  assert.doesNotMatch(customerPagination, /is-active/);
});

test("shared pagination CSS keeps compact dimensions and active-state precedence", () => {
  const linkRule = css.match(/\.pagination-bar__link\s*\{([^}]*)\}/)?.[1];
  assert.ok(linkRule);
  assert.match(linkRule, /min-width: var\(--rm-control-height-compact\)/);
  assert.match(linkRule, /min-height: var\(--rm-control-height-compact\)/);
  assert.match(linkRule, /padding: var\(--rm-control-padding-block-compact\) var\(--rm-control-padding-inline-compact\)/);
  assert.match(linkRule, /border: var\(--rm-control-border-width\) solid var\(--rm-light-bronze\)/);
  assert.match(linkRule, /background: rgba\(255, 255, 255, 0\.55\)/);
  assert.match(linkRule, /font-size: var\(--rm-control-font-size-compact\)/);
  assert.match(css, /\.pagination-bar__link:not\(\.pagination-bar__link--active\):visited\s*\{[\s\S]*?color: var\(--rm-walnut-3\)/);
  assert.match(css, /\.pagination-bar__link:not\(\.pagination-bar__link--active\):hover,\s*\.pagination-bar__link:not\(\.pagination-bar__link--active\):focus\s*\{[\s\S]*?color: var\(--rm-walnut\)/);
  assert.match(css, /\.pagination-bar__link--active\s*\{[\s\S]*?background: var\(--rm-camel\)[\s\S]*?border-color: var\(--rm-faded-copper\)[\s\S]*?color: var\(--rm-antique-white\)/);
  assert.match(css, /\.pagination-bar__link:focus,/);
});
