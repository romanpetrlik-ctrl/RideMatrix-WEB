import assert from "node:assert/strict";
import test from "node:test";
import {
  getDriverById,
  listDrivers,
  resolveDriverDisplayName,
  saveDriverLicense,
  transitionDriverStatus,
  updateDriverProfile,
  DriverValidationError
} from "./drivers";

test("driver display name fallback follows full name, short name, masked email, and unnamed order", () => {
  assert.equal(resolveDriverDisplayName("Riley", "Example", "Other", "riley@example.com"), "Riley Example");
  assert.equal(resolveDriverDisplayName(null, null, "Riley E", "riley@example.com"), "Riley E");
  assert.equal(resolveDriverDisplayName(null, null, null, "riley@example.com"), "r***");
  assert.equal(resolveDriverDisplayName(null, null, null, ""), "Unnamed driver");
});

test("driver list resolves legacy display labels without using the id as the title", async () => {
  const client = {
    query: async () => ({
      rows: [
        {
          id: "4f241bd2-bdf8-4f46-b040-7d8092aef316",
          email: "driver.name@example.com",
          status: "pending_review",
          first_name: null,
          last_name: null,
          short_name: "Driver #4f241bd2-bdf8-4f46-b040-7d8092aef316",
          licence_count: "0",
          documents_count: "0",
          total_count: "1"
        }
      ]
    })
  };

  const result = await listDrivers({ client: client as any });

  assert.equal(result.drivers[0].displayName, "d***");
  assert.notEqual(result.drivers[0].displayName, `Driver #${result.drivers[0].id}`);
});

test("driver directory can use names stored on the legacy auth user", async () => {
  let query = "";
  const client = {
    query: async (sql: string) => {
      query = sql;
      return { rows: [] };
    }
  };
  await listDrivers({ client: client as any });
  assert.match(query, /to_jsonb\(u\) ->> 'first_name'/);
  assert.match(query, /to_jsonb\(u\) ->> 'last_name'/);
});

test("driver detail loads a legacy account when its profile row is absent", async () => {
  const client = {
    query: async () => ({
      rows: [{
        id: "driver-legacy",
        email: "legacy@example.com",
        status: "pending_review",
        first_name: null,
        last_name: null,
        short_name: "Driver #legacy-technical-id",
        created_at: null,
        updated_at: null
      }]
    })
  };

  const driver = await getDriverById("driver-legacy", client as any);

  assert.ok(driver);
  assert.equal(driver.profileComplete, false);
  assert.equal(driver.displayName, "l***");
  assert.equal(driver.shortName, null);
  assert.equal(driver.firstName, null);
});

test("driver detail uses existing auth names when its profile names are missing", async () => {
  const client = {
    query: async () => ({
      rows: [{
        id: "driver-legacy",
        email: "legacy@example.com",
        status: "pending_review",
        first_name: "Riley",
        last_name: "Example",
        short_name: "Driver #driver-legacy",
        created_at: null,
        updated_at: null
      }]
    })
  };

  const driver = await getDriverById("driver-legacy", client as any);

  assert.equal(driver?.displayName, "Riley Example");
  assert.equal(driver?.firstName, "Riley");
  assert.equal(driver?.shortName, null);
});

test("driver licence save persists the Dorset Council authority id", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT id FROM licensing_authorities")) {
        return { rows: [{ id: "dorset_council" }] };
      }
      return { rows: [{ eligible: false }], rowCount: 1 };
    }
  };

  const savedId = await saveDriverLicense("driver-1", {
    licensingAuthorityId: "dorset_council",
    licenseReference: "DORSET-123",
    validFrom: "2026-01-01"
  }, undefined, client as any);

  const insert = calls.find(({ sql }) => sql.includes("INSERT INTO driver_licensing_authorities"));
  assert.ok(savedId);
  assert.equal(insert?.params[2], "dorset_council");
  assert.equal(insert?.params[3], "DORSET-123");
});

test("editing a legacy driver upserts missing profile fields", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("LEFT JOIN driver_profiles")) {
        return {
          rows: [{
            id: "driver-legacy",
            email: "legacy@example.com",
            status: "pending_review",
            first_name: "Riley",
            last_name: "Example",
            short_name: "Riley E",
            created_at: "2026-10-24",
            updated_at: "2026-10-24"
          }]
        };
      }
      if (sql.includes("SELECT u.id::text AS id")) return { rows: [{ id: "driver-legacy" }] };
      return { rows: [], rowCount: 1 };
    }
  };

  const driver = await updateDriverProfile("driver-legacy", { firstName: "Riley", lastName: "Example" }, client as any);

  assert.equal(driver?.profileComplete, true);
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO driver_profiles") && sql.includes("ON CONFLICT")));
});

