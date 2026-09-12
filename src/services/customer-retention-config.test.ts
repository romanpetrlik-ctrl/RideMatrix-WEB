import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarMonths, readCustomerRetentionPolicy } from "./customer-retention-config";

test("retention policy uses safe defaults and rejects invalid values", () => {
  assert.deepEqual(readCustomerRetentionPolicy({
    CUSTOMER_INACTIVITY_MONTHS: "0",
    CUSTOMER_RETENTION_MONTHS: "-2",
    CUSTOMER_PURGE_MODE: "unknown"
  }), {
    inactivityMonths: 12,
    retentionMonths: 24,
    purgeMode: "anonymize"
  });
});

test("calendar month arithmetic preserves end-of-month semantics", () => {
  assert.equal(
    addCalendarMonths(new Date("2024-01-31T00:00:00.000Z"), 1).toISOString(),
    "2024-02-29T00:00:00.000Z"
  );
});
