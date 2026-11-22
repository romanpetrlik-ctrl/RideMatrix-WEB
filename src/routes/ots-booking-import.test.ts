import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import type { OtsBookingSnapshot } from "../services/ots-booking-import";
import { createOtsBookingImportRouter } from "./ots-booking-import";

const snapshot: OtsBookingSnapshot = {
  reservationId: "OTS-123",
  pickupTime: "12/06/2026 14:35",
  pickup: "Example Station, London",
  dropoff: "Example Road, London",
  passengerCount: 2,
  passengerName: "Redacted Passenger"
};

async function withApp(
  roles: string[],
  run: (baseUrl: string) => Promise<void>,
  importBooking: NonNullable<Parameters<typeof createOtsBookingImportRouter>[0]["importBooking"]> =
    async () => ({ status: "imported", snapshot })
) {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/views"));
  app.use(express.urlencoded({ extended: true }));
  app.use(createCsrfProtection({ appTitle: "Test", cookieSecure: false }));
  app.use(createOtsBookingImportRouter({
    appTitle: "Test",
    loadSession: async () => ({
      authenticated: true,
      user: { id: "admin-1", email: "admin@example.test", roles }
    }),
    importBooking
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("OTS import page is admin-only and explains safe loading", async () => {
  await withApp(["staff"], async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/bookings/ots-import`)).status, 403);
  });
  await withApp(["admin"], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/bookings/ots-import`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(html, /name="otsUrl"/);
    assert.match(html, />Načíst<\/button>/);
    assert.match(html, /Links that submit an acceptance action are rejected/);
  });
});

test("OTS import renders a stored snapshot without echoing the submitted source link", async () => {
  let receivedLink = "";
  const sourceLink = "https://ots-system.net/respond.php?r=OTS-123&s=redacted&j=redacted&h=redacted&w=redacted";
  await withApp(["admin"], async (baseUrl) => {
    const page = await fetch(`${baseUrl}/bookings/ots-import`);
    const html = await page.text();
    const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
    const response = await fetch(`${baseUrl}/bookings/ots-import`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ _csrf: token, otsUrl: sourceLink })
    });
    const result = await response.text();
    assert.equal(response.status, 200);
    assert.match(result, /OTS details loaded and saved as an import snapshot/);
    assert.match(result, /Example Station, London/);
    assert.doesNotMatch(result, /h=redacted/);
  }, async (url, actor) => {
    receivedLink = url;
    assert.equal(actor.accountId, "admin-1");
    return { status: "imported", snapshot };
  });
  assert.equal(receivedLink, sourceLink);
});

test("OTS import warns when a reservation has already been imported", async () => {
  await withApp(["admin"], async (baseUrl) => {
    const page = await fetch(`${baseUrl}/bookings/ots-import`);
    const html = await page.text();
    const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
    const response = await fetch(`${baseUrl}/bookings/ots-import`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token, otsUrl: "unused" })
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OTS reservation <strong>OTS-123<\/strong> has already been imported/);
  }, async () => ({ status: "duplicate", reservationId: "OTS-123" }));
});
