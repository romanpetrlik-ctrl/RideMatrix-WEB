import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MIGRATIONS } from "../database/migrations";
import calculateBrowserDistanceSlabFare from "../../public/js/distance-slab-calculator";
import type { AirportFeeRecord } from "./airport-fees";
import {
  EMPTY_FARE_SETTINGS,
  calculateDistanceSlabFare,
  findLocationDiscountConflict,
  matchLocationDiscount,
  matchesMinimumFareRule,
  validateLocationDiscountForm,
  validateRadiusLocationDiscountForm,
  validateFixedFareRuleForm,
  validateMinimumFareRuleForm,
  resolveAdditionalDistanceSlabSets,
  validateAdditionalDistanceSlabSetForm,
  validateDistanceSlabsForm,
  withAdditionalDistanceSlabSets,
  validateFareSettingsForm,
  type AdditionalDistanceSlabSet,
  type BankHolidaySurchargePeriod,
  type DistanceSlab,
  type FareSettingsConfiguration,
  type LocationDiscountRule,
  type ManagedSlabTarget,
  type RadiusLocationDiscountRule
} from "./fare-settings";

const dailyAndBankDisabled = {
  dailyEnabled: "no",
  bankHolidayEnabled: "no"
};

function period(
  label: string,
  startDateTime: string,
  endDateTime: string,
  percentage: string
): BankHolidaySurchargePeriod {
  return { label, startDateTime, endDateTime, percentage };
}

function managedAirport(overrides: Partial<AirportFeeRecord> = {}): AirportFeeRecord {
  return {
    id: "rm-boh-internal-id",
    displayName: "Bournemouth Airport (BOH)",
    dropoffPlaceId: "google-dropoff",
    dropoffLocationLabel: "configured drop-off",
    dropoffLatitude: 0,
    dropoffLongitude: 0,
    dropoffFee: "0.00",
    pickupPlaceId: "google-pickup",
    pickupLocationLabel: "configured pick-up",
    pickupLatitude: 20,
    pickupLongitude: 20,
    pickupFee: "0.00",
    pickupTimeReference: "ALT",
    pickupDeferredEnabled: false,
    pickupDeferredMinutes: 0,
    pickupFeeCoveredMinutes: 10,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides
  };
}

test("fare settings start disabled without assumed percentages or times", () => {
  assert.deepEqual(EMPTY_FARE_SETTINGS.deadMileage, { enabled: false, freeRadiusMiles: "10", ratePerMile: "" });
  assert.deepEqual(EMPTY_FARE_SETTINGS.minimumFareRules, []);
  assert.deepEqual(EMPTY_FARE_SETTINGS.fixedFares, []);
  assert.deepEqual(EMPTY_FARE_SETTINGS.dailySurcharge, {
    enabled: false,
    percentage: "",
    startTime: "",
    endTime: ""
  });
  assert.deepEqual(EMPTY_FARE_SETTINGS.bankHolidaySurcharge, { enabled: false, periods: [] });
  assert.deepEqual(EMPTY_FARE_SETTINGS.locationDiscounts, [], "no location-based discounts are seeded");
});

test("editing another fare category preserves the saved dead-mileage radius", () => {
  const current = {
    ...EMPTY_FARE_SETTINGS,
    deadMileage: { enabled: false, freeRadiusMiles: "5.25", ratePerMile: "" }
  };
  const result = validateFareSettingsForm({
    dailyEnabled: "no",
    bankHolidayEnabled: "no"
  }, current);
  assert.deepEqual(result.configuration.deadMileage, { enabled: false, freeRadiusMiles: "5.25", ratePerMile: "" });
});

test("daily surcharge requires valid operator values when enabled and accepts midnight-crossing windows", () => {
  const valid = validateFareSettingsForm({
    dailyEnabled: "yes",
    dailyPercentage: "12.5",
    dailyStartTime: "23:00",
    dailyEndTime: "06:00",
    bankHolidayEnabled: "no"
  });
  assert.deepEqual(valid.errors, {});
  assert.deepEqual(valid.configuration.dailySurcharge, {
    enabled: true,
    percentage: "12.5",
    startTime: "23:00",
    endTime: "06:00"
  });

  const missing = validateFareSettingsForm({ dailyEnabled: "yes", bankHolidayEnabled: "no" });
  assert.match(missing.errors.dailyPercentage, /percentage/);
  assert.match(missing.errors.dailyStartTime, /start time/);
  assert.match(missing.errors.dailyEndTime, /end time/);
});

test("daily percentages reject negative, malformed, and non-finite values", () => {
  for (const percentage of ["-1", "1e2", "Infinity", "NaN", "1,5", ""]) {
    const result = validateFareSettingsForm({
      dailyEnabled: "yes",
      dailyPercentage: percentage,
      dailyStartTime: "22:00",
      dailyEndTime: "23:00",
      bankHolidayEnabled: "no"
    });
    assert.match(result.errors.dailyPercentage, /non-negative percentage/, percentage);
  }
});

test("disabling a daily surcharge retains its previous operator values", () => {
  const saved = validateFareSettingsForm({
    dailyEnabled: "yes",
    dailyPercentage: "7.25",
    dailyStartTime: "21:30",
    dailyEndTime: "05:30",
    bankHolidayEnabled: "no"
  }).configuration;
  const disabled = validateFareSettingsForm(dailyAndBankDisabled, saved).configuration;

  assert.deepEqual(disabled.dailySurcharge, {
    enabled: false,
    percentage: "7.25",
    startTime: "21:30",
    endTime: "05:30"
  });
});

test("editing one surcharge category retains the other category's saved settings", () => {
  const saved = validateFareSettingsForm({
    dailyEnabled: "yes",
    dailyPercentage: "8",
    dailyStartTime: "22:00",
    dailyEndTime: "05:00",
    bankHolidayEnabled: "yes",
    periods: [period("Christmas", "2026-12-24T18:00", "2026-12-27T06:00", "30")]
  }).configuration;
  const dailyEdit = validateFareSettingsForm({
    dailyEnabled: "yes",
    dailyPercentage: "9",
    dailyStartTime: "21:00",
    dailyEndTime: "04:00"
  }, saved).configuration;
  const bankHolidayEdit = validateFareSettingsForm({
    bankHolidayEnabled: "no",
    periods: [period("Christmas", "2026-12-24T18:00", "2026-12-27T06:00", "32")]
  }, dailyEdit).configuration;

  assert.deepEqual(dailyEdit.bankHolidaySurcharge, saved.bankHolidaySurcharge);
  assert.deepEqual(bankHolidayEdit.dailySurcharge, dailyEdit.dailySurcharge);
  assert.equal(bankHolidayEdit.bankHolidaySurcharge.enabled, false);
  assert.equal(bankHolidayEdit.bankHolidaySurcharge.periods[0].percentage, "32");
});

