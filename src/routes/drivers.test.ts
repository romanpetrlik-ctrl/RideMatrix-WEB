import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import type { SessionAccount } from "../services/api";
import { DriverLicenseRecord, DriverProfile, DriverProfileInput, DriverValidationError } from "../services/drivers";
import { createDriversRouter } from "./drivers";

const legacyDriver: DriverProfile = {
  id: "driver-legacy",
  email: "legacy@example.com",
  status: "pending_review",
  firstName: null,
  lastName: null,
  shortName: "Driver #driver-legacy",
  displayName: "l***",
  profileComplete: false,
  createdAt: null,
  updatedAt: null
};

async function makeServer(
  roles: string[],
  onArchive: (input: unknown) => Promise<void>,
  overrides: Partial<Parameters<typeof createDriversRouter>[0]> = {}
): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/views"));
  app.use(express.urlencoded({ extended: true }));
  app.use(createCsrfProtection({ appTitle: "Test" }));
  app.get("/csrf", (_req, res) => res.json({ token: res.locals.csrfToken }));
  app.use(createDriversRouter({
    appTitle: "Test",
    loadSession: async (): Promise<SessionAccount> => ({
      authenticated: true,
      user: { id: "admin-1", email: "admin@example.com", roles }
    }),
    transitionDriverStatus: async (input) => onArchive(input),
    ...overrides
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("authorized driver managers can archive a record with a reason", async () => {
  let transitionInput: any;
  const { server, baseUrl } = await makeServer(["admin"], async (input) => {
    transitionInput = input;
  });

  try {
    const tokenResponse = await fetch(`${baseUrl}/csrf`);
    const { token } = await tokenResponse.json() as { token: string };
    const cookie = tokenResponse.headers.get("set-cookie")?.split(";")[0] || "";
    const body = new URLSearchParams({ _csrf: token, reason: "Duplicate legacy record" });
    const response = await fetch(`${baseUrl}/drivers/driver-legacy/archive`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual"
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/drivers/driver-legacy?notice=archived");
    assert.deepEqual(transitionInput, {
      driverId: "driver-legacy",
      status: "archived",
      reason: "Duplicate legacy record",
      actorId: "admin-1",
      actorEmail: "admin@example.com"
    });
  } finally {
    await closeServer(server);
  }
});

test("driver archive action rejects users without driver management permission", async () => {
  let transitionCalled = false;
  const { server, baseUrl } = await makeServer([], async () => {
    transitionCalled = true;
  });

  try {
    const tokenResponse = await fetch(`${baseUrl}/csrf`);
    const { token } = await tokenResponse.json() as { token: string };
    const cookie = tokenResponse.headers.get("set-cookie")?.split(";")[0] || "";
    const response = await fetch(`${baseUrl}/drivers/driver-legacy/archive`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token, reason: "Not authorized" }),
      redirect: "manual"
    });

    assert.equal(response.status, 403);
    assert.equal(transitionCalled, false);
  } finally {
    await closeServer(server);
  }
});

test("legacy driver detail opens and exposes a complete-profile edit flow", async () => {
  let savedProfile: DriverProfileInput | null = null;
  let currentDriver = legacyDriver;
  const { server, baseUrl } = await makeServer(["admin"], async () => {}, {
    getDriverById: async () => currentDriver,
    listDriverEntityDocuments: async () => [],
    listDriverLicenses: async () => [],
    listLicensingAuthoritiesForManagement: async () => [],
    updateDriverProfile: async (_driverId, input) => {
      savedProfile = input;
      currentDriver = {
        ...legacyDriver,
        ...input,
        shortName: "Riley E",
        displayName: "Riley Example",
        profileComplete: true
      };
      return currentDriver;
    }
  });

  try {
    const detail = await fetch(`${baseUrl}/drivers/driver-legacy`);
    const detailHtml = await detail.text();
    assert.equal(detail.status, 200);
    assert.match(detailHtml, /Complete profile/);
    assert.match(detailHtml, /This legacy driver record is missing profile details/);

    const edit = await fetch(`${baseUrl}/drivers/driver-legacy/edit`);
    const editHtml = await edit.text();
    assert.equal(edit.status, 200);
    assert.match(editHtml, /Complete driver profile/);
    assert.match(editHtml, />Save<\/button>/);
    assert.match(editHtml, /href="\/drivers\/driver-legacy">Cancel<\/a>/);

    const tokenResponse = await fetch(`${baseUrl}/csrf`);
    const { token } = await tokenResponse.json() as { token: string };
    const cookie = tokenResponse.headers.get("set-cookie")?.split(";")[0] || "";
    const saveResponse = await fetch(`${baseUrl}/drivers/driver-legacy/edit`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token, firstName: "Riley", lastName: "Example" }),
      redirect: "manual"
    });

    assert.equal(saveResponse.status, 302);
    assert.equal(saveResponse.headers.get("location"), "/drivers/driver-legacy?notice=updated");
    assert.deepEqual(savedProfile, { firstName: "Riley", lastName: "Example" });
    const updatedDetail = await fetch(`${baseUrl}/drivers/driver-legacy?notice=updated`);
    const updatedHtml = await updatedDetail.text();
    assert.equal(updatedDetail.status, 200);
    assert.match(updatedHtml, /Riley Example/);
    assert.match(updatedHtml, /Driver updated\./);
  } finally {
    await closeServer(server);
  }
});

