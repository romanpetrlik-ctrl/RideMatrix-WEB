import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeVehicleDocumentUploadRateLimit,
  createVehicle,
  getDocumentStatus,
  listVehicleClasses,
  validateVehicleDocumentUpload,
  VEHICLE_DEFAULT_PER_PAGE
} from "./vehicles";

test("vehicle management uses a fifteen-row default and exposes catalogue classes", async () => {
  const queries: string[] = [];
  const client: any = {
    async query(text: string, params?: unknown[]) {
      queries.push(text);
      if (text.includes("FROM vehicle_classes")) {
        return { rows: [{ key: "executive", label: "Executive" }] };
      }
      if (text.includes("INSERT INTO vehicles")) return { rows: [] };
      if (text.includes("FROM vehicles")) {
        return { rows: [{ id: "v1", registration: "AB1", make: "Make", model: "Model",
          year: null, colour: null, fuel_type: "ICE", passenger_capacity: 4,
          wheelchair_accessible: false, classes: [{ key: "executive", label: "Executive" }],
          capacities: [], status: "active", notes: null, driver_id: null, driver_email: null,
          documents_count: 0 }] };
      }
      return { rows: [] };
    }
  };
  assert.equal(VEHICLE_DEFAULT_PER_PAGE, 15);
  assert.deepEqual(await listVehicleClasses(client), [{ key: "executive", label: "Executive" }]);
  const vehicle = await createVehicle({
    registration: " ab1 ", make: "Make", model: "Model", vehicleClassKey: "executive",
    fuelType: "ICE", passengerCapacity: 4, status: "active"
  }, client);
  assert.equal(vehicle.registration, "AB1");
  assert.ok(queries.some((query) => query.includes("INSERT INTO vehicles")));
});

test("vehicle creation rejects incomplete records", async () => {
  await assert.rejects(
    createVehicle({ registration: "", make: "Make", model: "Model", vehicleClassKey: "executive",
      fuelType: "ICE", passengerCapacity: 4, status: "active" }, {
      query: async () => ({ rows: [] })
    } as any),
    /required/
  );
});

test("document validation requires an allowed extension, MIME type, and signature", () => {
  assert.doesNotThrow(() => validateVehicleDocumentUpload({
    originalname: "insurance.PDF",
    mimetype: "application/pdf",
    buffer: Buffer.from("%PDF-1.7")
  }));
  assert.throws(() => validateVehicleDocumentUpload({
    originalname: "insurance.pdf",
    mimetype: "image/png",
    buffer: Buffer.from("%PDF-1.7")
  }), /valid PDF/);
  assert.throws(() => validateVehicleDocumentUpload({
    originalname: "insurance.txt",
    mimetype: "application/pdf",
    buffer: Buffer.from("%PDF-1.7")
  }), /valid PDF/);
});

test("document upload rate limiting uses an atomic database counter", async () => {
  let queryText = "";
  const client: any = {
    async query(text: string) {
      queryText = text;
      return { rows: [{ allowed: false }] };
    }
  };
  assert.equal(await consumeVehicleDocumentUploadRateLimit("vehicle-document:u1:127.0.0.1", client), false);
  assert.match(queryText, /ON CONFLICT \(rate_limit_key\) DO UPDATE/);
  assert.match(queryText, /request_count <=/);
});

test("vehicle validation requires operational fields and non-negative baggage capacities", async () => {
  await assert.rejects(
    createVehicle({
      registration: "AB1", make: "Make", model: "Model", classKeys: ["executive"],
      fuelType: "EV", passengerCapacity: 0, status: "active",
      baggageCapacities: { xl_suitcase: -1 }
    }, { query: async () => ({ rows: [] }) } as any),
    /positive integer.*non-negative integer/
  );
});

test("compliance status uses the centralized thirty-day threshold", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(getDocumentStatus(null, now), "Missing");
  assert.equal(getDocumentStatus("2025-12-31", now), "Expired");
  assert.equal(getDocumentStatus("2026-01-15", now), "Expiring soon");
  assert.equal(getDocumentStatus("2026-02-15", now), "Valid");
});
