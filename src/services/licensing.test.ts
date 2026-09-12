import assert from "node:assert/strict";
import test from "node:test";
import { isLicenseActive, selectDeterministicAuthority } from "./licensing";

test("active license semantics reject future, expired, and revoked records", () => {
  const at = "2026-01-15T12:00:00.000Z";
  const base = { active: true, revokedAt: null, validFrom: "2026-01-01T00:00:00.000Z", validUntil: null };
  assert.equal(isLicenseActive(base, at), true);
  assert.equal(isLicenseActive({ ...base, validFrom: "2026-02-01T00:00:00.000Z" }, at), false);
  assert.equal(isLicenseActive({ ...base, validUntil: "2026-01-15T12:00:00.000Z" }, at), false);
  assert.equal(isLicenseActive({ ...base, revokedAt: "2026-01-10T00:00:00.000Z" }, at), false);
  assert.equal(isLicenseActive({ ...base, active: false }, at), false);
});

test("authority selection is deterministic and honors configured preference order", () => {
  const selected = selectDeterministicAuthority([
    { id: "dorset", name: "Dorset Council", preferenceOrder: 20 },
    { id: "bcp", name: "BCP Council", preferenceOrder: 10 }
  ]);
  assert.equal(selected?.id, "bcp");
  assert.equal(selectDeterministicAuthority([]), null);
});
