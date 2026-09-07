import assert from "node:assert/strict";
import test from "node:test";
import { createVehicle, listVehicleClasses, VEHICLE_DEFAULT_PER_PAGE } from "./vehicles";

test("vehicle management uses a fifteen-row default and exposes catalogue classes", async () => {
  const queries: string[] = [];
  const client: any = {
    async query(text: string, params?: unknown[]) {
      queries.push(text);
      if (text.includes("FROM vehicle_classes")) {
        return { rows: [{ key: "executive", label: "Executive" }] };
      }
      if (text.includes("INSERT INTO vehicles")) return { rows: [] };
      if (text.includes("FROM vehicles")) {
        return { rows: [{ id: "v1", registration: "AB1", make: "Make", model: "Model",
          year: null, colour: null, vehicle_class_key: "executive", vehicle_class_label: "Executive",
          status: "available", notes: null, driver_id: null, driver_email: null, documents_count: 0 }] };
      }
      return { rows: [] };
    }
  };
  assert.equal(VEHICLE_DEFAULT_PER_PAGE, 15);
  assert.deepEqual(await listVehicleClasses(client), [{ key: "executive", label: "Executive" }]);
  const vehicle = await createVehicle({
    registration: " ab1 ", make: "Make", model: "Model", vehicleClassKey: "executive"
  }, client);
  assert.equal(vehicle.registration, "AB1");
  assert.ok(queries.some((query) => query.includes("INSERT INTO vehicles")));
});

test("vehicle creation rejects incomplete records", async () => {
  await assert.rejects(
    createVehicle({ registration: "", make: "Make", model: "Model", vehicleClassKey: "executive" }, {
      query: async () => ({ rows: [] })
    } as any),
    /required/
  );
});
