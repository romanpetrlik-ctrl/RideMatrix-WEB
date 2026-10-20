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

async function renderDetail(canManageVehicleDocuments: boolean): Promise<string> {
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
      wheelchairAccessible: false
    },
    requiredDocuments,
    canManageVehicleDocuments,
    maxFilesPerCategory: 5,
    uploadStatuses: [],
    documents: [],
    licenses: [],
    authorities: [],
    licenseTypes: [],
    drivers: [],
    driverAssignments: [],
    documentTypes: [],
    helpFor: () => ({ title: "Help", body: "Help body." }),
    notice: ""
  });
}

test("vehicle detail required document rows show uploaded/missing states and manager actions", async () => {
  const html = await renderDetail(true);
  assert.match(html, /<h2>Vehicle documents<\/h2>/);
  assert.match(html, /<h3>Upload documents<\/h3>/);
  assert.match(html, /Upload selected documents/);
  assert.match(html, /Add to upload queue/);
  assert.match(html, /recordDocumentBatchForm/);
  assert.match(html, /recordDocumentQueue/);
  assert.match(html, /vehicle-record-document-upload\.js/);
  assert.match(html, /<h3>Existing documents by category<\/h3>/);
  assert.match(html, /V5C/);
  assert.match(html, /MOT/);
  assert.match(html, /Status: Uploaded/);
  assert.match(html, /Status: Missing/);
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
