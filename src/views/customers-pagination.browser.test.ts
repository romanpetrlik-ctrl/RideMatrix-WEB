import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import ejs from "ejs";
import { chromium, type Browser } from "playwright-core";

const root = process.cwd();

test("rendered customer pagination control stays centered without viewport overflow", async (t) => {
  const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
  if (!fs.existsSync(executablePath)) {
    t.skip(`Chromium executable not found at ${executablePath}`);
    return;
  }

  const toolbar = await ejs.renderFile(path.join(root, "src/views/partials/header-context/customers-list.ejs"), {
    status: "all",
    statusTabs: [],
    search: "",
    perPage: undefined,
    perPageOptions: [10, 25, 50]
  });
  const server = http.createServer((request, response) => {
    if (new URL(request.url || "/", "http://localhost").pathname === "/css/app.css") {
      response.setHeader("content-type", "text/css");
      response.end(fs.readFileSync(path.join(root, "public/css/app.css")));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><html><head><link rel="stylesheet" href="/css/app.css"></head><body>${toolbar}</body></html>`);
  });
  const origin = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin, { waitUntil: "load" });
      const result = await page.evaluate(() => {
        const select = document.querySelector<HTMLSelectElement>("#customers-per-page");
        if (!select) {
          throw new Error("Missing customer per-page select");
        }
        const style = getComputedStyle(select);
        return {
          value: select.value,
          textAlign: style.textAlign,
          textAlignLast: style.textAlignLast,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth
        };
      });
      assert.equal(result.value, "10");
      assert.equal(result.textAlign, "center");
      assert.equal(result.textAlignLast, "center");
      assert.ok(result.scrollWidth <= result.clientWidth);
    }
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