test("editing existing fare settings retains minimum and fixed fare configuration", () => {
  const current = {
    ...EMPTY_FARE_SETTINGS,
    deadMileage: { enabled: false, freeRadiusMiles: "5.25", ratePerMile: "" },
    minimumFareRules: [{
      id: "minimum-rule",
      name: "Minimum",
      poiId: "managed-id",
      minimumBaseFare: "25.00"
    }],
    fixedFares: [{
      id: "fixed-rule",
      name: "Directional",
      origin: { type: "poi" as const, poiId: "managed-id" },
      destination: { type: "postcode" as const, postcode: "BH1 1AA", scope: "full" as const },
      baseFare: "40.00"
    }]
  };
  const edited = validateFareSettingsForm({
    dailyEnabled: "no",
    bankHolidayEnabled: "no"
  }, current);
  assert.deepEqual(edited.configuration.minimumFareRules, current.minimumFareRules);
  assert.deepEqual(edited.configuration.fixedFares, current.fixedFares);
  assert.deepEqual(edited.configuration.deadMileage, current.deadMileage);
});

test("bank holiday settings represent the supplied multi-day Christmas and New Year periods exactly", () => {
  const result = validateFareSettingsForm({
    ...dailyAndBankDisabled,
    bankHolidayEnabled: "yes",
    periods: [
      {
        ...period("Christmas/Boxing Day period", "2026-12-24T18:00", "2026-12-27T06:00", "35"),
        remove: "no"
      },
      period("New Year period", "2026-12-31T18:00", "2027-01-02T06:00", "40")
    ]
  });

  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.configuration.bankHolidaySurcharge, {
    enabled: true,
    periods: [
      period("Christmas/Boxing Day period", "2026-12-24T18:00", "2026-12-27T06:00", "35"),
      period("New Year period", "2026-12-31T18:00", "2027-01-02T06:00", "40")
    ]
  });
  assert.equal(result.configuration.timezone, "Europe/London");
  assert.equal(result.configuration.matchingBasis, "scheduled-service-time");
  assert.equal(result.configuration.interval, "start-inclusive-end-exclusive");
  assert.equal(result.configuration.precedence, "bank-holiday-over-daily");
});

test("bank holiday periods can be edited and removed while disabled", () => {
  const configured = validateFareSettingsForm({
    ...dailyAndBankDisabled,
    bankHolidayEnabled: "yes",
    periods: [
      period("A", "2026-12-24T18:00", "2026-12-25T06:00", "25"),
      period("B", "2026-12-31T18:00", "2027-01-01T06:00", "30")
    ]
  }).configuration;
  const edited = validateFareSettingsForm({
    ...dailyAndBankDisabled,
    bankHolidayEnabled: "no",
    periods: [period("Updated B", "2026-12-31T19:00", "2027-01-01T06:00", "31")]
  }, configured);

  assert.deepEqual(edited.errors, {});
  assert.equal(edited.configuration.bankHolidaySurcharge.enabled, false);
  assert.deepEqual(edited.configuration.bankHolidaySurcharge.periods, [
    period("Updated B", "2026-12-31T19:00", "2027-01-01T06:00", "31")
  ]);

  const removed = validateFareSettingsForm({
    bankHolidayEnabled: "no",
    periodsSubmitted: "yes"
  }, edited.configuration);
  assert.deepEqual(removed.configuration.bankHolidaySurcharge.periods, []);
});

test("invalid dates, non-increasing periods, invalid percentages, and overlaps are rejected", () => {
  const invalidDate = validateFareSettingsForm({
    ...dailyAndBankDisabled,
    bankHolidayEnabled: "yes",
    periods: [period("Invalid date", "2026-02-30T18:00", "2026-03-01T06:00", "10")]
  });
  assert.match(invalidDate.errors["periods.0.startDateTime"], /valid local start/);

  const backwards = validateFareSettingsForm({
    ...dailyAndBankDisabled,
    bankHolidayEnabled: "yes",
    periods: [period("Backwards", "2026-12-25T06:00", "2026-12-24T18:00", "10")]
  });
  assert.match(backwards.errors["periods.0.endDateTime"], /after the start/);

  const overlap = validateFareSettingsForm({
    ...dailyAndBankDisabled,
    bankHolidayEnabled: "yes",
    periods: [
      period("First", "2026-12-24T18:00", "2026-12-27T06:00", "10"),
      period("Overlap", "2026-12-26T18:00", "2026-12-28T06:00", "20")
    ]
  });
  assert.match(overlap.errors.bankHolidayPeriods, /cannot overlap/);

  const invalidPercentage = validateFareSettingsForm({
    ...dailyAndBankDisabled,
    bankHolidayEnabled: "yes",
    periods: [period("Bad rate", "2026-12-24T18:00", "2026-12-25T06:00", "-2")]
  });
  assert.match(invalidPercentage.errors["periods.0.percentage"], /non-negative percentage/);

  const equalDailyTimes = validateFareSettingsForm({
    dailyEnabled: "yes",
    dailyPercentage: "10",
    dailyStartTime: "06:00",
    dailyEndTime: "06:00",
    bankHolidayEnabled: "no"
  });
  assert.match(equalDailyTimes.errors.dailyEndTime, /must differ/);
});

test("adjacent bank holiday periods are valid with end-exclusive boundaries", () => {
  const result = validateFareSettingsForm({
    ...dailyAndBankDisabled,
    bankHolidayEnabled: "yes",
    periods: [
      period("First", "2026-12-24T18:00", "2026-12-25T06:00", "10"),
      period("Next", "2026-12-25T06:00", "2026-12-26T06:00", "20")
    ]
  });
  assert.deepEqual(result.errors, {});
});

test("Fare Settings persistence uses versioned append-only configuration, separate from booking prices", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0026_fare_settings");
  assert.ok(migration);
  assert.match(migration.sql, /fare_settings_current/);
  assert.match(migration.sql, /fare_settings_history/);
  assert.match(migration.sql, /fare_settings_history_append_only/);
  assert.doesNotMatch(migration.sql, /customer_bookings|fare_totals|booking_total/i);
});

const distanceSlabs: DistanceSlab[] = [
  { startMiles: "0", endMiles: "10", ratePerMile: "3.00" },
  { startMiles: "10", endMiles: "", ratePerMile: "2.70" }
];

