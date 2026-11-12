import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MIGRATIONS } from "../database/migrations";
import calculateBrowserDistanceSlabFare from "../../public/js/distance-slab-calculator";
import type { AirportFeeRecord } from "./airport-fees";
import {
  EMPTY_FARE_SETTINGS,
  calculateDistanceSlabFare,
  matchesMinimumFareRule,
  validateFixedFareRuleForm,
  validateMinimumFareRuleForm,
  validateDistanceSlabsForm,
  validateFareSettingsForm,
  type BankHolidaySurchargePeriod,
  type DistanceSlab
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
  assert.deepEqual(EMPTY_FARE_SETTINGS.minimumFareRules, []);
  assert.deepEqual(EMPTY_FARE_SETTINGS.fixedFares, []);
  assert.deepEqual(EMPTY_FARE_SETTINGS.dailySurcharge, {
    enabled: false,
    percentage: "",
    startTime: "",
    endTime: ""
  });
  assert.deepEqual(EMPTY_FARE_SETTINGS.bankHolidaySurcharge, { enabled: false, periods: [] });
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
    minimumFareRules: [{
      id: "minimum-rule",
      name: "Minimum",
      poiId: "managed-id",
      radiusMiles: "5",
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

test("minimum fare rules retain the managed POI internal ID and validate configured operational coordinates", () => {
  const airport = managedAirport();
  const valid = validateMinimumFareRuleForm({
    name: "BOH short journey",
    poiId: airport.id,
    radiusMiles: "5",
    minimumBaseFare: "25"
  }, [airport]);
  assert.deepEqual(valid.errors, {});
  assert.deepEqual(valid.values, {
    name: "BOH short journey",
    poiId: "rm-boh-internal-id",
    radiusMiles: "5",
    minimumBaseFare: "25.00"
  });

  const invalidLocation = validateMinimumFareRuleForm({
    name: "Missing operation point",
    poiId: airport.id,
    radiusMiles: "5",
    minimumBaseFare: "25"
  }, [managedAirport({ pickupLatitude: Number.NaN })]);
  assert.match(invalidLocation.errors.poiId, /no valid configured pick-up and drop-off operational coordinates/);
  assert.match(validateMinimumFareRuleForm({
    name: "Unmanaged",
    poiId: "google-airport-label",
    radiusMiles: "5",
    minimumBaseFare: "25"
  }, [airport]).errors.poiId, /active managed/);
});

test("minimum fare radius is geodesic, inclusive at five miles, direction-aware, and uses the Airport Fees operation point", () => {
  const airport = managedAirport();
  const rule = {
    id: "minimum-rule",
    name: "BOH five mile minimum",
    poiId: airport.id,
    radiusMiles: "5",
    minimumBaseFare: "25.00"
  };
  const exactAngularDelta = 5 * 1609.344 / 6_371_008.8 * 180 / Math.PI;
  const exactDropoffPoint = { latitude: 0, longitude: exactAngularDelta };
  const exactPickupPoint = { latitude: 20 + exactAngularDelta, longitude: 20 };
  const outsidePoint = { latitude: 0, longitude: exactAngularDelta + 0.00001 };

  assert.equal(matchesMinimumFareRule(rule, exactDropoffPoint, { poiId: airport.id }, airport), true);
  assert.equal(matchesMinimumFareRule(rule, { poiId: airport.id }, exactPickupPoint, airport), true);
  assert.equal(matchesMinimumFareRule(rule, outsidePoint, { poiId: airport.id }, airport), false);
  assert.equal(matchesMinimumFareRule(rule, exactDropoffPoint, { poiId: "different-id" }, airport), false);
  assert.equal(matchesMinimumFareRule(rule, { latitude: NaN, longitude: 0 }, { poiId: airport.id }, airport), false);
  assert.equal(matchesMinimumFareRule(rule, { poiId: airport.id }, {
    ...exactDropoffPoint, poiId: airport.id
  }, airport), false);
});

test("minimum and fixed base fares reject negative, malformed, and over-precision GBP values", () => {
  for (const amount of ["-1", "1.001", "1e2", "Infinity", "", "1000000"]) {
    assert.ok(validateMinimumFareRuleForm({
      name: "Test", poiId: "rm-boh-internal-id", radiusMiles: "5", minimumBaseFare: amount
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
