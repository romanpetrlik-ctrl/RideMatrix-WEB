import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ejs from "ejs";
import { BAGGAGE_CATEGORIES } from "../database/seed";
import { resolveHelpContent } from "./help";
import {
  consumeVehicleDocumentUploadRateLimit,
  consumeVehicleMutationRateLimit,
  createVehicleDocument,
  createVehicle,
  getVehicleDocument,
  getDocumentStatus,
  listVehicleClasses,
  listVehicleDocuments,
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

test("vehicle mutation rate limiting uses the distributed database counter separately from uploads", async () => {
  let params: unknown[] = [];
  const client: any = {
    async query(_text: string, values: unknown[]) {
      params = values;
      return { rows: [{ allowed: true }] };
    }
  };
  assert.equal(await consumeVehicleMutationRateLimit("vehicle-mutation:u1", client), true);
  assert.equal(params[0], "vehicle-mutation:u1");
  assert.equal(params[1], 120);
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

test("vehicle creation uses a transaction and rolls back partial writes", async () => {
  const calls: string[] = [];
  const tx: any = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes("vehicle_baggage_capacities")) throw new Error("capacity failure");
      return { rows: [] };
    },
    release() {
      calls.push("release");
    }
  };
  const pool: any = { connect: async () => tx };
  await assert.rejects(
    createVehicle({
      registration: "AB1", make: "Make", model: "Model", classKeys: ["executive"],
      fuelType: "ICE", passengerCapacity: 4, status: "active",
      baggageCapacities: { xl_suitcase: 1 }
    }, pool),
    /capacity failure/
  );
  assert.equal(calls[0], "BEGIN");
  assert.ok(calls.some((call) => call.includes("INSERT INTO vehicles")));
  assert.ok(calls.includes("ROLLBACK"));
  assert.ok(!calls.includes("COMMIT"));
  assert.equal(calls.at(-1), "release");
});

test("wheelchair accessibility is synchronized from class assignment", async () => {
  const params: unknown[][] = [];
  const client: any = {
    async query(sql: string, values: unknown[] = []) {
      params.push(values);
      if (sql.includes("FROM vehicles")) {
        return { rows: [{ id: "v1", registration: "AB1", make: "Make", model: "Model",
          year: null, colour: null, fuel_type: "ICE", passenger_capacity: 4,
          wheelchair_accessible: false, classes: [{ key: "executive", label: "Executive" }],
          capacities: [], status: "active", notes: null, driver_id: null, driver_email: null,
          documents_count: 0 }] };
      }
      return { rows: [] };
    }
  };
  await createVehicle({
    registration: "AB1", make: "Make", model: "Model", classKeys: ["executive", "wheelchair_accessible"],
    fuelType: "ICE", passengerCapacity: 4, status: "active"
  }, client);
  assert.ok(params.some((values) => values[1] === true));
  params.length = 0;
  await createVehicle({
    registration: "AB2", make: "Make", model: "Model", classKeys: ["executive"],
    fuelType: "ICE", passengerCapacity: 4, status: "active"
  }, client);
  assert.ok(params.some((values) => values[1] === false));
});

test("document replacement preserves history and only latest documents are returned", async () => {
  const calls: string[] = [];
  const client: any = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes("SELECT id, document_type")) {
        return { rows: [{ id: "new-doc", document_type: "insurance", expires_on: "2099-02-15", mime_type: "application/pdf" }] };
      }
      if (sql.includes("SELECT * FROM vehicle_documents")) {
        return { rows: [{ id: "new-doc", content: Buffer.from("ok") }] };
      }
      return { rows: [] };
    }
  };
  await createVehicleDocument({
    vehicleId: "v1", documentType: "insurance", expiresOn: "2099-02-15",
    originalFilename: "insurance.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.7")
  }, client);
  await listVehicleDocuments("v1", client);
  await getVehicleDocument("new-doc", client);
  assert.ok(calls.some((call) => call.includes("SET is_latest = FALSE")));
  assert.ok(calls.some((call) => call.includes("is_latest)")));
  assert.ok(calls.some((call) => call.includes("WHERE vehicle_id=$1 AND is_latest = TRUE")));
  assert.ok(calls.some((call) => call.includes("WHERE id=$1 AND is_latest = TRUE")));
});

test("baggage seed catalogue keeps required keys, weights, and nullable dimensions", () => {
  assert.deepEqual(BAGGAGE_CATEGORIES, [
    ["xl_suitcase", "XL suitcase", 31, null],
    ["l_suitcase", "L suitcase", null, 23],
    ["cabin_bag", "CB cabin bag", null, 12],
    ["backpack", "BP backpack", null, 8]
  ]);
});

test("help keys resolve centrally with a safe unknown-key fallback", () => {
  assert.equal(resolveHelpContent("vehicle.classAssignment").title, "Vehicle class assignment");
  assert.equal(resolveHelpContent("baggage.backpack").title, "BP backpack");
  assert.equal(resolveHelpContent("unknown.key").title, "Help unavailable");
});

test("document preview modal renders accessible Print, Download, and Close actions", async () => {
  const rendered = await ejs.renderFile(
    path.join(process.cwd(), "src/views/partials/document-preview.ejs"),
    { id: "doc-1", label: "Insurance", href: "/vehicles/documents/doc-1", mimeType: "application/pdf" }
  );
  assert.match(rendered, /<dialog/);
  assert.match(rendered, />Print</);
  assert.match(rendered, />Download</);
  assert.match(rendered, />Close</);
  assert.match(rendered, /\/vehicles\/documents\/doc-1\?download=1/);
});