test("distance slabs require a zero start, contiguous ranges, and exactly one open-ended final slab", () => {
  assert.deepEqual(validateDistanceSlabsForm({ distanceSlabs }).errors, {});
  assert.deepEqual(validateDistanceSlabsForm({
    distanceSlabs: [{ startMiles: "0.0", endMiles: "", ratePerMile: "1.25" }]
  }).errors, {});

  const invalidSchedules: Array<{ slabs: DistanceSlab[]; errorKey: string }> = [
    { slabs: [], errorKey: "distanceSlabs.0.startMiles" },
    { slabs: [{ startMiles: "1", endMiles: "", ratePerMile: "2" }], errorKey: "distanceSlabs.0.startMiles" },
    {
      slabs: [
        { startMiles: "0", endMiles: "10", ratePerMile: "2" },
        { startMiles: "11", endMiles: "", ratePerMile: "1" }
      ],
      errorKey: "distanceSlabs.1.startMiles"
    },
    {
      slabs: [
        { startMiles: "0", endMiles: "10", ratePerMile: "2" },
        { startMiles: "9", endMiles: "", ratePerMile: "1" }
      ],
      errorKey: "distanceSlabs.1.startMiles"
    },
    {
      slabs: [
        { startMiles: "0", endMiles: "", ratePerMile: "2" },
        { startMiles: "10", endMiles: "", ratePerMile: "1" }
      ],
      errorKey: "distanceSlabs.0.endMiles"
    },
    {
      slabs: [{ startMiles: "0", endMiles: "10", ratePerMile: "2" }],
      errorKey: "distanceSlabs.0.endMiles"
    },
    {
      slabs: [
        { startMiles: "0", endMiles: "10", ratePerMile: "2" },
        { startMiles: "10", endMiles: "10", ratePerMile: "1" }
      ],
      errorKey: "distanceSlabs.1.endMiles"
    }
  ];
  for (const { slabs, errorKey } of invalidSchedules) {
    assert.ok(validateDistanceSlabsForm({ distanceSlabs: slabs }).errors[errorKey], JSON.stringify(slabs));
  }
});

test("distance slabs reject negative, malformed, and non-finite distances and rates", () => {
  for (const value of ["-1", "Infinity", "NaN", "1e2", "1,5", ""]) {
    const invalidStart = validateDistanceSlabsForm({
      distanceSlabs: [{ startMiles: value, endMiles: "", ratePerMile: "1" }]
    });
    assert.ok(invalidStart.errors["distanceSlabs.0.startMiles"], value);
    const invalidRate = validateDistanceSlabsForm({
      distanceSlabs: [{ startMiles: "0", endMiles: "", ratePerMile: value }]
    });
    assert.ok(invalidRate.errors["distanceSlabs.0.ratePerMile"], value);
  }
  assert.ok(validateDistanceSlabsForm({
    distanceSlabs: [{ startMiles: "0", endMiles: "NaN", ratePerMile: "1" }]
  }).errors["distanceSlabs.0.endMiles"]);
});

test("distance slab calculations are progressive and use start-inclusive end-exclusive boundaries", () => {
  assert.equal(calculateDistanceSlabFare(distanceSlabs, "12"), "35.40");
  assert.equal(calculateDistanceSlabFare(distanceSlabs, "12.4"), "36.48");
  assert.equal(calculateDistanceSlabFare(distanceSlabs, "10"), "30.00");
  assert.equal(calculateDistanceSlabFare(distanceSlabs, "10.1"), "30.27");
  assert.equal(calculateDistanceSlabFare(distanceSlabs, "20"), "57.00");
  assert.equal(calculateDistanceSlabFare(
    [{ startMiles: "0", endMiles: "", ratePerMile: "2.75" }],
    "123.456"
  ), "339.50");
});

test("distance slab calculation handles fractional miles and rounds only the final total half-up", () => {
  assert.equal(calculateDistanceSlabFare(
    [{ startMiles: "0", endMiles: "", ratePerMile: "0.1" }],
    "0.15"
  ), "0.02");
  assert.equal(calculateDistanceSlabFare(
    [
      { startMiles: "0", endMiles: "0.1", ratePerMile: "0.05" },
      { startMiles: "0.1", endMiles: "", ratePerMile: "0.05" }
    ],
    "0.3"
  ), "0.02");
  assert.throws(() => calculateDistanceSlabFare(distanceSlabs, "-0.5"), /valid distance/);
});

test("distance preview recalculates from unsaved form values on slab and test-distance input", () => {
  const unsavedSlabs = structuredClone(distanceSlabs);
  assert.equal(calculateBrowserDistanceSlabFare(unsavedSlabs, "12"), "35.40");
  unsavedSlabs[1].ratePerMile = "2.80";
  assert.equal(calculateBrowserDistanceSlabFare(unsavedSlabs, "12"), "35.60");
  assert.equal(calculateBrowserDistanceSlabFare(unsavedSlabs, "12.4"), "36.72");

  const script = readFileSync("public/js/fare-settings.js", "utf8");
  assert.match(script, /slabList\?\.addEventListener\("input", \(event\) => \{[\s\S]*?calculatePreview\(\);\s*\}\)/);
  assert.match(script, /distanceForm\?\.addEventListener\("submit", \(event\) => \{/);
  assert.match(script, /testDistance\?\.addEventListener\("input", calculatePreview\)/);
  assert.match(script, /window\.calculateDistanceSlabFare\(slabs, distance\)/);
});

test("distance slab migration adds an empty current setting without changing audit snapshots or booking prices", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0027_fare_settings_distance_slabs");
  assert.ok(migration);
  assert.match(migration.sql, /jsonb_set\(configuration, '\{distanceSlabs\}', '\[\]'::jsonb, true\)/);
  assert.match(migration.sql, /WHERE NOT \(configuration \? 'distanceSlabs'\)/);
  assert.doesNotMatch(migration.sql, /fare_settings_history|customer_bookings|fare_totals|booking_total/i);
});

test("minimum and fixed fare migration initializes only current configuration and is pricing-disconnected", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0028_fare_minimum_and_fixed_fares");
  assert.ok(migration);
  assert.match(migration.sql, /minimumFareRules/);
  assert.match(migration.sql, /fixedFares/);
  assert.doesNotMatch(migration.sql, /fare_settings_history|customer_bookings|fare_totals|booking_total/i);
});

