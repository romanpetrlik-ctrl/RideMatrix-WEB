import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("vehicle record document metadata and audit are transactional and failed persistence removes the vault file", async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "ridematrix-documents-"));
  const originalVaultRoot = process.env.DOCUMENT_VAULT_ROOT;
  process.env.DOCUMENT_VAULT_ROOT = vaultRoot;

  try {
    const { saveVehicleEntityDocument } = await import("./vehicles.js");
    const file = {
      originalname: "vehicle.pdf",
      mimetype: "application/pdf",
      buffer: Buffer.from("%PDF-1.7")
    };
    const createPool = (failAudit = false) => {
      const transactionQueries: string[] = [];
      let storagePath = "";
      const tx = {
        async query(sql: string, values: unknown[] = []) {
          transactionQueries.push(sql);
          if (sql.includes("INSERT INTO entity_documents")) storagePath = String(values[7]);
          if (failAudit && sql.includes("INSERT INTO document_access_events")) throw new Error("audit failure");
          return { rows: [] };
        },
        release() {}
      };
      const pool = {
        async query(sql: string) {
          if (sql.includes("count(*)::text AS count") && sql.includes("FROM entity_documents")) {
            return { rows: [{ count: "0" }] };
          }
          if (sql.includes("SELECT registration, vehicle_license_type FROM vehicles")) {
            return { rows: [{ registration: "AB123", vehicle_license_type: "hackney_carriage" }] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        async connect() {
          return tx;
        }
      };
      return { pool, transactionQueries, getStoragePath: () => storagePath };
    };

    const successful = createPool();
    const saved = await saveVehicleEntityDocument({
      vehicleId: "vehicle-1",
      category: "mot",
      file,
      uploadedBy: "user-1"
    }, successful.pool as any);
    assert.ok(successful.transactionQueries[0] === "BEGIN");
    assert.ok(successful.transactionQueries.some((sql) => sql.includes("INSERT INTO entity_documents")));
    assert.ok(successful.transactionQueries.some((sql) => sql.includes("INSERT INTO document_access_events")));
    assert.ok(successful.transactionQueries.includes("COMMIT"));
    assert.deepEqual(await readFile(path.join(vaultRoot, successful.getStoragePath())), file.buffer);
    assert.ok(saved.id);

    const failed = createPool(true);
    await assert.rejects(
      saveVehicleEntityDocument({
        vehicleId: "vehicle-1",
        category: "mot",
        file,
        uploadedBy: "user-1"
      }, failed.pool as any),
      /audit failure/
    );
    assert.ok(failed.transactionQueries.includes("ROLLBACK"));
    assert.ok(!failed.transactionQueries.includes("COMMIT"));
    await assert.rejects(readFile(path.join(vaultRoot, failed.getStoragePath())), { code: "ENOENT" });
  } finally {
    if (originalVaultRoot === undefined) delete process.env.DOCUMENT_VAULT_ROOT;
    else process.env.DOCUMENT_VAULT_ROOT = originalVaultRoot;
    await rm(vaultRoot, { recursive: true, force: true });
  }
});
