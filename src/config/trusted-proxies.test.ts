import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { configureTrustedProxies } from "./trusted-proxies";

test("proxy trust is disabled when no trusted proxy addresses are configured", () => {
  const app = express();

  configureTrustedProxies(app);

  assert.equal(app.get("trust proxy"), false);
});

test("proxy trust accepts explicit IP addresses and CIDR ranges", () => {
  const app = express();

  configureTrustedProxies(app, "192.0.2.10, 2001:db8::/64");

  assert.deepEqual(app.get("trust proxy"), ["192.0.2.10", "2001:db8::/64"]);
});

test("proxy trust rejects wildcards, booleans, aliases, and empty list entries", () => {
  for (const value of ["*", "true", "loopback", "192.0.2.10,,192.0.2.11"]) {
    assert.throws(() => configureTrustedProxies(express(), value), /IP addresses or CIDR ranges/);
  }
});

test("proxy trust rejects invalid IP addresses and CIDR ranges", () => {
  for (const value of ["not-an-ip", "192.0.2.10/99"]) {
    assert.throws(() => configureTrustedProxies(express(), value));
  }
});