test("obsolete minimum-fare radius migration preserves rule data and history", () => {
  const migration = MIGRATIONS.find((item) => item.id === "0032_minimum_fare_rules_without_radius");
  assert.ok(migration);
  assert.match(migration.sql, /jsonb_array_elements\(configuration -> 'minimumFareRules'\)/);
  assert.match(migration.sql, /rule_data - 'radiusMiles'/);
  assert.match(migration.sql, /fare_settings_current/);
  assert.doesNotMatch(migration.sql, /fare_settings_history|deadMileage|freeRadiusMiles|customer_bookings/i);
});

test("minimum fare rules retain the managed POI internal ID without a radius or coordinate requirement", () => {
  const airport = managedAirport();
  const valid = validateMinimumFareRuleForm({
    name: "BOH short journey",
    poiId: airport.id,
    minimumBaseFare: "25"
  }, [airport]);
  assert.deepEqual(valid.errors, {});
  assert.deepEqual(valid.values, {
    name: "BOH short journey",
    poiId: "rm-boh-internal-id",
    minimumBaseFare: "25.00"
  });

  const missingCoordinates = validateMinimumFareRuleForm({
    name: "No operational coordinates",
    poiId: airport.id,
    minimumBaseFare: "25"
  }, [managedAirport({ pickupLatitude: Number.NaN, dropoffLongitude: Number.NaN })]);
  assert.deepEqual(missingCoordinates.errors, {});
  assert.deepEqual(missingCoordinates.values, {
    name: "No operational coordinates",
    poiId: "rm-boh-internal-id",
    minimumBaseFare: "25.00"
  });
  assert.match(validateMinimumFareRuleForm({
    name: "Unmanaged",
    poiId: "google-airport-label",
    minimumBaseFare: "25"
  }, [airport]).errors.poiId, /active managed/);
});

test("minimum fare rules match their selected POI at either endpoint regardless of the other endpoint distance", () => {
  const airport = managedAirport();
  const rule = {
    id: "minimum-rule",
    name: "BOH minimum",
    poiId: airport.id,
    minimumBaseFare: "25.00"
  };
  const distantEndpoint = { poiId: "another-managed-id", latitude: -80, longitude: 170 };

  assert.equal(matchesMinimumFareRule(rule, distantEndpoint, { poiId: airport.id }, airport), true);
  assert.equal(matchesMinimumFareRule(rule, { poiId: airport.id }, distantEndpoint, airport), true);
  assert.equal(matchesMinimumFareRule(rule, { poiId: "google-airport-label" }, distantEndpoint, airport), false);
  assert.equal(matchesMinimumFareRule(rule, distantEndpoint, { poiId: "different-id" }, airport), false);
  assert.equal(matchesMinimumFareRule({ ...rule, poiId: "different-id" }, { poiId: airport.id }, {}, airport), false);
});

test("minimum and fixed base fares reject negative, malformed, and over-precision GBP values", () => {
  for (const amount of ["-1", "1.001", "1e2", "Infinity", "", "1000000"]) {
    assert.ok(validateMinimumFareRuleForm({
      name: "Test", poiId: "rm-boh-internal-id", minimumBaseFare: amount
    }, [managedAirport()]).errors.minimumBaseFare, amount);
    assert.ok(validateFixedFareRuleForm({
      name: "Test",
      originType: "poi",
      originPoiId: "rm-boh-internal-id",
      destinationType: "postcode",
      destinationPostcode: "BH1 1AA",
      destinationPostcodeScope: "full",
      baseFare: amount
    }, [managedAirport()]).errors.baseFare, amount);
  }
});

test("fixed fares preserve explicit endpoint identity, postcode scope, and origin-to-destination direction", () => {
  const poi = managedAirport();
  const result = validateFixedFareRuleForm({
    name: "Airport to Bournemouth",
    originType: "poi",
    originPoiId: poi.id,
    originPostcode: "",
    originPostcodeScope: "",
    destinationType: "postcode",
    destinationPoiId: "",
    destinationPostcode: "bh1 1aa",
    destinationPostcodeScope: "full",
    baseFare: "42.5"
  }, [poi]);

  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.rule, {
    name: "Airport to Bournemouth",
    origin: { type: "poi", poiId: "rm-boh-internal-id" },
    destination: { type: "postcode", postcode: "BH1 1AA", scope: "full" },
    baseFare: "42.50"
  });

  const outward = validateFixedFareRuleForm({
    name: "BH outward",
    originType: "postcode",
    originPostcode: "bh1",
    originPostcodeScope: "outward",
    destinationType: "poi",
    destinationPoiId: poi.id,
    baseFare: "25"
  }, [poi]);
  assert.equal(outward.rule?.origin.type, "postcode");
  assert.deepEqual(outward.rule?.origin, { type: "postcode", postcode: "BH1", scope: "outward" });
  assert.deepEqual(outward.rule?.destination, { type: "poi", poiId: poi.id });
  assert.equal(outward.rule?.baseFare, "25.00");

  const identical = validateFixedFareRuleForm({
    name: "Duplicate direction",
    originType: "poi",
    originPoiId: poi.id,
    destinationType: "poi",
    destinationPoiId: poi.id,
    baseFare: "25"
  }, [poi]);
  assert.match(identical.errors.destinationType, /different locations/);
});

test("fixed fares reject UK postcode letters that are invalid at their positions", () => {
  const poi = managedAirport();
  for (const postcode of ["Q1 1AA", "BH1 1CI"]) {
    const result = validateFixedFareRuleForm({
      name: "Invalid full postcode",
      originType: "postcode",
      originPostcode: postcode,
      originPostcodeScope: "full",
      destinationType: "poi",
      destinationPoiId: poi.id,
      baseFare: "25"
    }, [poi]);
    assert.ok(result.errors.originPostcode, postcode);
  }

  const outward = validateFixedFareRuleForm({
    name: "Invalid outward postcode",
    originType: "postcode",
    originPostcode: "Q1",
    originPostcodeScope: "outward",
    destinationType: "poi",
    destinationPoiId: poi.id,
    baseFare: "25"
  }, [poi]);
  assert.ok(outward.errors.originPostcode, "Q1");
});