test("archive transitions require a reason and record blocked attempts", async () => {
  const auditRows: unknown[][] = [];
  const auditSql: string[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT COALESCE(dp.lifecycle_status")) {
        return { rows: [{ status: "pending_review", first_name: null, last_name: null, short_name: null }] };
      }
      if (sql.includes("INSERT INTO driver_lifecycle_audit")) {
        auditRows.push(params);
        auditSql.push(sql);
      }
      return { rows: [], rowCount: 1 };
    }
  };

  await assert.rejects(
    transitionDriverStatus({ driverId: "driver-legacy", status: "archived" }, client as any),
    /A reason is required/
  );
  assert.equal(auditRows.length, 1);
  assert.match(auditSql[0], /FALSE/);
  assert.match(String(auditRows[0][8]), /reason is required/);
});

test("archive transitions save the mandatory reason and lifecycle audit event", async () => {
  const auditRows: unknown[][] = [];
  const auditSql: string[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT COALESCE(dp.lifecycle_status")) {
        return { rows: [{ status: "active", first_name: "Riley", last_name: "Example", short_name: "Riley E" }] };
      }
      if (sql.includes("INSERT INTO driver_lifecycle_audit")) {
        auditRows.push(params);
        auditSql.push(sql);
      }
      return { rows: [], rowCount: 1 };
    }
  };

  await transitionDriverStatus({
    driverId: "driver-legacy",
    status: "archived",
    reason: "Legacy duplicate record",
    actorId: "admin-1",
    actorEmail: "admin@example.com"
  }, client as any);

  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0][6], "archived");
  assert.equal(auditRows[0][7], "Legacy duplicate record");
  assert.match(auditSql[0], /TRUE/);
});

test("rejected and suspended transitions also require reasons", async () => {
  for (const status of ["rejected", "suspended"] as const) {
    let auditAttempted = false;
    const client = {
      query: async (sql: string) => {
        if (sql.includes("SELECT COALESCE(dp.lifecycle_status")) {
          return { rows: [{ status: "pending_review", first_name: null, last_name: null, short_name: null }] };
        }
        if (sql.includes("INSERT INTO driver_lifecycle_audit")) auditAttempted = true;
        return { rows: [], rowCount: 1 };
      }
    };

    await assert.rejects(
      transitionDriverStatus({ driverId: "driver-legacy", status }, client as any),
      /A reason is required/
    );
    assert.equal(auditAttempted, true);
  }
});

test("a driver cannot transition to active without a complete profile and current licence", async () => {
  let auditAttempted = false;
  const client = {
    query: async (sql: string) => {
      if (sql.includes("SELECT COALESCE(dp.lifecycle_status")) {
        return { rows: [{ status: "pending_review", account_status: "Active", first_name: "Riley", last_name: "Example", short_name: "Riley E" }] };
      }
      if (sql.includes("SELECT dl.id")) return { rows: [] };
      if (sql.includes("INSERT INTO driver_lifecycle_audit")) auditAttempted = true;
      return { rows: [], rowCount: 1 };
    }
  };

  await assert.rejects(
    transitionDriverStatus({ driverId: "driver-legacy", status: "active" }, client as any),
    /complete profile and a current active licence/
  );
  assert.equal(auditAttempted, true);
});

test("driver licence API requires an authority and maps reference, dates, and notes to storage", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT id FROM licensing_authorities")) return { rows: [{ id: "authority-1" }] };
      if (sql.includes("SELECT EXISTS (")) return { rows: [{ eligible: false }] };
      return { rows: [], rowCount: 1 };
    }
  };

  await assert.rejects(
    saveDriverLicense("driver-1", { validFrom: "2026-01-01" }, undefined, client as any),
    (error: unknown) => error instanceof DriverValidationError && /licensing authority/.test(error.message)
  );
  assert.equal(calls.length, 0);

  const id = await saveDriverLicense("driver-1", {
    licensingAuthorityId: "authority-1",
    licenseReference: "REF-123",
    validFrom: "2026-01-01",
    validUntil: "2027-01-01",
    notes: "Renewal due"
  }, undefined, client as any);
  const insert = calls.find(({ sql }) => sql.includes("INSERT INTO driver_licensing_authorities"));

  assert.ok(id);
  assert.ok(insert);
  assert.deepEqual(insert.params.slice(1, 7), [
    "driver-1", "authority-1", "REF-123", "2026-01-01", "2027-01-01", "Renewal due"
  ]);
});

test("driver licence API rejects invalid or reversed dates", async () => {
  const client = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    saveDriverLicense("driver-1", {
      licensingAuthorityId: "authority-1",
      validFrom: "not-a-date"
    }, undefined, client as any),
    /valid licence start date/
  );
  await assert.rejects(
    saveDriverLicense("driver-1", {
      licensingAuthorityId: "authority-1",
      validFrom: "2027-01-01",
      validUntil: "2026-01-01"
    }, undefined, client as any),
    /must be after its start date/
  );
});
