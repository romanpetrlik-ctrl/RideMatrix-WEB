import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import express from "express";
import { createExitRouter } from "./exit";

describe("logout flow", () => {
  let authServer: http.Server;
  let appServer: http.Server;
  let baseUrl: string;
  let logoutStatus = 204;
  let logoutCookies: string[] = [];
  let receivedCookie: string | undefined;

  before(async () => {
    authServer = http.createServer((req, res) => {
      if (req.url !== "/auth/logout" || req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }

      receivedCookie = req.headers.cookie;
      res.writeHead(logoutStatus, { "set-cookie": logoutCookies });
      res.end();
    });
    await new Promise<void>((resolve) => authServer.listen(4000, "127.0.0.1", resolve));

    const app = express();
    app.use(createExitRouter());
    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
  });

  test("POST /exit forwards the session cookie, all deletion cookies, and redirects", async () => {
    logoutStatus = 204;
    logoutCookies = [
      "rm_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
      "rm_refresh=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure"
    ];

    const response = await fetch(`${baseUrl}/exit`, {
      method: "POST",
      headers: { cookie: "rm_session=session-value; rm_refresh=refresh-value" },
      redirect: "manual"
    });

    assert.equal(receivedCookie, "rm_session=session-value; rm_refresh=refresh-value");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
    assert.deepEqual(response.headers.getSetCookie(), logoutCookies);
  });

  test("logout API failure still redirects safely and forwards its cookie state", async () => {
    logoutStatus = 503;
    logoutCookies = ["rm_session=; Max-Age=0; Path=/; HttpOnly"];

    const response = await fetch(`${baseUrl}/exit`, {
      method: "POST",
      headers: { cookie: "rm_session=session-value" },
      redirect: "manual"
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
    assert.deepEqual(response.headers.getSetCookie(), logoutCookies);
  });

  test("direct GET /exit redirects to access without performing logout", async () => {
    receivedCookie = undefined;

    const response = await fetch(`${baseUrl}/exit`, { redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/access");
    assert.equal(receivedCookie, undefined);
  });
});
