import assert from "node:assert/strict";
import test from "node:test";
import {
  activationBlockers,
  applyRoadChargeActivation,
  applyRoadChargeEdit,
  codeCalculationBlockers,
  RoadChargeActivationError,
  roadChargeScheduleSeeds,
  validateRoadChargeScheduleEdit,
  type RoadChargeSchedule
} from "./road-charge-schedules";

const actor = { accountId: "u-1", email: "admin@example.com" };
const now = new Date("2026-11-20T12:00:00Z");
const seed = (scheme: keyof typeof roadChargeScheduleSeeds): RoadChargeSchedule => structuredClone(roadChargeScheduleSeeds[scheme]);

test("seeded schedules are inactive; only LEZ is free of blockers", () => {
  for (const schedule of Object.values(roadChargeScheduleSeeds)) {
    assert.equal(schedule.status, "inactive");
    assert.equal(schedule.active, false);
    assert.equal(schedule.bookingPriceUsage, "never");
    assert.equal(schedule.verification, null);
  }
  assert.deepEqual(activationBlockers(seed("london-lez")), []);
  assert.match(activationBlockers(seed("london-ulez")).join(" "), /ULEZ route exposure uses a boundary dataset/);
  assert.deepEqual(codeCalculationBlockers("london-congestion-charge"), []);
  assert.doesNotMatch(activationBlockers(seed("london-congestion-charge")).join(" "), /boundary|verification record/);
  assert.match(activationBlockers(seed("blackwall-silvertown-tunnels")).join(" "), /unverified reference geometry/);
});

test("incomplete or unverified schedules are rejected for activation", () => {
  const blockersFor = (change: (schedule: RoadChargeSchedule) => void) => {
    const schedule = seed("london-lez");
    change(schedule);
    return activationBlockers(schedule).join(" ");
  };
  assert.match(blockersFor((s) => { s.effectiveFrom = null; }), /effective-from date is unknown/);
  assert.match(blockersFor((s) => { s.effectiveUntil = "2020-01-01"; }), /effective-until date is invalid/);
  assert.match(blockersFor((s) => { s.sources = [{ label: "Blog", url: "https://example.com/lez", effectiveDate: null }]; }), /does not have an https TfL or GOV\.UK URL/);
  assert.match(blockersFor((s) => { s.sources = [{ label: "Spoof", url: "https://tfl.gov.uk.example.com/", effectiveDate: null }]; }), /does not have an https TfL or GOV\.UK URL/);
  assert.match(blockersFor((s) => { s.sources = []; }), /No source is recorded/);
  assert.match(blockersFor((s) => { s.research = null; }), /No research\/verification date/);
  assert.match(blockersFor((s) => { s.calculationBlockers = ["Rule X is unresolved."]; }), /Rule X is unresolved/);
  assert.match(blockersFor((s) => { s.rates = s.rates.slice(1); }), /Rate “lez-vans-specialist-minibuses” is missing/);
  assert.match(blockersFor((s) => { s.rates[0].amount = "0.00"; }), /is £0\.00 but is not a verified zero rate/);
  assert.match(blockersFor((s) => { s.rates[0].amount = "abc"; }), /invalid amount/);

  const cc = seed("london-congestion-charge");
  if (cc.kind === "daily-zone") cc.rules.calendarCoverage = null;
  assert.match(activationBlockers(cc).join(" "), /no verified bank-holiday calendar/);
});

test("enabling requires a past verification date and confirmed sources, and records the actor", () => {
  const attempt = (request: Parameters<typeof applyRoadChargeActivation>[1], schedule = seed("london-lez")) => {
    try {
      applyRoadChargeActivation(schedule, request, actor, now);
      return [];
    } catch (error) {
      assert.ok(error instanceof RoadChargeActivationError);
      return error.blockers;
    }
  };
  assert.match(attempt({ action: "enable", verifiedOn: "2026-11-21", sourcesConfirmed: true }).join(" "), /cannot be in the future/);
  assert.match(attempt({ action: "enable", verifiedOn: "2026-02-30", sourcesConfirmed: true }).join(" "), /Enter the date you verified/);
  assert.match(attempt({ action: "enable", verifiedOn: "2026-11-20", sourcesConfirmed: false }).join(" "), /Confirm that you opened every cited source/);
  assert.ok(attempt({ action: "enable", verifiedOn: "2026-11-20", sourcesConfirmed: true }, seed("blackwall-silvertown-tunnels")).length > 0);

  const enabled = applyRoadChargeActivation(seed("london-lez"), { action: "enable", verifiedOn: "2026-11-20", sourcesConfirmed: true }, actor, now);
  assert.equal(enabled.status, "active");
  assert.equal(enabled.active, true);
  assert.equal(enabled.bookingPriceUsage, "new-booking-quotes");
  assert.deepEqual(enabled.verification, { verifiedOn: "2026-11-20", verifiedByEmail: "admin@example.com", verifiedByAccountId: "u-1", recordedAt: now.toISOString(), sourcesConfirmed: true });

  const disabled = applyRoadChargeActivation(enabled, { action: "disable" }, actor, now);
  assert.equal(disabled.active, false);
  assert.equal(disabled.bookingPriceUsage, "never");
  assert.equal(disabled.verification, null, "re-enabling needs a fresh verification");
});

test("edits validate amounts and dates and always produce an inactive, unverified version", () => {
  const enabled = applyRoadChargeActivation(seed("london-lez"), { action: "enable", verifiedOn: "2026-11-20", sourcesConfirmed: true }, actor, now);
  const amounts = Object.fromEntries(enabled.rates.map((rate) => [rate.key, rate.amount]));
  const edited = applyRoadChargeEdit(enabled, { amounts: { ...amounts, "lez-vans-specialist-minibuses": "105.00" }, effectiveFrom: "2021-03-01", effectiveUntil: null });
  assert.equal(edited.active, false);
  assert.equal(edited.status, "inactive");
  assert.equal(edited.verification, null);
  assert.equal(edited.rates.find((rate) => rate.key === "lez-vans-specialist-minibuses")?.amount, "105.00");

  const body = (overrides: Record<string, string>) => ({ ...Object.fromEntries(enabled.rates.map((rate) => [`amount_${rate.key}`, rate.amount])), effectiveFrom: "2021-03-01", effectiveUntil: "", ...overrides });
  assert.ok(validateRoadChargeScheduleEdit(enabled, body({ "amount_lez-heavy-euro-iv-pm": "0" })).errors["lez-heavy-euro-iv-pm"]);
  assert.ok(validateRoadChargeScheduleEdit(enabled, body({ "amount_lez-heavy-euro-iv-pm": "-1" })).errors["lez-heavy-euro-iv-pm"]);
  assert.ok(validateRoadChargeScheduleEdit(enabled, body({ effectiveUntil: "2020-01-01" })).errors.effectiveUntil);
  const cc = seed("london-congestion-charge");
  const ccBody = { ...Object.fromEntries(cc.rates.map((rate) => [`amount_${rate.key}`, rate.amount])), effectiveFrom: "2026-01-02", effectiveUntil: "2030-03-03" };
  assert.deepEqual(validateRoadChargeScheduleEdit(cc, ccBody).errors, {}, "the registered 100% discount may be £0.00");
  assert.equal(validateRoadChargeScheduleEdit(cc, ccBody).amounts["cc-registered-100-percent-discount"], "0.00");
});