test("additional slab sets link exactly one managed airport or POI by internal ID and apply base slab rules", () => {
  const targets: ManagedSlabTarget[] = [
    { type: "airport", id: "rm-boh-internal-id", displayName: "Bournemouth Airport (BOH)" },
    { type: "poi", id: "poi-uuid-1", displayName: "Bournemouth Pier" }
  ];
  const body = (overrides: Record<string, unknown> = {}) => ({
    name: "Bournemouth Airport rates",
    targetKey: "airport:rm-boh-internal-id",
    distanceSlabs: [
      { startMiles: "0", endMiles: "5", ratePerMile: "3" },
      { startMiles: "5", endMiles: "", ratePerMile: "2" }
    ],
    ...overrides
  });
  const ok = validateAdditionalDistanceSlabSetForm(body(), targets, []);
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.target, { type: "airport", id: "rm-boh-internal-id" });
  assert.deepEqual(validateAdditionalDistanceSlabSetForm(body({ targetKey: "poi:poi-uuid-1" }), targets, []).target, { type: "poi", id: "poi-uuid-1" });

  for (const targetKey of ["", "Bournemouth Airport (BOH)", "BH23 6SE", "50.78,-1.84", "airport:missing-id", "poi:rm-boh-internal-id", ["airport:rm-boh-internal-id", "poi:poi-uuid-1"]]) {
    const result = validateAdditionalDistanceSlabSetForm(body({ targetKey }), targets, []);
    assert.ok(result.errors.targetKey, `rejects ${JSON.stringify(targetKey)}`);
    assert.equal(result.target, null);
  }
  assert.match(validateAdditionalDistanceSlabSetForm(body({ targetKey: "airport:missing-id" }), targets, []).errors.targetKey, /missing or no longer available.*no other location is substituted/);
  assert.ok(validateAdditionalDistanceSlabSetForm(body({ name: " " }), targets, []).errors.name);

  const invalidSlabs: Array<[string, DistanceSlab[], string]> = [
    ["gapped", [{ startMiles: "0", endMiles: "5", ratePerMile: "3" }, { startMiles: "6", endMiles: "", ratePerMile: "2" }], "distanceSlabs.1.startMiles"],
    ["overlapping", [{ startMiles: "0", endMiles: "5", ratePerMile: "3" }, { startMiles: "4", endMiles: "", ratePerMile: "2" }], "distanceSlabs.1.startMiles"],
    ["not from zero", [{ startMiles: "1", endMiles: "", ratePerMile: "3" }], "distanceSlabs.0.startMiles"],
    ["missing open-ended final", [{ startMiles: "0", endMiles: "5", ratePerMile: "3" }, { startMiles: "5", endMiles: "9", ratePerMile: "2" }], "distanceSlabs.1.endMiles"],
    ["negative rate", [{ startMiles: "0", endMiles: "", ratePerMile: "-1" }], "distanceSlabs.0.ratePerMile"]
  ];
  for (const [label, distanceSlabs, key] of invalidSlabs) {
    const result = validateAdditionalDistanceSlabSetForm(body({ distanceSlabs }), targets, []);
    assert.ok(result.errors[key], label);
    assert.equal(result.target, null, label);
  }
});

test("additional slab sets reject a target already linked to another set", () => {
  const targets: ManagedSlabTarget[] = [{ type: "poi", id: "poi-uuid-1", displayName: "Bournemouth Pier" }];
  const existing: AdditionalDistanceSlabSet[] = [{
    id: "set-1",
    name: "Pier rates",
    target: { type: "poi", id: "poi-uuid-1" },
    distanceSlabs: [{ startMiles: "0", endMiles: "", ratePerMile: "2" }]
  }];
  const body = { name: "Another", targetKey: "poi:poi-uuid-1", distanceSlabs: existing[0].distanceSlabs };
  assert.match(validateAdditionalDistanceSlabSetForm(body, targets, existing).errors.targetKey, /Bournemouth Pier is already linked to the additional distance slab set "Pier rates"/);
  assert.deepEqual(validateAdditionalDistanceSlabSetForm(body, targets, existing, "set-1").errors, {});
});

test("legacy airport-specific slab sets are preserved as one additional set per linked airport", () => {
  const slabs: DistanceSlab[] = [{ startMiles: "0", endMiles: "5", ratePerMile: "3" }, { startMiles: "5", endMiles: "", ratePerMile: "2" }];
  const legacy: FareSettingsConfiguration = {
    ...EMPTY_FARE_SETTINGS,
    distanceSlabs: [{ startMiles: "0", endMiles: "", ratePerMile: "1" }],
    additionalDistanceSlabSets: undefined,
    airportDistanceSlabSets: [
      { id: "legacy-1", name: "South coast", airportIds: ["rm-boh", "rm-sou"], distanceSlabs: slabs },
      { id: "legacy-2", name: "Unlinked", airportIds: [], distanceSlabs: slabs }
    ]
  };
  const resolved = resolveAdditionalDistanceSlabSets(legacy);
  assert.deepEqual(resolved.map((set) => [set.id, set.name, set.target]), [
    ["legacy-1", "South coast", { type: "airport", id: "rm-boh" }],
    ["legacy-1--rm-sou", "South coast", { type: "airport", id: "rm-sou" }],
    ["legacy-2", "Unlinked", { type: "airport", id: "" }]
  ]);
  for (const set of resolved) assert.deepEqual(set.distanceSlabs, slabs);
  resolved[0].distanceSlabs[0].ratePerMile = "99";
  assert.equal(slabs[0].ratePerMile, "3", "migrated sets hold independent slab copies");

  const saved = withAdditionalDistanceSlabSets(legacy, resolved);
  assert.equal("airportDistanceSlabSets" in saved, false);
  assert.equal(saved.additionalDistanceSlabSets?.length, 3);
  assert.deepEqual(saved.distanceSlabs, legacy.distanceSlabs, "base slabs are untouched");
  assert.equal(legacy.airportDistanceSlabSets?.length, 2, "the source configuration is not mutated");
  assert.deepEqual(resolveAdditionalDistanceSlabSets({ ...legacy, additionalDistanceSlabSets: [] }), [], "saved current sets take precedence over legacy data");
});

const discountTargets: ManagedSlabTarget[] = [
  { type: "airport", id: "rm-boh", displayName: "Bournemouth Airport" },
  { type: "poi", id: "poi-pier", displayName: "Bournemouth Pier" }
];

function discountForm(overrides: Record<string, string> = {}) {
  return {
    name: "BH22 airport promotion",
    locationKey: "airport:rm-boh",
    postcodePrecision: "full",
    postcodes: "BH1 4RS",
    discountPercentage: "10",
    startDate: "",
    endDate: "",
    enabled: "yes",
    ...overrides
  };
}

function discountRule(id: string, overrides: Partial<LocationDiscountRule> = {}): LocationDiscountRule {
  return {
    id,
    name: `Rule ${id}`,
    location: { type: "airport", id: "rm-boh" },
    postcodePrecision: "full",
    postcodes: ["BH1 4RS"],
    discountPercentage: "10",
    startDate: "",
    endDate: "",
    enabled: true,
    discountBasis: "standard-distance-slabs-base-fare",
    ...overrides
  };
}

