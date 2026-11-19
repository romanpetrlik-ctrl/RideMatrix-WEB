import assert from "node:assert/strict";
import test from "node:test";
import type { PriceLine } from "./booking-pricing";
import { buildCustomerQuote } from "./customer-quote";

const line = (overrides: Partial<PriceLine> & Pick<PriceLine, "type" | "status">): PriceLine => ({
  label: overrides.type,
  amount: null,
  basis: "internal basis text",
  source: { ruleId: "rule-uuid-1", fareSettingsVersion: 9 },
  ...overrides
});

const completeLines: PriceLine[] = [
  line({ type: "ride-fare", label: "Ride fare", status: "applied", amount: "40.00" }),
  line({ type: "location-discount", label: "Location discount: Internal BH rule", status: "applied", amount: "-4.00" }),
  line({ type: "airport-pickup-fee", label: "Airport pick-up fee — Heathrow", status: "applied", amount: "7.00" }),
  line({ type: "airport-dropoff-fee", label: "Airport drop-off fee", status: "not-applicable" }),
  line({ type: "poi-fee", label: "POI fee — Stadium: drop-off", status: "zero", amount: "0.00" }),
  line({ type: "toll", label: "Toll charges", status: "not-applicable" }),
  line({ type: "road-charge", label: "Road / zone charges", status: "not-applicable" }),
  line({ type: "dead-mileage", label: "Dead mileage", status: "not-applicable" })
];

test("customer quote lists only applicable payable lines, keeps fees and discount separate, and totals them", () => {
  const quote = buildCustomerQuote({ status: "complete", total: "43.00", lines: completeLines });
  assert.deepEqual(quote, {
    status: "confirmed",
    total: "43.00",
    lines: [
      { label: "Ride fare", amount: "40.00" },
      { label: "Location discount", amount: "-4.00" },
      { label: "Airport pick-up fee — Heathrow", amount: "7.00" },
      { label: "Location fee — Stadium: drop-off", amount: "0.00" }
    ]
  });
  const serialized = JSON.stringify(quote);
  for (const hidden of ["Internal BH rule", "internal basis", "rule-uuid-1", "fareSettingsVersion", "not-applicable", "Dead mileage", "POI"]) {
    assert.ok(!serialized.includes(hidden), `${hidden} must not be exposed`);
  }
});

test("customer quote never confirms a total for incomplete snapshots or unresolved lines", () => {
  const unresolvedRoad = [...completeLines, line({ type: "road-charge", label: "Road charge — London ULEZ", status: "unresolved" })];
  const incomplete = buildCustomerQuote({ status: "incomplete", total: null, lines: unresolvedRoad });
  assert.equal(incomplete.status, "not-confirmed");
  assert.equal(incomplete.total, null);
  assert.ok(!JSON.stringify(incomplete).includes("ULEZ"));

  // A hidden unresolved line still prevents confirmation, even though it is never displayed.
  const hiddenUnresolved = buildCustomerQuote({ status: "incomplete", total: null, lines: [...completeLines.slice(0, 3), line({ type: "dead-mileage", status: "unresolved" })] });
  assert.equal(hiddenUnresolved.status, "not-confirmed");
  assert.equal(hiddenUnresolved.total, null);

  // Defensive: a snapshot marked complete must still have no unresolved lines and a non-null total.
  assert.equal(buildCustomerQuote({ status: "complete", total: "43.00", lines: unresolvedRoad }).status, "not-confirmed");
  assert.equal(buildCustomerQuote({ status: "complete", total: null, lines: completeLines }).status, "not-confirmed");
});

test("customer quote is not confirmed when the saved total differs from the displayed lines", () => {
  assert.equal(buildCustomerQuote({ status: "complete", total: "50.00", lines: completeLines }).status, "not-confirmed");
  const hiddenCharge = [...completeLines, line({ type: "dead-mileage", status: "applied", amount: "5.00" })];
  assert.equal(buildCustomerQuote({ status: "complete", total: "48.00", lines: hiddenCharge }).status, "not-confirmed");
});
