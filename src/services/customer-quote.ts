import type { PriceLine, PriceLineType } from "./booking-pricing";

/** The subset of a saved booking price snapshot needed to present it to a customer. */
export type SavedPriceSnapshot = {
  status: "complete" | "incomplete";
  total: string | null;
  lines: PriceLine[];
};

export type CustomerQuoteLine = {
  label: string;
  /** Two-decimal GBP amount; discounts are negative. */
  amount: string;
};

export type CustomerQuote =
  | { status: "confirmed"; lines: CustomerQuoteLine[]; total: string }
  | { status: "not-confirmed"; lines: CustomerQuoteLine[]; total: null };

/**
 * Payable line types a customer may see. Parking and extra waiting are driver-managed, dead mileage is an
 * operational cost and fixed-fare lines are dispatcher diagnostics, so none of them is ever shown to customers.
 */
const CUSTOMER_LINE_TYPES: ReadonlySet<PriceLineType> = new Set<PriceLineType>([
  "ride-fare",
  "location-discount",
  "airport-pickup-fee",
  "airport-dropoff-fee",
  "poi-fee",
  "toll",
  "road-charge",
  "time-surcharge"
]);

/** Fee lines whose configured £0.00 is shown to explain the journey's configured charges. */
const ZERO_EXPLAINED_TYPES: ReadonlySet<PriceLineType> = new Set<PriceLineType>([
  "ride-fare",
  "airport-pickup-fee",
  "airport-dropoff-fee",
  "poi-fee"
]);

function toPennies(amount: string | null): bigint | null {
  if (amount === null) return null;
  const match = /^(-?)(\d{1,9})\.(\d{2})$/.exec(amount);
  if (!match) return null;
  const value = BigInt(match[2]) * 100n + BigInt(match[3]);
  return match[1] ? -value : value;
}

function suffix(label: string, prefix: string): string {
  return label.startsWith(prefix) ? label.slice(prefix.length).trim() : "";
}

/** Customer wording derived only from the snapshot line; internal rule names and diagnostics are dropped. */
function customerLabel(line: PriceLine): string {
  switch (line.type) {
    case "ride-fare":
      return "Ride fare";
    case "location-discount":
      return "Location discount";
    case "airport-pickup-fee": {
      const airport = suffix(line.label, "Airport pick-up fee —");
      return airport ? `Airport pick-up fee — ${airport}` : "Airport pick-up fee";
    }
    case "airport-dropoff-fee": {
      const airport = suffix(line.label, "Airport drop-off fee —");
      return airport ? `Airport drop-off fee — ${airport}` : "Airport drop-off fee";
    }
    case "poi-fee": {
      const location = suffix(line.label, "POI fee —");
      return location ? `Location fee — ${location}` : "Location fee";
    }
    case "toll":
      return "Tolls";
    case "road-charge": {
      const zone = suffix(line.label, "Road charge —");
      return zone ? `Road charge — ${zone}` : "Road / zone charge";
    }
    default:
      return "Time-based surcharge";
  }
}

/**
 * Builds the customer-safe presentation of a saved booking price snapshot. It never recalculates the price:
 * only applicable payable lines from the immutable snapshot are shown, each separately, and a total is
 * returned only when the snapshot is complete and its saved total equals the sum of the displayed lines.
 */
export function buildCustomerQuote(snapshot: SavedPriceSnapshot): CustomerQuote {
  const lines: CustomerQuoteLine[] = [];
  let sum = 0n;
  let confirmable = snapshot.status === "complete";
  for (const line of snapshot.lines) {
    if (line.status === "unresolved") {
      confirmable = false;
      continue;
    }
    if (line.status === "not-applicable" || !CUSTOMER_LINE_TYPES.has(line.type)) continue;
    const pennies = toPennies(line.amount);
    if (pennies === null) {
      confirmable = false;
      continue;
    }
    if (pennies === 0n && !ZERO_EXPLAINED_TYPES.has(line.type)) continue;
    sum += pennies;
    lines.push({ label: customerLabel(line), amount: line.amount! });
  }
  const savedTotal = toPennies(snapshot.total);
  if (confirmable && savedTotal !== null && savedTotal === sum && savedTotal >= 0n && lines.length) {
    return { status: "confirmed", lines, total: snapshot.total! };
  }
  return { status: "not-confirmed", lines, total: null };
}