test("location discount validation normalizes postcodes and stores the exact managed ID and precision", () => {
  const result = validateLocationDiscountForm(
    discountForm({ postcodes: " bh14rs \nbh2  5aa, SO15 1AA", discountPercentage: "12.50", startDate: "2027-01-01", endDate: "2027-01-31" }),
    discountTargets,
    []
  );
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.rule, {
    name: "BH22 airport promotion",
    location: { type: "airport", id: "rm-boh" },
    postcodePrecision: "full",
    postcodes: ["BH1 4RS", "BH2 5AA", "SO15 1AA"],
    discountPercentage: "12.5",
    startDate: "2027-01-01",
    endDate: "2027-01-31",
    enabled: true,
    discountBasis: "standard-distance-slabs-base-fare"
  });

  const outward = validateLocationDiscountForm(discountForm({ postcodePrecision: "outward", postcodes: "bh22\nSO15" }), discountTargets, []);
  assert.deepEqual(outward.rule?.postcodes, ["BH22", "SO15"]);
});

test("location discount validation rejects invalid postcodes, precision mismatches, duplicates, and missing managed IDs", () => {
  const invalid = validateLocationDiscountForm(discountForm({ postcodes: "BH1 4R\nQQ1 1AA" }), discountTargets, []);
  assert.match(invalid.errors.postcodes, /BH1 4R is not a valid UK full postcode/);
  assert.match(invalid.errors.postcodes, /QQ1 1AA is not a valid UK full postcode/);
  assert.equal(invalid.rule, null);
  assert.equal(invalid.values.postcodes, "BH1 4R\nQQ1 1AA", "submitted values are preserved");

  assert.match(validateLocationDiscountForm(discountForm({ postcodes: "BH22" }), discountTargets, []).errors.postcodes,
    /BH22 is an outward code, not a full postcode/);
  assert.match(validateLocationDiscountForm(discountForm({ postcodePrecision: "outward", postcodes: "BH22 8AB" }), discountTargets, []).errors.postcodes,
    /BH22 8AB is a full postcode, not an outward code/);
  assert.match(validateLocationDiscountForm(discountForm({ postcodes: "BH1 4RS\nbh14rs" }), discountTargets, []).errors.postcodes,
    /Remove duplicate postcode entries: BH1 4RS/);
  assert.match(validateLocationDiscountForm(discountForm({ postcodes: " \n, " }), discountTargets, []).errors.postcodes,
    /at least one UK postcode/);
  assert.match(validateLocationDiscountForm(discountForm({ postcodePrecision: "partial" }), discountTargets, []).errors.postcodePrecision,
    /full postcodes or outward codes/);

  for (const locationKey of ["", "Bournemouth Airport", "airport:unknown", "poi:rm-boh", "airport:Bournemouth Airport"]) {
    const result = validateLocationDiscountForm(discountForm({ locationKey }), discountTargets, []);
    assert.ok(result.errors.locationKey, `location ${JSON.stringify(locationKey)} is rejected`);
    assert.equal(result.rule, null);
  }
  assert.match(validateLocationDiscountForm(discountForm({ name: " " }), discountTargets, []).errors.name, /rule name/);
  assert.match(validateLocationDiscountForm(discountForm({ enabled: "" }), discountTargets, []).errors.enabled, /enabled or disabled/);
});

test("location discount percentages and optional validity dates are validated", () => {
  for (const discountPercentage of ["", "0", "0.00", "-1", "101", "100.01", "abc", "1.234", "1e2", "Infinity", " 5 %"]) {
    assert.ok(validateLocationDiscountForm(discountForm({ discountPercentage }), discountTargets, []).errors.discountPercentage,
      `${discountPercentage} is rejected`);
  }
  for (const discountPercentage of ["0.01", "15", "100"]) {
    assert.deepEqual(validateLocationDiscountForm(discountForm({ discountPercentage }), discountTargets, []).errors, {});
  }
  for (const date of ["2027-02-30", "2027-13-01", "27-01-01", "01/02/2027", "2027-1-1"]) {
    assert.ok(validateLocationDiscountForm(discountForm({ startDate: date }), discountTargets, []).errors.startDate, date);
    assert.ok(validateLocationDiscountForm(discountForm({ endDate: date }), discountTargets, []).errors.endDate, date);
  }
  assert.match(validateLocationDiscountForm(discountForm({ startDate: "2027-02-01", endDate: "2027-01-31" }), discountTargets, []).errors.endDate,
    /cannot be before the start date/);
  assert.deepEqual(validateLocationDiscountForm(discountForm({ startDate: "2027-02-01", endDate: "2027-02-01" }), discountTargets, []).errors, {});
  assert.deepEqual(validateLocationDiscountForm(discountForm({ startDate: "2028-02-29" }), discountTargets, []).errors, {});
  assert.deepEqual(validateLocationDiscountForm(discountForm({ endDate: "2027-03-01" }), discountTargets, []).errors, {});
});

test("overlapping location discount rules are rejected with the conflicting rule and postcode identified", () => {
  const existing = [
    discountRule("outward-rule", { name: "BH22 area", postcodePrecision: "outward", postcodes: ["BH22"] }),
    discountRule("full-rule", { name: "Pier postcodes", location: { type: "poi", id: "poi-pier" }, postcodes: ["BH2 5AA"], enabled: false })
  ];
  const coveredFull = validateLocationDiscountForm(discountForm({ postcodes: "BH22 8AB" }), discountTargets, existing);
  assert.equal(coveredFull.rule, null);
  assert.match(coveredFull.errors.postcodes, /BH22 8AB overlaps the outward code entry BH22 in the rule "BH22 area"/);
  assert.match(coveredFull.errors.postcodes, /cannot be stacked or combined/);

  const sameOutward = validateLocationDiscountForm(discountForm({ postcodePrecision: "outward", postcodes: "bh22" }), discountTargets, existing);
  assert.match(sameOutward.errors.postcodes, /BH22 overlaps the outward code entry BH22/);

  const disabledConflict = validateLocationDiscountForm(
    discountForm({ locationKey: "poi:poi-pier", postcodePrecision: "outward", postcodes: "BH2" }), discountTargets, existing);
  assert.match(disabledConflict.errors.postcodes, /BH2 overlaps the full postcode entry BH2 5AA in the rule "Pier postcodes" \(with no date limits, currently disabled\)/);

  assert.deepEqual(validateLocationDiscountForm(discountForm({ postcodes: "BH2 8AB" }), discountTargets, existing).errors, {},
    "BH2 is not treated as a partial-string match for BH22");
  assert.deepEqual(validateLocationDiscountForm(discountForm({ locationKey: "poi:poi-pier", postcodes: "BH22 8AB" }), discountTargets, existing).errors, {},
    "the same postcode for a different managed location is allowed");
  assert.deepEqual(validateLocationDiscountForm(discountForm({ postcodePrecision: "outward", postcodes: "BH22" }), discountTargets, existing, "outward-rule").errors, {},
    "editing a rule does not conflict with itself");
});