test("driver licence creation saves mapped values and detail remains usable", async () => {
  let savedValues: Record<string, string> | null = null;
  const licenses: DriverLicenseRecord[] = [];
  const { server, baseUrl } = await makeServer(["admin"], async () => {}, {
    getDriverById: async () => legacyDriver,
    listDriverEntityDocuments: async () => [],
    listDriverLicenses: async () => licenses,
    listLicensingAuthoritiesForManagement: async () => [{
      id: "authority-1", name: "Example Council", authorityType: "local", active: true, preferenceOrder: 1
    }],
    saveDriverLicense: async (_driverId, values) => {
      savedValues = values as Record<string, string>;
      licenses.push({
        id: "licence-1",
        driverId: legacyDriver.id,
        licensingAuthorityId: values.licensingAuthorityId || null,
        licensingAuthorityName: "Example Council",
        licenseReference: values.licenseReference || null,
        validFrom: values.validFrom || "",
        validUntil: values.validUntil || null,
        active: true,
        revokedAt: null,
        notes: values.notes || null
      });
      return "licence-1";
    }
  });

  try {
    const tokenResponse = await fetch(`${baseUrl}/csrf`);
    const { token } = await tokenResponse.json() as { token: string };
    const cookie = tokenResponse.headers.get("set-cookie")?.split(";")[0] || "";
    const response = await fetch(`${baseUrl}/drivers/driver-legacy/licences`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: token,
        licensingAuthorityId: "authority-1",
        licenseReference: "REF-123",
        validFrom: "2026-01-01",
        validUntil: "2027-01-01",
        notes: "Renewal due next year"
      }),
      redirect: "manual"
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/drivers/driver-legacy?notice=licence-saved");
    assert.deepEqual(savedValues, {
      licensingAuthorityId: "authority-1",
      licenseReference: "REF-123",
      validFrom: "2026-01-01",
      validUntil: "2027-01-01",
      notes: "Renewal due next year"
    });

    const detail = await fetch(`${baseUrl}/drivers/driver-legacy?notice=licence-saved`);
    const html = await detail.text();
    assert.equal(detail.status, 200);
    assert.match(html, /Driver licence saved\./);
    assert.match(html, /REF-123/);
  } finally {
    await closeServer(server);
  }
});

test("Dorset Council can be selected and a driver licence is saved and listed", async () => {
  const savedValues: Record<string, string>[] = [];
  const licenses: DriverLicenseRecord[] = [];
  const { server, baseUrl } = await makeServer(["admin"], async () => {}, {
    getDriverById: async () => legacyDriver,
    listDriverEntityDocuments: async () => [],
    listDriverLicenses: async () => licenses,
    listLicensingAuthoritiesForManagement: async () => [],
    saveDriverLicense: async (_driverId, values) => {
      savedValues.push(values as Record<string, string>);
      licenses.push({
        id: "dorset-licence",
        driverId: legacyDriver.id,
        licensingAuthorityId: values.licensingAuthorityId || null,
        licensingAuthorityName: "Dorset Council",
        licenseReference: values.licenseReference || null,
        validFrom: values.validFrom || "",
        validUntil: values.validUntil || null,
        active: true,
        revokedAt: null,
        notes: values.notes || null
      });
      return "dorset-licence";
    }
  });

  try {
    const form = await fetch(`${baseUrl}/drivers/driver-legacy`);
    const formHtml = await form.text();
    assert.equal(form.status, 200);
    assert.match(formHtml, /<option value="dorset_council"[^>]*>Dorset Council<\/option>/);
    assert.match(formHtml, /name="licensingAuthorityId" required/);

    const tokenResponse = await fetch(`${baseUrl}/csrf`);
    const { token } = await tokenResponse.json() as { token: string };
    const cookie = tokenResponse.headers.get("set-cookie")?.split(";")[0] || "";
    const response = await fetch(`${baseUrl}/drivers/driver-legacy/licences`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: token,
        licensingAuthorityId: "dorset_council",
        licenseReference: "DORSET-123",
        validFrom: "2026-01-01"
      }),
      redirect: "manual"
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/drivers/driver-legacy?notice=licence-saved");
    assert.equal(savedValues[0]?.licensingAuthorityId, "dorset_council");

    const detail = await fetch(`${baseUrl}/drivers/driver-legacy?notice=licence-saved`);
    const detailHtml = await detail.text();
    assert.equal(detail.status, 200);
    assert.match(detailHtml, /Dorset Council/);
    assert.match(detailHtml, /DORSET-123/);
  } finally {
    await closeServer(server);
  }
});

