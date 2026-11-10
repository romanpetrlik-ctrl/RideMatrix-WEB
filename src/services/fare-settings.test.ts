import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MIGRATIONS } from "../database/migrations";
import calculateBrowserDistanceSlabFare from "../../public/js/distance-slab-calculator";
import {
  EMPTY_FARE_SETTINGS,
  calculateDistanceSlabFare,
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

test("fare settings start disabled without assumed percentages or times", () => {
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
  assert.match(script, /slabList\?\.addEventListener\("input", \(event\) => \{\s*updateSlabInputErrors\(event\);[\s\S]{0,250}calculatePreview\(\);\s*\}\)/);
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