test("location discount overlap checks consider only overlapping validity periods", () => {
  const january = [discountRule("jan", { startDate: "2027-01-01", endDate: "2027-01-31" })];
  assert.deepEqual(validateLocationDiscountForm(discountForm({ startDate: "2027-02-01" }), discountTargets, january).errors, {});
  assert.deepEqual(validateLocationDiscountForm(discountForm({ endDate: "2026-12-31" }), discountTargets, january).errors, {});
  assert.ok(validateLocationDiscountForm(discountForm({ startDate: "2027-01-31" }), discountTargets, january).errors.postcodes, "end date is inclusive");
  assert.ok(validateLocationDiscountForm(discountForm(), discountTargets, january).errors.postcodes, "an open rule overlaps every period");
  assert.equal(findLocationDiscountConflict(discountRule("x", { postcodePrecision: "outward", postcodes: ["BH1"] }), january)?.conflictingEntry, "BH1 4RS");
});

test("location discount matching uses the exact managed ID, explicit precision, and either direction", () => {
  const fullRule = discountRule("full", { postcodes: ["BH1 4RS"] });
  const outwardRule = discountRule("outward", { location: { type: "poi", id: "poi-pier" }, postcodePrecision: "outward", postcodes: ["BH22"], discountPercentage: "7.5" });
  const rules = [fullRule, outwardRule];
  const airport = { managedLocation: { type: "airport" as const, id: "rm-boh" } };
  const pier = { managedLocation: { type: "poi" as const, id: "poi-pier" } };

  const toAirport = matchLocationDiscount(rules, { postcode: "bh14rs" }, airport, "2027-01-10");
  assert.equal(toAirport.status, "matched");
  assert.equal(toAirport.status === "matched" && toAirport.direction, "postcode-to-location");
  assert.equal(toAirport.status === "matched" && toAirport.rule.id, "full");
  const fromAirport = matchLocationDiscount(rules, airport, { postcode: "BH1 4RS" }, "2027-01-10");
  assert.equal(fromAirport.status === "matched" && fromAirport.direction, "location-to-postcode");

  const outward = matchLocationDiscount(rules, pier, { postcode: "BH22 8AB" }, "2027-01-10");
  assert.equal(outward.status === "matched" && outward.matchedEntry, "BH22");
  assert.equal(outward.status === "matched" && outward.discountPercentage, "7.5");
  assert.deepEqual(matchLocationDiscount(rules, pier, { postcode: "BH2 2AB" }, "2027-01-10"), { status: "no-match" }, "no partial-string match");
  assert.deepEqual(matchLocationDiscount(rules, airport, { postcode: "BH1 4RT" }, "2027-01-10"), { status: "no-match" },
    "a full-postcode rule does not match other postcodes in the same outward code");

  for (const notManaged of [
    { managedLocation: { type: "poi" as const, id: "rm-boh" } },
    { managedLocation: { type: "airport" as const, id: "Bournemouth Airport" } },
    { postcode: "BH23 6SE" }
  ]) {
    assert.deepEqual(matchLocationDiscount(rules, notManaged, { postcode: "BH1 4RS" }, "2027-01-10"), { status: "no-match" },
      "matching uses only the exact internal ID, not labels, the location's postcode, or proximity");
  }
  assert.deepEqual(matchLocationDiscount(rules, { postcode: "BH1 4RS" }, { postcode: "BH22 8AB" }, "2027-01-10"), { status: "no-match" },
    "a postcode-to-postcode route through a configured area does not match");
});

test("location discount matching reports missing or invalid endpoint postcodes as unresolved", () => {
  const rules = [discountRule("full")];
  const airport = { managedLocation: { type: "airport" as const, id: "rm-boh" } };
  const airportWithPostcode = { ...airport, postcode: "BH1 4RS" };
  for (const [origin, destination] of [[airportWithPostcode, airport], [airport, airportWithPostcode]] as const) {
    assert.deepEqual(matchLocationDiscount(rules, origin, destination, "2027-01-10"),
      { status: "unresolved", reason: "missing-postcode", ruleIds: ["full"] });
  }
  const sameRuleBothDirections = matchLocationDiscount(rules, airportWithPostcode, airportWithPostcode, "2027-01-10");
  assert.equal(sameRuleBothDirections.status, "matched");
  assert.equal(sameRuleBothDirections.status === "matched" && sameRuleBothDirections.rule.id, "full");

  for (const other of [{}, { postcode: null }, { postcode: "" }, { postcode: "BH1" }, { postcode: "Bournemouth BH1 4RS" }]) {
    assert.deepEqual(matchLocationDiscount(rules, airport, other, "2027-01-10"),
      { status: "unresolved", reason: "missing-postcode", ruleIds: ["full"] });
  }
  assert.deepEqual(matchLocationDiscount(rules, airport, { postcode: "BH1 4RS" }, "10/01/2027"),
    { status: "unresolved", reason: "invalid-service-date", ruleIds: ["full"] });
});

test("location discount matching honours validity dates, disabled rules, and never stacks", () => {
  const airport = { managedLocation: { type: "airport" as const, id: "rm-boh" } };
  const dated = [discountRule("jan", { startDate: "2027-01-01", endDate: "2027-01-31" })];
  assert.equal(matchLocationDiscount(dated, airport, { postcode: "BH1 4RS" }, "2027-01-01").status, "matched");
  assert.equal(matchLocationDiscount(dated, airport, { postcode: "BH1 4RS" }, "2027-01-31").status, "matched");
  assert.equal(matchLocationDiscount(dated, airport, { postcode: "BH1 4RS" }, "2026-12-31").status, "no-match");
  assert.equal(matchLocationDiscount(dated, airport, { postcode: "BH1 4RS" }, "2027-02-01").status, "no-match");
  assert.equal(matchLocationDiscount([discountRule("off", { enabled: false })], airport, { postcode: "BH1 4RS" }, "2027-01-10").status, "no-match");

  const ambiguous = matchLocationDiscount(
    [discountRule("a"), discountRule("b", { postcodePrecision: "outward", postcodes: ["BH1"] })],
    airport, { postcode: "BH1 4RS" }, "2027-01-10");
  assert.deepEqual(ambiguous, { status: "unresolved", reason: "ambiguous-rules", ruleIds: ["a", "b"] });
});

