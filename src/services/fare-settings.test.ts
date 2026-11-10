import assert from "node:assert/strict";
import test from "node:test";
import { MIGRATIONS } from "../database/migrations";
import {
  EMPTY_FARE_SETTINGS,
  validateFareSettingsForm,
  type BankHolidaySurchargePeriod
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
