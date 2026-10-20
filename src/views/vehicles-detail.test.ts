import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ejs from "ejs";

const requiredDocuments = [
  {
    type: "v5c",
    label: "V5C",
    files: [{ id: "doc-v5c", original_filename: "v5c.pdf", uploaded_at: "2026-01-01T00:00:00.000Z" }]
  },
  { type: "mot", label: "MOT", files: [] }
];

async function renderDetail(canManageVehicleDocuments: boolean, overrides: Record<string, unknown> = {}): Promise<string> {
  return ejs.renderFile(path.join(process.cwd(), "src/views/pages/vehicles/detail.ejs"), {
    title: "AB12 CDE",
    appTitle: "RideMatrix Test",
    email: "admin@example.com",
    csrfField: '<input type="hidden" name="_csrf" value="test-token">',
    vehicle: {
      id: "vehicle-1",
      registration: "AB12 CDE",
      make: "Toyota",
      model: "Prius",
      status: "active",
      classes: [],
      fuelType: "HYBRID",
      passengerCapacity: 4,
      capacities: [],
      driverId: null,
      driverEmail: null,
      driverDisplayName: null,
      wheelchairAccessible: false
    },
    requiredDocuments,
    canManageVehicleDocuments,
    maxFilesPerCategory: 5,
    uploadStatuses: [],
    documents: [],
    licenses: [],
    editingLicenseId: "",
    authorities: [],
    licenseTypes: [],
    drivers: [],
    driverSourceAvailable: true,
    driverAssignments: [],
    documentTypes: [],
    helpFor: () => ({ title: "Help", body: "Help body." }),
    notice: "",
    ...overrides
  });
}

test("vehicle detail required document rows show uploaded/missing states and manager actions", async () => {
  const html = await renderDetail(true);
  assert.match(html, /<h2>Vehicle documents<\/h2>/);
  assert.doesNotMatch(html, /<h2>Compliance documents<\/h2>/);
  assert.doesNotMatch(html, /action="\/vehicles\/vehicle-1\/documents"/);
  assert.match(html, /<h3>Upload documents<\/h3>/);
  assert.match(html, /Upload selected documents/);
  assert.match(html, /Add to upload queue/);
  assert.match(html, /recordDocumentBatchForm/);
  assert.match(html, /recordDocumentQueue/);
  assert.match(html, /vehicle-record-document-upload\.js/);
  assert.match(html, /<h3>Existing documents by category<\/h3>/);
  assert.match(html, /V5C/);
  assert.match(html, /MOT/);
  assert.match(html, /Status:\s*<span[^>]*>Uploaded<\/span>/);
  assert.match(html, /Status:\s*<span[^>]*>Missing<\/span>/);
  assert.match(html, /Uploaded: <strong>v5c\.pdf<\/strong>/);
  assert.match(html, /href="\/vehicles\/record-documents\/doc-v5c\/view"/);
  assert.match(html, /href="\/vehicles\/record-documents\/doc-v5c\/download"/);
  assert.match(html, /record-documents\/upload/);
  assert.match(html, /Tip: select multiple files using Ctrl \(Windows\/Linux\) or ⌘ Command \(macOS\) while clicking files\./);
});

test("vehicle detail hides upload and replace actions when user cannot manage documents", async () => {
  const html = await renderDetail(false);
  assert.doesNotMatch(html, /record-documents\/upload/);
  assert.doesNotMatch(html, /Upload selected documents/);
  assert.doesNotMatch(html, /vehicle-record-document-upload\.js/);
  assert.match(html, /href="\/vehicles\/record-documents\/doc-v5c\/view"/);
});

test("linked driver section renders safe labels without visible emails", async () => {
  const html = await renderDetail(true, {
    vehicle: {
      id: "vehicle-1",
      registration: "AB12 CDE",
      make: "Toyota",
      model: "Prius",
      status: "active",
      classes: [],
      fuelType: "HYBRID",
      passengerCapacity: 4,
      capacities: [],
      driverId: "driver-1",
      driverEmail: "driver@example.com",
      driverDisplayName: "Driver #driver-1",
      wheelchairAccessible: false
    },
    drivers: [
      { id: "driver-1", email: "driver@example.com", displayName: "Alice Driver" },
      { id: "driver-2", email: "second@example.com", displayName: "" }
    ],
    driverAssignments: [
      { driver_id: "driver-1", driver_email: "driver@example.com", driver_display_name: "Alice Driver", assigned_at: "2026-01-01", unassigned_at: "2026-01-02" },
      { driver_id: "driver-2", driver_email: "second@example.com", driver_display_name: "Driver #driver-2", assigned_at: "2026-01-03", unassigned_at: null }
    ]
  });
  const linkedSection = /<section class="vehicle-card"><h2>Linked driver<\/h2>[\s\S]*?<\/section>/.exec(html)?.[0] || "";
  assert.ok(linkedSection);
  assert.match(linkedSection, /Alice Driver/);
  assert.match(linkedSection, /Driver #driver-2/);
  assert.doesNotMatch(linkedSection, /driver@example\.com|second@example\.com|@/);
});

test("vehicle licences render read-only by default and switch to edit mode only when requested", async () => {
  const licenses = [{
    id: "license-1",
    licensingAuthorityName: "City Council",
    licensingAuthorityId: "authority-1",
    licenseType: "hackney_carriage",
    vehicleLicenseBadge: "HC-1",
    licenseReference: "REF-1",
    validFrom: "2026-01-01",
    validUntil: "2026-12-31",
    notes: "Test note",
    active: true
  }];
  const readOnlyHtml = await renderDetail(true, { licenses, authorities: [{ id: "authority-1", name: "City Council", active: true }], licenseTypes: ["hackney_carriage", "private_hire"] });
  assert.match(readOnlyHtml, /Edit licence/);
  assert.match(readOnlyHtml, /Vehicle licence badge<\/dt><dd>HC-1<\/dd>/);
  assert.doesNotMatch(readOnlyHtml, /name="licenseId" value="license-1"/);

  const editingHtml = await renderDetail(true, {
    licenses,
    editingLicenseId: "license-1",
    authorities: [{ id: "authority-1", name: "City Council", active: true }],
    licenseTypes: ["hackney_carriage", "private_hire"]
  });
  assert.match(editingHtml, /name="licenseId" value="license-1"/);
  assert.match(editingHtml, /Save licence/);
  assert.match(editingHtml, /href="\/vehicles\/vehicle-1">Cancel<\/a>/);
});

test("linked driver section disables assignment and shows no-drivers helper when source is unavailable", async () => {
  const html = await renderDetail(true, {
    drivers: [],
    driverSourceAvailable: false
  });
  const linkedSection = /<section class="vehicle-card"><h2>Linked driver<\/h2>[\s\S]*?<\/section>/.exec(html)?.[0] || "";
  assert.match(linkedSection, /<select id="driverId" name="driverId" disabled>/);
  assert.match(linkedSection, /type="submit" disabled>Save assignment<\/button>/);
  assert.match(linkedSection, /No drivers available\./);
  assert.doesNotMatch(linkedSection, /driver@example\.com|@/);
});
