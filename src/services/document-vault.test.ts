import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildEntityVaultRelativeDir,
  buildEntityVaultRelativePath,
  readVaultFile,
  sanitizeFolderSegment,
  sanitizeOriginalFilename,
  writeVaultFile
} from "./document-vault";

test("sanitizeFolderSegment removes unsafe path chars", () => {
  assert.equal(sanitizeFolderSegment("../John Smith\\.."), "john-smith");
  assert.equal(sanitizeFolderSegment("  "), "unknown");
});

test("sanitizeOriginalFilename strips traversal and control chars", () => {
  assert.equal(sanitizeOriginalFilename("../evil.pdf"), "evil.pdf");
  assert.equal(sanitizeOriginalFilename("..\u0000"), "document");
});

test("buildEntityVaultRelativeDir creates year-first vehicle structure", () => {
  const result = buildEntityVaultRelativeDir({
    entityType: "vehicle",
    uploadedAt: "2026-03-01T12:00:00.000Z",
    entityId: "veh_123",
    registrationOrBadge: "AB12 CDE",
    vehicleLicenseType: "hackney_carriage"
  });
  assert.equal(result, "2026/Vehicles/HC/ab12-cde__veh-123");
});

test("buildEntityVaultRelativePath includes category and extension", () => {
  const result = buildEntityVaultRelativePath({
    entityType: "driver",
    uploadedAt: "2027-01-01T00:00:00.000Z",
    entityId: "drv_456",
    displayName: "John Smith",
    category: "MEC",
    originalFilename: "page-1.PDF"
  });
  assert.match(result, /^2027\/Drivers\/john-smith__drv-456\/mec\/[a-f0-9-]+\.pdf$/);
});

test("writeVaultFile/readVaultFile accept valid relative path", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "docuvault-"));
  try {
    const relativePath = "2026/Vehicles/HC/ab12-cde__veh-123/mot/file.pdf";
    const content = Buffer.from("%PDF-1.7 ok");
    await writeVaultFile(relativePath, content, vaultRoot);
    const loaded = await readVaultFile(relativePath, vaultRoot);
    assert.deepEqual(loaded, content);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("writeVaultFile/readVaultFile reject ../ traversal", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "docuvault-"));
  try {
    await assert.rejects(() => writeVaultFile("../escape.txt", Buffer.from("x"), vaultRoot), /Invalid vault path\./);
    await assert.rejects(() => readVaultFile("../escape.txt", vaultRoot), /Invalid vault path\./);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("writeVaultFile/readVaultFile reject absolute outside-root path", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "docuvault-"));
  try {
    const outsidePath = path.resolve(vaultRoot, "..", "outside.txt");
    await assert.rejects(() => writeVaultFile(outsidePath, Buffer.from("x"), vaultRoot), /Invalid vault path\./);
    await assert.rejects(() => readVaultFile(outsidePath, vaultRoot), /Invalid vault path\./);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("writeVaultFile/readVaultFile reject crafted escape input", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "docuvault-"));
  try {
    const craftedPath = "2026/./Vehicles/HC/ab12-cde__veh-123/../../.././../../escape.pdf";
    await assert.rejects(() => writeVaultFile(craftedPath, Buffer.from("x"), vaultRoot), /Invalid vault path\./);
    await assert.rejects(() => readVaultFile(craftedPath, vaultRoot), /Invalid vault path\./);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});
