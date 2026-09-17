import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

const root = process.cwd();
const viewports = [1920, 1600, 1440, 1280, 1024, 820, 390];
const routes = [
  "/choose-role",
  "/dashboard",
  "/customers/register",
  "/customers/edit",
  "/customers/detail",
  "/staff",
  "/vehicles"
];

function edgeSpace(width: number): number {
  return Math.max(16, Math.min(width * 0.02, 48));
}

function pageMarkup(route: string): string {
  const page = route.includes("choose-role")
    ? '<section class="dashboard-layout"><div class="workspace-tile-grid"></div></section>'
    : route === "/dashboard"
      ? '<section class="dashboard-hero"></section><section class="operations-menu-prototype"><div class="operations-menu-prototype__actions"><button>Action</button><button>Another action</button></div></section>'
      : route.includes("customers")
        ? '<section class="customer-form-panel--centered"><form class="private-customer-form"><div class="private-customer-form__grid"><div></div><div></div><div class="private-customer-form__column--map"></div></div></form></section><div class="customer-detail-layout"><div class="customer-detail-list"><div class="phone-number-actions"><button>Call</button></div></div></div><div class="customers-table-wrapper"><table class="customers-table"><tr><td>Customer</td></tr></table></div>'
        : route === "/staff"
          ? '<div class="staff-table-wrapper"><table class="staff-table"><tr><td>Staff</td></tr></table></div>'
          : '<div class="vehicle-table-wrapper"><table class="vehicle-table"><tr><td>Vehicle</td></tr></table></div>';

  return `<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><link rel="stylesheet" href="/css/app.css"></head>
      <body>
        <div class="system-status-bar"><div class="container rm-page-shell system-status-bar__inner"><span>Healthy</span></div></div>
        <header class="site-header">
          <div class="container rm-page-shell site-header__inner"><span>Actions</span></div>
          <div class="container rm-page-shell site-header__context"><span>Context</span></div>
        </header>
        <main class="container rm-page-shell">${page}</main>
        <footer class="site-footer"><div class="container rm-page-shell"></div></footer>
      </body>
    </html>`;
}

function createFixtureServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (pathname === "/css/app.css") {
      response.setHeader("content-type", "text/css");
      response.end(fs.readFileSync(path.join(root, "public/css/app.css")));
      return;
    }
    if (routes.includes(pathname)) {
      response.setHeader("content-type", "text/html");
      response.end(pageMarkup(pathname));
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function checkRoute(page: Page, route: string, viewportWidth: number): Promise<void> {
  await page.setViewportSize({ width: viewportWidth, height: 900 });
  await page.goto(`${page.url().split("/").slice(0, 3).join("/")}${route}`, { waitUntil: "load" });

  const result = await page.evaluate(() => {
    const shellSelectors = [
      ".system-status-bar__inner",
      ".site-header__inner",
      ".site-header__context",
      "main",
      "footer .rm-page-shell"
    ];
    const shells = shellSelectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      assert(element, `Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        maxWidth: style.maxWidth,
        minWidth: style.minWidth,
        marginLeft: style.marginLeft,
        marginRight: style.marginRight,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight
      };
    });
    const overflow = ["html", "body", "main"].map((selector) => ({
      selector,
      value: getComputedStyle(document.querySelector(selector) as Element).overflowX
    }));
    return {
      shells,
      overflow,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      tableWrappers: [...document.querySelectorAll<HTMLElement>("[class$='-table-wrapper']")].map((element) => ({
        overflowX: getComputedStyle(element).overflowX,
        tableMinWidth: getComputedStyle(element.querySelector("table") as Element).minWidth
      }))
    };
  });

  const expectedEdge = edgeSpace(viewportWidth);
  assert.ok(Math.abs(result.clientWidth - viewportWidth) <= 1);
  assert.ok(result.scrollWidth <= result.clientWidth + 1, `${route} overflows at ${viewportWidth}px`);
  for (const shell of result.shells) {
    assert.ok(Math.abs(shell.left - expectedEdge) <= 1, `${route} ${shell.selector} left edge mismatch`);
    assert.ok(Math.abs(shell.right - (viewportWidth - expectedEdge)) <= 1, `${route} ${shell.selector} right edge mismatch`);
    assert.equal(shell.maxWidth, "none");
    assert.equal(shell.minWidth, "0px");
    assert.equal(shell.marginLeft, `${expectedEdge}px`);
    assert.equal(shell.marginRight, `${expectedEdge}px`);
    assert.notEqual(shell.paddingLeft, "");
    assert.notEqual(shell.paddingRight, "");
  }
  assert.deepEqual(result.overflow.map(({ value }) => value), ["visible", "visible", "visible"]);
  for (const wrapper of result.tableWrappers) {
    assert.equal(wrapper.overflowX, "auto");
    assert.notEqual(wrapper.tableMinWidth, "0px");
  }
}

test("loaded shell geometry stays aligned across audited routes and viewports", async (t) => {
  const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
  if (!fs.existsSync(executablePath)) {
    t.skip(`Chromium executable not found at ${executablePath}`);
    return;
  }

  const { server, origin } = await createFixtureServer();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.goto(origin + routes[0]);
    for (const route of routes) {
      for (const viewportWidth of viewports) {
        await checkRoute(page, route, viewportWidth);
      }
    }
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
