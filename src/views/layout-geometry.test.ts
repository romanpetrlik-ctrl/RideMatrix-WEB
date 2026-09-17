import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";

const viewports = [
  [1920, 1080], [1600, 900], [1440, 900], [1280, 800],
  [1024, 768], [820, 900], [390, 844]
] as const;
const routes = [
  "/choose-role", "/dashboard", "/customers", "/customers/register?type=private",
  "/customers/1", "/customers/1/edit", "/staff", "/staff/invite", "/vehicles", "/vehicles/1"
];
const shellSelectors = [
  ".system-status-bar__inner", ".site-header__inner", ".site-header__context",
  "main", ".site-footer > .rm-page-shell"
];
const optionalSelectors = [".dashboard-layout", ".workspace-tile-grid", ".private-customer-form__grid"];
const tableWrapperSelectors = [".customers-table-wrapper", ".staff-table-wrapper", ".vehicle-table-wrapper", ".table-wrapper"];

type BrowserGeometry = {
  selector: string;
  rect: ReturnType<DOMRect["toJSON"]>;
  computed: Record<string, string>;
  parents: Array<{ tag: string; id: string; className: string }>;
  suspectRules: string[];
};

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function pageMarkup(route: string): string {
  const pageClass = route.includes("/customers") ? "customers-page" : route.includes("/staff") ? "staff-page" : route.includes("/vehicles") ? "vehicle-page" : "dashboard-page";
  const pageContent = route === "/choose-role"
    ? '<section class="dashboard-layout"><div class="workspace-tile-grid"><article>Workspace</article></div></section>'
    : route.includes("register") || route.includes("/edit")
      ? '<form class="private-customer-form"><div class="private-customer-form__grid"><div>Details</div><div>Address</div><div>Map</div></div></form>'
      : route.includes("/customers")
        ? '<div class="customers-table-wrapper"><table class="customers-table"><tr><td>Customer</td></tr></table></div>'
        : route.includes("/staff")
          ? '<div class="staff-table-wrapper"><table class="staff-table"><tr><td>Staff</td></tr></table></div>'
          : route.includes("/vehicles")
            ? '<div class="vehicle-table-wrapper"><table class="vehicle-table"><tr><td>Vehicle</td></tr></table></div>'
            : '<div class="dashboard-layout"><div class="workspace-tile-grid"><article>Workspace</article></div></div>';
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/css/app.css"></head>
    <body class="${pageClass}">
      <div class="system-status-bar"><div class="container rm-page-shell system-status-bar__inner">System status</div></div>
      <header class="site-header"><div class="container rm-page-shell site-header__inner"><strong>RideMatrix</strong></div>
        <div class="container rm-page-shell site-header__context">Context</div></header>
      <main class="container rm-page-shell">${pageContent}</main>
      <footer class="site-footer"><div class="container rm-page-shell"></div></footer>
    </body></html>`;
}

async function startFixtureServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((request, response) => {
    const requestUrl = request.url || "/";
    const requestPath = new URL(requestUrl, "http://localhost").pathname;
    if (requestPath === "/css/app.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(read("public/css/app.css"));
    } else if (routes.includes(requestUrl) || routes.includes(requestPath)) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(pageMarkup(requestUrl));
    } else {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function inspect(page: Page, selector: string): Promise<BrowserGeometry | null> {
  const locator = page.locator(selector).first();
  if (await locator.count() === 0) return null;
  return locator.evaluate((element, requestedSelector) => {
    const rect = element.getBoundingClientRect().toJSON();
    const style = getComputedStyle(element);
    const parents = [];
    let parent = element.parentElement;
    while (parent && parents.length < 4) {
      parents.push({ tag: parent.tagName.toLowerCase(), id: parent.id, className: parent.className });
      parent = parent.parentElement;
    }
    const suspectRules: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSStyleRule && element.matches(rule.selectorText)) {
          const declarations = ["width", "max-width", "min-width", "overflow-x", "margin", "padding"]
            .map((property) => `${property}:${rule.style.getPropertyValue(property)}`)
            .filter((declaration) => !declaration.endsWith(":"));
          if (declarations.length) suspectRules.push(`${rule.selectorText} { ${declarations.join("; ")} }`);
        }
      }
    }
    return {
      selector: requestedSelector,
      rect,
      computed: Object.fromEntries(["width", "max-width", "min-width", "margin-left", "margin-right", "padding-left", "padding-right", "overflow-x"].map((property) => [property, style.getPropertyValue(property)])),
      parents,
      suspectRules
    };
  }, selector);
}

async function diagnostic(page: Page, url: string, viewport: readonly [number, number], selector: string, message: string): Promise<never> {
  throw new Error(JSON.stringify({ message, url, viewport, selector, geometry: await inspect(page, selector) }, null, 2));
}

let browser: Browser;
let fixture: { server: http.Server; origin: string };

test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true });
  fixture = await startFixtureServer();
});

test.after(async () => {
  await browser.close();
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
});

test("rendered shell geometry is symmetric and uncapped at every required route and viewport", async () => {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport: { width: viewport[0], height: viewport[1] } });
    for (const route of routes) {
      const url = `${fixture.origin}${route}`;
      await page.goto(url, { waitUntil: "load" });
      const documentGeometry = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }));
      if (documentGeometry.scrollWidth > documentGeometry.clientWidth) {
        await diagnostic(page, url, viewport, "html", `Horizontal page overflow: ${documentGeometry.scrollWidth}px > ${documentGeometry.clientWidth}px`);
      }
      const measured = (await Promise.all(shellSelectors.map((selector) => inspect(page, selector)))).filter(Boolean) as BrowserGeometry[];
      const first = measured[0];
      assert.ok(first, `Missing shell on ${url}`);
      for (const geometry of measured) {
        if (geometry.computed["overflow-x"] === "auto" || geometry.computed["overflow-x"] === "scroll") {
          await diagnostic(page, url, viewport, geometry.selector, "Shell is a horizontal scroll container");
        }
      }
      for (const geometry of measured.slice(1)) {
        if (Math.abs(geometry.rect.left - first.rect.left) > 2) await diagnostic(page, url, viewport, geometry.selector, "Shell left edges differ by more than 2px");
        if (Math.abs(geometry.rect.right - first.rect.right) > 2) await diagnostic(page, url, viewport, geometry.selector, "Shell right edges differ by more than 2px");
      }
      if (Math.abs(first.rect.left - (viewport[0] - first.rect.right)) > 2) {
        await diagnostic(page, url, viewport, first.selector, "Shell edges are not symmetric");
      }
      if (viewport[0] >= 1600 && first.rect.width <= 1320) {
        await diagnostic(page, url, viewport, first.selector, "Wide viewport has an artificial outer width limit");
      }
      for (const selector of optionalSelectors) {
        const geometry = await inspect(page, selector);
        if (geometry && (geometry.computed["overflow-x"] === "auto" || geometry.computed["overflow-x"] === "scroll")) {
          await diagnostic(page, url, viewport, selector, "Page layout is a horizontal scroll container");
        }
      }
      const overflowContainers = await page.locator("*").evaluateAll((elements, allowed) => elements
        .filter((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowX))
        .map((element) => ({ tag: element.tagName.toLowerCase(), className: element.className, allowed: (allowed as string[]).some((selector) => element.matches(selector)) })), tableWrapperSelectors);
      assert.deepEqual(overflowContainers.filter((element) => !element.allowed), [], JSON.stringify({ url, viewport, overflowContainers }));
    }
    await page.close();
  }
});

test("build serves the current stylesheet from the RideMatrix-WEB source context", () => {
  const css = read("public/css/app.css");
  assert.match(read("src/views/partials/head.ejs"), /href="\/css\/app\.css"/);
  assert.ok(css.includes("--rm-page-edge-space"), "public/css/app.css is not the canonical current stylesheet");
  assert.ok(fs.existsSync(path.join(process.cwd(), "public/css/app.css")));
  assert.match(read("src/index.ts"), /path\.join\(__dirname, "\.\.\/public"\)/);
  assert.equal(fs.existsSync(path.join(process.cwd(), "dist/public/css/app.css")), false, "A second stale stylesheet exists in build output");
});
