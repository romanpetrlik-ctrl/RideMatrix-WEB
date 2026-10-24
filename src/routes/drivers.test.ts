import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createCsrfProtection } from "../middleware/csrf";
import type { SessionAccount } from "../services/api";
import { DriverProfile, DriverProfileInput } from "../services/drivers";
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
  const { server, baseUrl } = await makeServer(["admin"], async () => {}, {
    getDriverById: async () => legacyDriver,
    listDriverEntityDocuments: async () => [],
    listDriverLicenses: async () => [],
    listLicensingAuthoritiesForManagement: async () => [],
    updateDriverProfile: async (_driverId, input) => {
      savedProfile = input;
      return {
        ...legacyDriver,
        ...input,
        shortName: "Riley E",
        displayName: "Riley Example",
        profileComplete: true
      };
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
