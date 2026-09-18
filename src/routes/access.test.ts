import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";
import { createAccessRouter } from "./access";

let server: http.Server;
let baseUrl = "";

let requestCalls: string[] = [];
let blockTestSink = false;

before(async () => {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/views"));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    createAccessRouter({
      appTitle: "RideMatrix",
      requestAccess: async (email: string) => {
        requestCalls.push(email);
      },
      assertTestSink: async () => {
        if (blockTestSink) {
          throw new Error("Test-account notification sink is not configured.");
        }
      }
    })
  );
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(500).send(String(error?.message || "error"));
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("POST /access blocks when test sink policy fails", async () => {
  requestCalls = [];
  blockTestSink = true;

  const response = await fetch(`${baseUrl}/access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=test.customer%40ridematrix.uk"
  });

  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /sink is not configured/);
  assert.deepEqual(requestCalls, []);
});

test("POST /access continues to submit access requests when sink policy passes", async () => {
  requestCalls = [];
  blockTestSink = false;

  const response = await fetch(`${baseUrl}/access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=test.customer%40ridematrix.uk"
  });

  assert.equal(response.status, 200);
  assert.deepEqual(requestCalls, ["test.customer@ridematrix.uk"]);
});