test("invalid driver licence submission returns inline errors and retains entered values", async () => {
  const { server, baseUrl } = await makeServer(["admin"], async () => {}, {
    getDriverById: async () => legacyDriver,
    listDriverEntityDocuments: async () => [],
    listDriverLicenses: async () => [],
    listLicensingAuthoritiesForManagement: async () => [{
      id: "authority-1", name: "Example Council", authorityType: "local", active: true, preferenceOrder: 1
    }],
    saveDriverLicense: async () => {
      throw new DriverValidationError("Licence end date must be after its start date.");
    }
  });

  try {
    const tokenResponse = await fetch(`${baseUrl}/csrf`);
    const { token } = await tokenResponse.json() as { token: string };
    const cookie = tokenResponse.headers.get("set-cookie")?.split(";")[0] || "";
    const response = await fetch(`${baseUrl}/drivers/driver-legacy/licences`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: token,
        licensingAuthorityId: "authority-1",
        licenseReference: "KEEP-ME",
        validFrom: "2027-01-01",
        validUntil: "2026-01-01",
        notes: "Preserve these notes"
      }),
      redirect: "manual"
    });
    const html = await response.text();

    assert.equal(response.status, 400);
    assert.match(html, /Licence end date must be after its start date\./);
    assert.match(html, /value="KEEP-ME"/);
    assert.match(html, /value="Preserve these notes"/);
    assert.doesNotMatch(html, /Unable to continue/);
    assert.match(html, /Driver profile/);
  } finally {
    await closeServer(server);
  }
});

test("unexpected driver licence failure includes a reference and leaves detail stable", async () => {
  const { server, baseUrl } = await makeServer(["admin"], async () => {}, {
    getDriverById: async () => legacyDriver,
    listDriverEntityDocuments: async () => [],
    listDriverLicenses: async () => [],
    listLicensingAuthoritiesForManagement: async () => [{
      id: "authority-1", name: "Example Council", authorityType: "local", active: true, preferenceOrder: 1
    }],
    saveDriverLicense: async () => {
      throw new Error("database unavailable");
    }
  });

  try {
    const tokenResponse = await fetch(`${baseUrl}/csrf`);
    const { token } = await tokenResponse.json() as { token: string };
    const cookie = tokenResponse.headers.get("set-cookie")?.split(";")[0] || "";
    const response = await fetch(`${baseUrl}/drivers/driver-legacy/licences`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: token,
        licensingAuthorityId: "authority-1",
        licenseReference: "KEEP-ON-SERVER-ERROR",
        validFrom: "2026-01-01"
      }),
      redirect: "manual"
    });
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.match(body, /We couldn&#39;t save this licence/);
    assert.match(body, /Reference: [0-9a-f-]{36}/);
    assert.match(body, /KEEP-ON-SERVER-ERROR/);
    assert.doesNotMatch(body, /Unable to continue/);

    const detail = await fetch(`${baseUrl}/drivers/driver-legacy`);
    const detailBody = await detail.text();
    assert.equal(detail.status, 200);
    assert.match(detailBody, /Driver profile/);
    assert.doesNotMatch(detailBody, /Unable to continue/);
  } finally {
    await closeServer(server);
  }
});

test("driver detail EJS render failures return a correlation id instead of generic error", async () => {
  const { server, baseUrl } = await makeServer(["admin"], async () => {}, {
    getDriverById: async () => ({ ...legacyDriver, status: 7 } as unknown as DriverProfile),
    listDriverEntityDocuments: async () => [],
    listDriverLicenses: async () => [],
    listLicensingAuthoritiesForManagement: async () => []
  });

  try {
    const response = await fetch(`${baseUrl}/drivers/driver-legacy`);
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.match(body, /Driver record unavailable/);
    assert.match(body, /Reference: [0-9a-f-]{36}/);
    assert.doesNotMatch(body, /Unable to continue/);
  } finally {
    await closeServer(server);
  }
});
