import assert from "node:assert/strict";
import test from "node:test";
import {
  importOtsBookingFromLink,
  OtsBookingImportError,
  parseOtsBookingHtml,
  validateOtsBookingUrl,
  type OtsBookingSnapshot
} from "./ots-booking-import";

const link = (query = "r=OTS-123&s=redacted&j=redacted&h=redacted&w=redacted") =>
  `https://ots-system.net/respond.php?${query}`;

const sanitizedHtml = `
  <!doctype html>
  <html><body>
    <table>
      <tr><th>Pickup date</th><td>12/06/2026</td></tr>
      <tr><th>Pickup time</th><td>14:35</td></tr>
      <tr><th>Pickup location</th><td>Example Station, London</td></tr>
      <tr><th>Destination</th><td>Example Road, London</td></tr>
      <tr><th>Number of passengers</th><td>2</td></tr>
      <tr><th>Passenger name</th><td>Redacted Passenger</td></tr>
    </table>
  </body></html>
`;

test("OTS parser extracts booking details from sanitized label/value HTML", () => {
  const parsed = parseOtsBookingHtml(sanitizedHtml, "OTS-123");
  assert.deepEqual(parsed, {
    reservationId: "OTS-123",
    pickupTime: "12/06/2026 14:35",
    pickup: "Example Station, London",
    dropoff: "Example Road, London",
    passengerCount: 2,
    passengerName: "Redacted Passenger"
  });
});

test("OTS URL validation requires the exact HTTPS host and all five query parameters", () => {
  assert.equal(validateOtsBookingUrl(link()).reservationId, "OTS-123");
  assert.throws(() => validateOtsBookingUrl(link().replace("ots-system.net", "example.test")), OtsBookingImportError);
  assert.throws(() => validateOtsBookingUrl(link("r=OTS-123&s=redacted&j=redacted&h=redacted")), /r, s, j, h a w/);
  assert.throws(() => validateOtsBookingUrl(link("r=OTS-123&s=redacted&j=redacted&h=redacted&action=Accept")), /r, s, j, h a w/);
});

test("duplicate OTS reservation IDs are rejected before fetching the expiring link", async () => {
  const savedIds = new Set<string>();
  let fetchCount = 0;
  const snapshots: OtsBookingSnapshot[] = [];
  const dependencies = {
    findExisting: async (reservationId: string) => savedIds.has(reservationId),
    fetchHtml: async () => {
      fetchCount += 1;
      return sanitizedHtml;
    },
    save: async (input: { reservationId: string; snapshot: OtsBookingSnapshot }) => {
      savedIds.add(input.reservationId);
      snapshots.push(input.snapshot);
      return true;
    }
  };
  const actor = { accountId: "admin-1", email: "admin@example.test" };

  const first = await importOtsBookingFromLink(link(), actor, dependencies);
  const duplicate = await importOtsBookingFromLink(link(), actor, dependencies);

  assert.equal(first.status, "imported");
  assert.deepEqual(duplicate, { status: "duplicate", reservationId: "OTS-123" });
  assert.equal(fetchCount, 1);
  assert.equal(snapshots.length, 1);
});

test("OTS parser explains unrecognized page structure", () => {
  assert.throws(
    () => parseOtsBookingHtml("<html><body>Unrecognized OTS page</body></html>", "OTS-123"),
    /Strukturu stránky OTS se nepodařilo rozpoznat/
  );
});
