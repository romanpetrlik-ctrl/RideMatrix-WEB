import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedDriverStatusTransition } from "./driver-bookings";

test("driver live statuses follow the ordered journey workflow", () => {
  assert.equal(isAllowedDriverStatusTransition(null, "En route"), true);
  assert.equal(isAllowedDriverStatusTransition("En route", "Waiting near pickup"), true);
  assert.equal(isAllowedDriverStatusTransition("Waiting near pickup", "Arrived at pickup"), true);
  assert.equal(isAllowedDriverStatusTransition("Arrived at pickup", "Passenger on board"), true);
  assert.equal(isAllowedDriverStatusTransition("Journey started", "On break"), true);
  assert.equal(isAllowedDriverStatusTransition("On break", "Resume journey"), true);
  assert.equal(isAllowedDriverStatusTransition("Arrived at destination", "Extras payable"), true);
  assert.equal(isAllowedDriverStatusTransition("Extras payable", "Extras paid"), true);
  assert.equal(isAllowedDriverStatusTransition("Extras paid", "Ride finished"), true);
});

test("driver live statuses cannot skip required steps or resume a finished ride", () => {
  assert.equal(isAllowedDriverStatusTransition(null, "Arrived at pickup"), false);
  assert.equal(isAllowedDriverStatusTransition("En route", "Passenger on board"), false);
  assert.equal(isAllowedDriverStatusTransition("On break", "Arrived at destination"), false);
  assert.equal(isAllowedDriverStatusTransition("Extras payable", "Ride finished"), false);
  assert.equal(isAllowedDriverStatusTransition("Ride finished", "Journey started"), false);
});
