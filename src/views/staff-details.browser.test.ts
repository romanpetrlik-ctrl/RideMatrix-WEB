import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import ejs from "ejs";
import { chromium, type Browser } from "playwright-core";

test("staff desktop dialog supports double-click, keyboard, focus, and standalone history links", async (t) => {
  const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
  if (!fs.existsSync(executablePath)) {
    t.skip(`Chromium executable not found at ${executablePath}`);
    return;
  }
  const root = process.cwd();
  const member = {
    id: "selected", displayName: "Known colleague",
    email: "selected@example.com", status: "Active", roleLabels: ["Driver"],
    formattedCreatedAt: "1 Jan 2025", formattedLastLoginAt: "Never",
    auditHref: "/staff/selected/audit"
  };
  const directory = await ejs.renderFile(path.join(root, "src/views/pages/staff/index.ejs"), {
    title: "Staff", appTitle: "RideMatrix", email: "admin@example.com", staffCount: 1, staff: [member]
  });
  const details = await ejs.renderFile(path.join(root, "src/views/pages/staff/audit.ejs"), {
    title: "Login history", appTitle: "RideMatrix", email: "admin@example.com",
    dialogMode: true, member, events: [], eventLimit: 200
  });
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/js/staff-details.js" || url.pathname === "/css/app.css") {
      response.setHeader("content-type", url.pathname.endsWith(".js") ? "text/javascript" : "text/css");
      response.end(fs.readFileSync(path.join(root, "public", url.pathname)));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.setHeader("cache-control", "no-store");
    if (url.pathname === member.auditHref) {
      requests.push(url.pathname + url.search);
      response.end(details);
      return;
    }
    response.end(directory);
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("https://**/*", (route) => route.abort());
    await page.goto(origin);
    const identity = page.locator(".staff-table__identity");
    assert.equal(await identity.locator(".staff-table__name").textContent(), member.displayName);
    const nameBox = await identity.locator(".staff-table__name").boundingBox();
    const emailBox = await identity.locator(".staff-table__email").boundingBox();
    assert.ok(nameBox && emailBox && nameBox.y + nameBox.height <= emailBox.y, "email is beneath the name");
    const action = page.locator("[data-staff-details]");
    const dialog = page.locator("#staff-details-dialog");
    const close = page.getByRole("button", { name: "Close", exact: true });
    const frame = page.frameLocator("#staff-details-dialog iframe");

    // A single click on plain row text does not open the modal.
    await page.getByText("Never", { exact: true }).click();
    assert.equal(await dialog.isVisible(), false);
    await page.getByText("Never", { exact: true }).dblclick();
    await frame.getByRole("heading", { name: "User details", exact: true }).waitFor();
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await close.evaluate((element) => element === document.activeElement), true);
    assert.equal(requests.at(-1), "/staff/selected/audit?dialog=1");
    assert.equal(await frame.getByText(member.email, { exact: true }).count(), 1);
    assert.equal(await frame.getByText("No login events recorded", { exact: true }).count(), 1);

    // Native dialog keeps Tab focus away from the background directory.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => {
        const active = document.activeElement;
        return active === document.body || document.querySelector("dialog")?.contains(active);
      }), true);
    }
    await close.click();
    await page.waitForFunction(() => document.activeElement?.matches("[data-staff-details]"));
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await action.evaluate((element) => element === document.activeElement), true);
    assert.equal(await dialog.locator("iframe").getAttribute("src"), null);

    await action.press("Enter");
    await frame.getByRole("heading", { name: "User details", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.matches("[data-staff-details]"));
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await action.evaluate((element) => element === document.activeElement), true);

    await action.press("Space");
    await frame.getByRole("heading", { name: "User details", exact: true }).waitFor();
    await frame.locator("body").click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.matches("[data-staff-details]"));
    assert.equal(await dialog.isVisible(), false);

    await action.click();
    await frame.getByRole("heading", { name: "User details", exact: true }).waitFor();
    await close.click();
    await page.waitForFunction(() => document.activeElement?.matches("[data-staff-details]"));

    // Other controls do not trigger row details; the history email link navigates normally.
    await page.locator("[data-staff-row] td").first().evaluate((cell) => {
      const button = document.createElement("button");
      button.textContent = "Other action";
      cell.append(button);
    });
    await page.getByRole("button", { name: "Other action" }).dblclick();
    assert.equal(await dialog.isVisible(), false);
    const beforeNavigation = requests.length;
    const emailLink = page.getByRole("link", { name: member.email, exact: true });
    await emailLink.dispatchEvent("dblclick");
    assert.equal(requests.slice(beforeNavigation).some((url) => url.includes("?dialog=1")), false);
    assert.equal(await dialog.isVisible(), false);
    await emailLink.click();
    await page.waitForURL(`${origin}${member.auditHref}`);
    assert.equal(new URL(page.url()).pathname, member.auditHref);

    const noScript = await browser.newPage({ javaScriptEnabled: false });
    await noScript.route("https://**/*", (route) => route.abort());
    await noScript.goto(origin);
    await noScript.locator("[data-staff-details]").click();
    await noScript.waitForURL(`${origin}${member.auditHref}`);
    assert.equal(new URL(noScript.url()).pathname, member.auditHref);
    assert.equal(new URL(noScript.url()).search, "");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
