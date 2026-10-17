import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ejs from "ejs";

const requiredDocuments = [
  { id: "doc-v5c", type: "v5c", label: "V5C", status: "Uploaded", fileName: "v5c.pdf", uploadedAt: "2026-01-01T00:00:00.000Z" },
  { id: null, type: "mot", label: "MOT", status: "Missing", fileName: null, uploadedAt: null }
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
  assert.match(html, /V5C/);
  assert.match(html, /MOT/);
  assert.match(html, /Status: Uploaded/);
  assert.match(html, /Status: Missing/);
  assert.match(html, /Uploaded: <strong>v5c\.pdf<\/strong>/);
  assert.match(html, /href="\/vehicles\/documents\/doc-v5c"/);
  assert.match(html, /href="\/vehicles\/documents\/doc-v5c\?download=1"/);
  assert.match(html, /record-documents\/v5c/);
  assert.match(html, /record-documents\/mot/);
  assert.match(html, />Replace</);
  assert.match(html, />Upload</);
});

test("vehicle detail hides upload and replace actions when user cannot manage documents", async () => {
  const html = await renderDetail(false);
  assert.doesNotMatch(html, /record-documents\/v5c/);
  assert.doesNotMatch(html, /record-documents\/mot/);
  assert.doesNotMatch(html, />Replace</);
  assert.doesNotMatch(html, />Upload</);
  assert.doesNotMatch(html, /href="\/vehicles\/documents\/doc-v5c"/);
});
