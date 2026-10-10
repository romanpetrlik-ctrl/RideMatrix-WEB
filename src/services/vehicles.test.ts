import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import ejs from "ejs";
import { BAGGAGE_CATEGORIES } from "../database/seed";
import { resolveHelpContent } from "./help";
import {
  consumeVehicleDocumentUploadRateLimit,
  consumeVehicleDocumentDownloadRateLimit,
  consumeVehicleMutationRateLimit,
  createVehicleDocument,
  createVehicle,
  getVehicleDocument,
  getDocumentStatus,
  listVehicleClasses,
  listVehicleDocuments,
  listVehicles,
  normalizeVehicleStatusFilter,
  updateVehicle,
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

test("vehicle edits preserve zero-valued legacy year and baggage capacity", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: any = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.startsWith("UPDATE vehicles SET registration")) return { rowCount: 1, rows: [] };
      if (sql.startsWith("SELECT v.*")) {
        return { rows: [{
          id: "v1", registration: "AB1", make: "Make", model: "Model", year: 0, colour: null,
          registered_keeper_details: null, fuel_type: "ICE", passenger_capacity: 4, status: "active",
          wheelchair_accessible: true, classes: [{ key: "wheelchair_accessible", label: "Wheelchair Accessible" }],
          capacities: [{ categoryKey: "xl_suitcase", maxQuantity: 0 }], documents_count: 0
        }] };
      }
      return { rows: [] };
    }
  };

  await updateVehicle("v1", {
    registration: "AB1", make: "Make", model: "Model", year: 0,
    classKeys: ["wheelchair_accessible"], fuelType: "ICE", passengerCapacity: 4, status: "active",
    baggageCapacities: { xl_suitcase: 0 }
  }, client);

  const vehicleUpdate = calls.find(({ sql }) => sql.startsWith("UPDATE vehicles SET registration"));
  assert.equal(vehicleUpdate?.params[4], 0);
  assert.ok(calls.some(({ sql, params }) => sql.includes("INSERT INTO vehicle_baggage_capacities") && params[2] === 0));
});

test("document replacement preserves per-licence history, metadata, and the current marker", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const bytes = Buffer.from("%PDF-1.7");
  const client: any = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT d.id")) {
        return { rows: [{ id: "new-doc", document_type: "hackney_ph_badge", expires_on: "2099-02-15", mime_type: "application/pdf", is_latest: true }] };
      }
      if (sql.includes("SELECT * FROM vehicle_documents")) {
        return { rows: [{ id: "new-doc", content: Buffer.from("ok") }] };
      }
      if (sql.includes("SELECT 1 FROM vehicle_licensing_authorities")) return { rows: [{ "?column?": 1 }] };
      return { rows: [], rowCount: 1 };
    }
  };
  await createVehicleDocument({
    vehicleId: "v1", licenseId: "license-1", documentType: "hackney_ph_badge", expiresOn: "2099-02-15",
    originalFilename: "license.pdf", mimeType: "application/pdf", content: bytes, uploadedBy: "admin-1"
  }, client);
  await listVehicleDocuments("v1", client);
  await getVehicleDocument("new-doc", client);
  const supersede = calls.find(({ sql }) => sql.includes("SET is_latest = FALSE"));
  assert.ok(supersede);
  assert.match(supersede.sql, /license_id IS NOT DISTINCT FROM \$4/);
  assert.equal(supersede.params[3], "license-1");
  const insert = calls.find(({ sql }) => sql.includes("INSERT INTO vehicle_documents"));
  assert.ok(insert);
  assert.ok(insert.sql.includes("byte_size, checksum"));
  assert.equal(insert.params[9], bytes.length);
  assert.equal(insert.params[10], createHash("sha256").update(bytes).digest("hex"));
  assert.equal(insert.params[12], "admin-1");
  assert.ok(calls.some(({ sql }) => sql.includes("WHERE d.vehicle_id=$1")));
  assert.ok(calls.some(({ sql }) => sql.includes("WHERE id=$1")));
});

test("document metadata rejects empty content and remains scoped to the selected licence", async () => {
  await assert.rejects(createVehicleDocument({
    vehicleId: "v1", documentType: "insurance", expiresOn: "2099-01-01", content: Buffer.alloc(0)
  }, { query: async () => ({ rows: [] }) } as any), /non-empty/);
});

test("vehicle document download rate limiting uses the shared atomic database counter", async () => {
  let params: unknown[] = [];
  const client: any = {
    async query(_sql: string, values: unknown[]) {
      params = values;
      return { rows: [{ allowed: false }] };
    }
  };
  assert.equal(await consumeVehicleDocumentDownloadRateLimit("vehicle-document-download:u1", client), false);
  assert.equal(params[0], "vehicle-document-download:u1");
  assert.equal(params[1], 120);
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

test("vehicle directory status filter only accepts known statuses and is passed as a bound parameter", async () => {
  assert.equal(normalizeVehicleStatusFilter("active"), "active");
  assert.equal(normalizeVehicleStatusFilter(" Maintenance "), "maintenance");
  assert.equal(normalizeVehicleStatusFilter("' OR 1=1 --"), "");
  assert.equal(normalizeVehicleStatusFilter(["active"]), "");
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: any = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return sql.includes("count(*)") ? { rows: [{ count: "0" }] } : { rows: [] };
    }
  };
  const result = await listVehicles({ search: "ab", status: "active", client });
  assert.equal(result.status, "active");
  assert.deepEqual(calls[0].params, ["ab", "active"]);
  assert.deepEqual(calls[1].params.slice(0, 2), ["ab", "active"]);
  assert.ok(calls.every((call) => call.sql.includes("v.status = $2")));
  const unfiltered = await listVehicles({ status: "bogus", client });
  assert.equal(unfiltered.status, "");
  assert.equal(calls[2].params[1], "");
});

test("vehicle joins compare auth user ids as text so UUID users.id columns are supported", async () => {
  const calls: string[] = [];
  const client: any = { async query(sql: string) { calls.push(sql); return sql.includes("count(*)") ? { rows: [{ count: "0" }] } : { rows: [] }; } };
  await listVehicles({ client });
  assert.match(calls[1], /JOIN users u ON u\.id::text = a\.driver_id/);
});
