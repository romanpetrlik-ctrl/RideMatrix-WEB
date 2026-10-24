import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ejs from "ejs";

const driverId = "4f241bd2-bdf8-4f46-b040-7d8092aef316";

async function renderDriverList(): Promise<string> {
  return ejs.renderFile(path.join(process.cwd(), "src/views/pages/drivers/index.ejs"), {
    title: "Drivers",
    appTitle: "RideMatrix Test",
    email: "admin@example.com",
    status: "",
    statuses: ["pending_review", "active", "rejected", "suspended", "archived"],
    notice: "",
    search: "",
    drivers: [{
      id: driverId,
      email: "legacy@example.com",
      status: "pending_review",
      firstName: null,
      lastName: null,
      shortName: null,
      displayName: "l***",
      profileComplete: false,
      licenceCount: 0,
      documentsCount: 0
    }],
    page: 1,
    perPage: 25,
    totalPages: 1,
    total: 1,
    startRecord: 1,
    endRecord: 1
  });
}

async function renderLegacyDriverDetail(): Promise<string> {
  return ejs.renderFile(path.join(process.cwd(), "src/views/pages/drivers/detail.ejs"), {
    title: "l***",
    appTitle: "RideMatrix Test",
    email: "admin@example.com",
    csrfField: '<input type="hidden" name="_csrf" value="test-token">',
    notice: "",
    driver: {
      id: driverId,
      email: "legacy@example.com",
      status: "pending_review",
      firstName: null,
      lastName: null,
      shortName: null,
      displayName: "l***",
      profileComplete: false,
      createdAt: null,
      updatedAt: null
    },
    documents: [],
    licences: [],
    documentLabels: [],
    authorities: [],
    editingLicenseId: ""
  });
}

async function renderDriverForm(isNew: boolean, driverId: string): Promise<string> {
  return ejs.renderFile(path.join(process.cwd(), "src/views/pages/drivers/form.ejs"), {
    title: isNew ? "New driver" : "Complete driver profile",
    appTitle: "RideMatrix Test",
    email: "admin@example.com",
    csrfField: '<input type="hidden" name="_csrf" value="test-token">',
    errors: [],
    isNew,
    driverId,
    firstName: "",
    lastName: "",
    shortName: "",
    accountOptions: [{ id: driverId, email: "legacy@example.com" }]
  });
}

test("driver list uses a human-readable legacy label and keeps the UUID secondary", async () => {
  const html = await renderDriverList();

  assert.ok(html.includes(`<a href="/drivers/${driverId}">`));
  assert.match(html, /<strong>l\*\*\*<\/strong>/);
  assert.ok(html.includes(`<small class="driver-id-meta">${driverId}</small>`));
  assert.doesNotMatch(html, new RegExp(`<a[^>]*><strong>Driver #${driverId}`));
  assert.match(html, /Save note and archive/);
});

test("driver detail renders missing profile fields as a complete-profile state", async () => {
  const html = await renderLegacyDriverDetail();

  assert.match(html, /Complete profile/);
  assert.match(html, /This legacy driver record is missing profile details/);
  assert.match(html, /Not provided/);
  assert.match(html, /Save note and archive/);
  assert.doesNotMatch(html, /Unable to continue/);
});

test("new-driver validation retains the new-driver action when an account id is selected", async () => {
  const html = await renderDriverForm(true, driverId);

  assert.match(html, /action="\/drivers\/new"/);
  assert.match(html, new RegExp(`<input value="${driverId}" readonly>`));
});
