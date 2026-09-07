import assert from "node:assert/strict";
import test, { describe } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";

describe("Request body limits middleware", () => {
  test("rejects oversized URL-encoded requests (> 100kb)", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: true, limit: "100kb", parameterLimit: 1000 }));
    app.post("/test", (req, res) => {
      res.json({ success: true });
    });

    const server = app.listen(0);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // Create a payload larger than 100kb
      const oversizedPayload = new URLSearchParams();
      const largeValue = "x".repeat(150 * 1024); // 150kb of data
      oversizedPayload.append("data", largeValue);

      const response = await fetch(`${baseUrl}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: oversizedPayload.toString()
      });

      assert.equal(response.status, 413, "Should return 413 (Payload Too Large) for oversized URL-encoded request");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("accepts normal-sized URL-encoded requests (< 100kb)", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: true, limit: "100kb", parameterLimit: 1000 }));
    app.post("/test", (req, res) => {
      res.json({ received: req.body.data });
    });

    const server = app.listen(0);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const payload = new URLSearchParams();
      payload.append("data", "normal data");

      const response = await fetch(`${baseUrl}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload.toString()
      });

      assert.equal(response.status, 200, "Should accept normal-sized URL-encoded request");
      const json = await response.json() as { received: string };
      assert.equal(json.received, "normal data");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("rejects excessively parameterized URL-encoded requests (> 1000 parameters)", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: true, limit: "100kb", parameterLimit: 1000 }));
    app.post("/test", (req, res) => {
      res.json({ count: Object.keys(req.body).length });
    });

    const server = app.listen(0);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // Create a payload with more than 1000 parameters
      const payload = new URLSearchParams();
      for (let i = 0; i < 1005; i++) {
        payload.append(`param${i}`, `value${i}`);
      }

      const response = await fetch(`${baseUrl}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload.toString()
      });

      assert.equal(response.status, 413, "Should reject request with > 1000 parameters");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("rejects oversized JSON requests (> 100kb)", async () => {
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.post("/test", (req, res) => {
      res.json({ success: true });
    });

    const server = app.listen(0);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // Create a JSON payload larger than 100kb
      const largeObject = {
        data: "x".repeat(150 * 1024) // 150kb of data
      };

      const response = await fetch(`${baseUrl}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(largeObject)
      });

      assert.equal(response.status, 413, "Should return 413 (Payload Too Large) for oversized JSON request");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("accepts normal-sized JSON requests (< 100kb)", async () => {
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.post("/test", (req, res) => {
      res.json({ received: req.body.data });
    });

    const server = app.listen(0);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const payload = { data: "normal JSON data" };

      const response = await fetch(`${baseUrl}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      assert.equal(response.status, 200, "Should accept normal-sized JSON request");
      const json = await response.json() as { received: string };
      assert.equal(json.received, "normal JSON data");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("multipart/form-data uploads are NOT limited by express.urlencoded limits (handled by multer)", async () => {
    // This test verifies that the 100kb limit on urlencoded data does not
    // affect multipart uploads, which are handled separately by multer.
    // The multer configuration uses a 10 MiB limit for file uploads.
    const app = express();
    app.use(express.urlencoded({ extended: true, limit: "100kb", parameterLimit: 1000 }));

    // Multer should handle multipart/form-data separately
    let multipartReached = false;
    app.use((req, res, next) => {
      if (req.is("multipart/form-data")) {
        multipartReached = true;
      }
      next();
    });

    app.post("/test", (req, res) => {
      res.json({ success: multipartReached });
    });

    const server = app.listen(0);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const formData = new FormData();
      formData.append("field", "value");

      const response = await fetch(`${baseUrl}/test`, {
        method: "POST",
        body: formData
      });

      assert.equal(response.status, 200);
      const json = await response.json() as { success: boolean };
      assert.equal(json.success, true, "multipart/form-data requests should reach the handler");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
