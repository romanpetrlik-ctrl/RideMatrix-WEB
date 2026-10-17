import assert from "node:assert/strict";
import test from "node:test";
import { buildEntityVaultRelativeDir, buildEntityVaultRelativePath, sanitizeFolderSegment, sanitizeOriginalFilename } from "./document-vault";

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