test("location discount configuration is preserved by other category saves and is not used by fare calculation", () => {
  const rule = discountRule("kept");
  const current: FareSettingsConfiguration = { ...EMPTY_FARE_SETTINGS, locationDiscounts: [rule] };
  const result = validateFareSettingsForm(dailyAndBankDisabled, current);
  assert.deepEqual(result.configuration.locationDiscounts, [rule]);

  const slabs: DistanceSlab[] = [{ startMiles: "0", endMiles: "", ratePerMile: "2.00" }];
  assert.equal(calculateDistanceSlabFare(slabs, "10"), "20.00", "base fare calculation is unchanged by configured discounts");
  const source = readFileSync("src/services/fare-settings.ts", "utf8");
  const calculator = source.slice(source.indexOf("export function calculateDistanceSlabFare"));
  assert.doesNotMatch(calculator.slice(0, calculator.indexOf("\n}\n")), /locationDiscount/i);
});

function radiusForm(overrides: Record<string, string> = {}) {
  return {
    name: "Base area to Bournemouth Airport",
    locationKey: "airport:rm-boh",
    radiusMiles: "5",
    discountPercentage: "10",
    startDate: "",
    endDate: "",
    enabled: "no",
    ...overrides
  };
}

function radiusRule(id: string, overrides: Partial<RadiusLocationDiscountRule> = {}): RadiusLocationDiscountRule {
  return {
    id,
    name: `Radius ${id}`,
    location: { type: "airport", id: "rm-boh" },
    radiusMiles: "5",
    discountPercentage: "10",
    startDate: "",
    endDate: "",
    enabled: true,
    radiusCentre: "operational-base",
    discountBasis: "standard-distance-slabs-base-fare",
    ...overrides
  };
}

test("radius discount validation stores the exact managed ID, normalized radius and percentage", () => {
  const result = validateRadiusLocationDiscountForm(
    radiusForm({ radiusMiles: "7.250", discountPercentage: "12.50", startDate: "2027-01-01", endDate: "2027-01-31", enabled: "yes" }),
    discountTargets, [], true);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.rule, {
    name: "Base area to Bournemouth Airport",
    location: { type: "airport", id: "rm-boh" },
    radiusMiles: "7.25",
    discountPercentage: "12.5",
    startDate: "2027-01-01",
    endDate: "2027-01-31",
    enabled: true,
    radiusCentre: "operational-base",
    discountBasis: "standard-distance-slabs-base-fare"
  });
});

test("radius discount validation rejects invalid radii, percentages, dates, locations and an unverified base", () => {
  for (const radiusMiles of ["", "0", "0.000", "-1", "1.2345", "abc", "1e2", "100000"]) {
    assert.match(validateRadiusLocationDiscountForm(radiusForm({ radiusMiles }), discountTargets, [], true).errors.radiusMiles ?? "",
      /greater than 0/, `radius ${radiusMiles}`);
  }
  for (const discountPercentage of ["", "0", "-5", "100.01", "101", "10.123", "ten"]) {
    assert.match(validateRadiusLocationDiscountForm(radiusForm({ discountPercentage }), discountTargets, [], true).errors.discountPercentage ?? "",
      /greater than 0 and no more than 100/, `percentage ${discountPercentage}`);
  }
  assert.equal(validateRadiusLocationDiscountForm(radiusForm({ discountPercentage: "100" }), discountTargets, [], true).rule?.discountPercentage, "100");
  assert.match(validateRadiusLocationDiscountForm(radiusForm({ startDate: "2027-02-30" }), discountTargets, [], true).errors.startDate ?? "", /valid start date/);
  assert.match(validateRadiusLocationDiscountForm(radiusForm({ endDate: "31/01/2027" }), discountTargets, [], true).errors.endDate ?? "", /valid end date/);
  assert.match(validateRadiusLocationDiscountForm(radiusForm({ startDate: "2027-02-01", endDate: "2027-01-31" }), discountTargets, [], true).errors.endDate ?? "",
    /cannot be before the start date/);
  assert.match(validateRadiusLocationDiscountForm(radiusForm({ locationKey: "airport:rm-unknown" }), discountTargets, [], true).errors.locationKey ?? "",
    /no other location is substituted/);
  assert.match(validateRadiusLocationDiscountForm(radiusForm({ locationKey: "Bournemouth Airport" }), discountTargets, [], true).errors.locationKey ?? "",
    /missing or no longer available/, "a display name is never accepted in place of the managed ID");
  assert.match(validateRadiusLocationDiscountForm(radiusForm({ enabled: "maybe" }), discountTargets, [], true).errors.enabled ?? "", /enabled or disabled/);
  const unverified = validateRadiusLocationDiscountForm(radiusForm(), discountTargets, [], false);
  assert.equal(unverified.rule, null);
  assert.match(unverified.errors.radiusMiles ?? "", /operational base has no verified coordinates/);
});

test("radius discount validation rejects overlapping rules for the same location, including disabled ones", () => {
  const existing = [radiusRule("current", { startDate: "2027-01-01", endDate: "2027-06-30", enabled: false })];
  const overlap = validateRadiusLocationDiscountForm(radiusForm({ startDate: "2027-06-30" }), discountTargets, existing, true);
  assert.equal(overlap.rule, null);
  assert.match(overlap.errors.locationKey ?? "", /already has the operational-base radius discount "Radius current".*currently disabled.*cannot be stacked, combined or chosen between/);
  assert.match(validateRadiusLocationDiscountForm(radiusForm(), discountTargets, existing, true).errors.locationKey ?? "", /overlapping validity period/,
    "an open-ended rule overlaps every dated rule");

  assert.deepEqual(validateRadiusLocationDiscountForm(radiusForm({ startDate: "2027-07-01" }), discountTargets, existing, true).errors, {});
  assert.deepEqual(validateRadiusLocationDiscountForm(radiusForm({ locationKey: "poi:poi-pier" }), discountTargets, existing, true).errors, {});
  assert.deepEqual(validateRadiusLocationDiscountForm(radiusForm({ startDate: "2027-02-01" }), discountTargets, existing, true, "current").errors, {},
    "editing a rule does not conflict with itself");
});

test("radius discount configuration is preserved by other category saves", () => {
  const rule = { ...radiusRule("kept") };
  const current: FareSettingsConfiguration = { ...EMPTY_FARE_SETTINGS, radiusLocationDiscounts: [rule] };
  assert.deepEqual(validateFareSettingsForm(dailyAndBankDisabled, current).configuration.radiusLocationDiscounts, [rule]);
});
