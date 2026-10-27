import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import ejs from "ejs";
import express from "express";
import { chromium, type Browser } from "playwright-core";

test("customer registration cards, fields and scoped maps work at desktop and mobile widths", async (t) => {
  const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
  if (!fs.existsSync(executablePath)) {
    t.skip(`Chromium executable not found at ${executablePath}`);
    return;
  }
  const root = process.cwd();
  const app = express();
  app.use(express.static(path.join(root, "public")));
  app.get("/customers/register", async (request, response) => {
    response.send(await ejs.renderFile(path.join(root, "src/views/pages/customers/register.ejs"), {
      title: "New customer", appTitle: "RideMatrix", email: "admin@example.com",
      customerType: request.query.type, formData: {}, errors: [],
      mapBrowserApiKey: "browser-key", mapId: "", mapView: null
    }));
  });
  const server = http.createServer(app);
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://**/*", (route) => route.abort());
    await page.addInitScript({ content: `
      class Autocomplete extends HTMLElement {
        constructor() {
          super();
          this.textContent = "Search address";
        }
      }
      customElements.define("test-address-autocomplete", Autocomplete);
      window.google = {
        maps: {
          importLibrary: async () => ({ PlaceAutocompleteElement: Autocomplete }),
          Map: class {
            constructor(canvas, options) { this.canvas = canvas; this.setCenter(options.center); }
            setCenter(position) { this.canvas.textContent = position.lat + ", " + position.lng; }
          },
          Marker: class { setPosition() {} }
        }
      };
    ` });
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/customers/register?type=business`);
      const layout = await page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(".business-customer-form__grid")!;
        const cards = Array.from(grid.children) as HTMLElement[];
        const fields = Array.from(grid.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name]:not([type=hidden]), select[name]"));
        return {
          headings: cards.map((card) => card.querySelector("h2")?.textContent),
          columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          phoneGaps: Array.from(grid.querySelectorAll(".phone-number-component__input")).map((component) =>
            component.querySelector("input")!.getBoundingClientRect().left - component.querySelector("[data-phone-flag]")!.getBoundingClientRect().right),
          fields: fields.map((field) => {
            const rect = field.getBoundingClientRect();
            const card = field.closest("section")!.getBoundingClientRect();
            return {
              name: field.name, labelled: !!document.querySelector(`label[for="${field.id}"]`),
              visible: rect.width > 0 && rect.height > 0,
              contained: rect.left >= card.left && rect.right <= card.right && rect.right <= innerWidth
            };
          })
        };
      });
      assert.deepEqual(layout.headings, ["Registered company", "Registered address", "Operational base", "Booking manager (booker)", "Accounts department"]);
      assert.equal(layout.columns, width <= 760 ? 1 : 2);
      assert.equal(layout.overflow, false, `overflow at ${width}px`);
      assert.equal(layout.fields.length, 33);
      assert.ok(layout.phoneGaps.every((gap) => gap >= 0 && gap <= 12), `phone alignment at ${width}px`);
      for (const field of layout.fields) {
        assert.ok(field.labelled && field.visible && field.contained, `${field.name} at ${width}px`);
      }
      assert.equal(await page.locator(".address-map-preview").count(), 2);
      await page.selectOption("#bookingAuthRequired", "yes");
      assert.equal(await page.locator("#bookingAuthChannel").evaluate((element: HTMLSelectElement) => element.required && !element.disabled), true);
      await page.selectOption("#bookingAuthChannel", "both");
      await page.selectOption("#bookingAuthRequired", "no");
      assert.equal(await page.locator("#bookingAuthChannel").isDisabled(), true);
      await page.selectOption("#bookingAuthRequired", "yes");
      assert.equal(await page.locator("#bookingAuthChannel").inputValue(), "both");
      assert.deepEqual(errors, []);
      await page.waitForSelector("[data-address-prefix=registered] test-address-autocomplete");
      await page.waitForSelector("[data-address-prefix=operational] test-address-autocomplete");
      await page.evaluate(`(() => {
        for (const [prefix, lat, lng] of [["registered", 51, -1], ["operational", 52, -2]]) {
          document.querySelector("[data-address-prefix=" + prefix + "] test-address-autocomplete").dispatchEvent(new CustomEvent("gmp-select", {
            detail: {
              placePrediction: { toPlace: () => ({
                fetchFields: async () => {}, location: { lat, lng },
                formattedAddress: prefix + " road",
                addressComponents: [{ longText: prefix + " road", types: ["route"] }]
              }) }
            }
          }));
        }
      })()`);
      await page.waitForFunction(() => document.querySelector("[data-address-prefix=operational] .address-map-preview__canvas")?.textContent === "52, -2");
      assert.equal(await page.locator("[data-address-prefix=registered] .address-map-preview__canvas").textContent(), "51, -1");
      const selectedAddress = await page.locator("#business-customer-form").evaluate((form: HTMLFormElement) => Object.fromEntries(new FormData(form)));
      assert.equal(selectedAddress.registeredLatitude, "51");
      assert.equal(selectedAddress.registeredLongitude, "-1");
      assert.equal(selectedAddress.operationalLatitude, "52");
      assert.equal(selectedAddress.operationalLongitude, "-2");
      await page.fill("#registeredAddressLine1", "Manual office road");
      assert.equal(await page.locator("#registeredLatitude").inputValue(), "");
      assert.equal(await page.locator("#operationalLatitude").inputValue(), "52");
      assert.equal(await page.locator("[data-address-prefix=operational] .address-map-preview__canvas").textContent(), "52, -2");
      const submitted = await page.locator("#business-customer-form").evaluate((form: HTMLFormElement) => Object.fromEntries(new FormData(form)));
      assert.equal(submitted.registeredAddressLine1, "Manual office road");
      assert.equal(submitted.operationalAddressLine1, "operational road");
      assert.equal(submitted.registeredLatitude, "");
      assert.equal(submitted.registeredLongitude, "");
      assert.equal(submitted.operationalLatitude, "52");
      assert.equal(submitted.bookingAuthChannel, "both");

      await page.goto(`${origin}/customers/register?type=private`);
      assert.equal(await page.locator("#private-customer-form .private-customer-form__column").count(), 3);
      assert.equal(await page.locator("#givenName").isVisible(), true);
      assert.equal(await page.locator("#surname").isVisible(), true);
      assert.equal(await page.locator("[data-address-prefix]").count(), 0);
      await page.waitForSelector("#addressSearchAutocomplete test-address-autocomplete");
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
