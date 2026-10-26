import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import type { BookingAuthorizationResult, BookingAuthorizationStatus } from "../services/booking-authorization";
import { bookingAuthorizationResponseHeaders, createBookingAuthorizationRouter } from "./booking-authorization";

test("public confirmation GETs never consume; POST requires browser-bound CSRF and records only its path decision", async () => {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/views"));
  app.use(express.urlencoded({ extended: false }));
  app.use("/booking-authorization", bookingAuthorizationResponseHeaders);
  app.use(createCsrfProtection({ appTitle: "Test", cookieSecure: false }));
  const consumed: string[] = [];
  let status: BookingAuthorizationStatus = "pending";
  let resultOverride: BookingAuthorizationResult | undefined;
  app.use(createBookingAuthorizationRouter({
    appTitle: "Test",
    inspectToken: async () => status,
    consumeToken: async (_token, decision): Promise<BookingAuthorizationResult> => {
      consumed.push(decision);
      return resultOverride ?? { status: decision, outcome: "decided" };
    }
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/booking-authorization/${"a".repeat(43)}`;
  try {
    for (const action of ["approve", "decline"]) {
      const response = await fetch(`${base}/${action}`);
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
      assert.doesNotMatch(body, /https?:\/\/|<script|customer_id|booking_id/);
      assert.match(body, /<form method="post">/);
      assert.equal(consumed.length, 0);
      const cookie = response.headers.getSetCookie().find(value => value.startsWith("rm_csrf="))!.split(";")[0];
      const csrf = /name="_csrf" value="([^"]+)"/.exec(body)![1];
      const submit = (token: string, browserCookie = cookie) => fetch(`${base}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: browserCookie },
        body: new URLSearchParams({ _csrf: token, decision: action === "approve" ? "declined" : "approved" })
      });
      for (const invalid of ["", "forged"]) {
        const rejected = await submit(invalid);
        assert.equal(rejected.status, 403);
        assert.equal(rejected.headers.get("cache-control"), "no-store");
        assert.equal(rejected.headers.get("referrer-policy"), "no-referrer");
      }
      assert.equal((await submit(csrf, "rm_csrf=different-browser")).status, 403);
      assert.equal(consumed.length, 0);
      const result = await submit(csrf);
      assert.equal(result.status, 200);
      assert.match(await result.text(), /Your decision has been recorded/);
      assert.deepEqual(consumed, [action === "approve" ? "approved" : "declined"]);
      consumed.length = 0;
    }
    for (const terminal of ["invalid", "expired", "approved", "declined"] as const) {
      status = terminal;
      const response = await fetch(`${base}/approve`);
      const body = await response.text();
      assert.equal(response.status, terminal === "invalid" ? 404 : terminal === "expired" ? 410 : 200);
      assert.doesNotMatch(body, /<form/);
      assert.match(body, terminal === "invalid" ? /invalid or unavailable/
        : terminal === "expired" ? /has expired/ : /already been decided/);
    }
    status = "pending";
    const form = await fetch(`${base}/approve`);
    const cookie = form.headers.getSetCookie().find(value => value.startsWith("rm_csrf="))!.split(";")[0];
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await form.text())![1];
    for (const terminal of ["invalid", "expired", "approved", "declined"] as const) {
      resultOverride = { status: terminal, outcome: terminal === "invalid" ? "invalid"
        : terminal === "expired" ? "expired" : "already_decided" };
      const response = await fetch(`${base}/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ _csrf: csrf })
      });
      assert.equal(response.status, terminal === "invalid" ? 404 : terminal === "expired" ? 410 : 200);
      const body = await response.text();
      assert.doesNotMatch(body, /<form/);
      assert.match(body, terminal === "invalid" ? /invalid or unavailable/
        : terminal === "expired" ? /has expired/ : /already been decided/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("POST fails closed without the global CSRF middleware; rate limiting is applied", async () => {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/views"));
  let consumes = 0;
  app.use(createBookingAuthorizationRouter({
    appTitle: "Test",
    inspectToken: async () => "invalid",
    consumeToken: async () => { consumes++; return { status: "approved", outcome: "decided" }; }
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/booking-authorization/${"a".repeat(43)}/approve`;
  try {
    assert.equal((await fetch(url, { method: "POST" })).status, 403);
    assert.equal(consumes, 0);
    for (let i = 0; i < 59; i++) {
      const response = await fetch(url);
      await response.text();
      assert.equal(response.status, 404);
    }
    const limited = await fetch(url);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("cache-control"), "no-store");
    assert.equal(limited.headers.get("referrer-policy"), "no-referrer");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
