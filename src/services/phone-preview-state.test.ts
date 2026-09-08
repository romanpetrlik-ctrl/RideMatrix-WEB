import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import vm from "vm";

type Snapshot = { requestId: number; value: string };

interface Tracker {
  trackRequest(value: string): Snapshot;
  isCurrent(snapshot: Snapshot): boolean;
  resolve<T>(snapshot: Snapshot, preview: T): T | null;
}

// Loads the browser bundle served at /js/phone-preview-state.js the same way
// public/js/phone-number.js consumes it: through window.PhonePreviewState.
function createTracker(): Tracker {
  const bundlePath = path.join(process.cwd(), "public/js/phone-preview-state.js");
  const source = fs.readFileSync(bundlePath, "utf-8");
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(source, sandbox);
  const factory = (sandbox.window.PhonePreviewState as { createPhonePreviewTracker?: () => Tracker })
    ?.createPhonePreviewTracker;
  assert.ok(factory, "phone-preview-state.js should expose window.PhonePreviewState.createPhonePreviewTracker");
  return factory();
}

test("returns the preview unchanged while the request is current", () => {
  const tracker = createTracker();
  const snapshot = tracker.trackRequest("07777 888 999");
  const preview = { valid: true, normalized: "+447777888999" };

  assert.equal(tracker.isCurrent(snapshot), true);
  assert.equal(tracker.resolve(snapshot, preview), preview);
});

test("discards a response once a newer request has been tracked", () => {
  const tracker = createTracker();
  const stale = tracker.trackRequest("07777 888 999");
  tracker.trackRequest("00420724982564");

  assert.equal(tracker.isCurrent(stale), false);
  assert.equal(tracker.resolve(stale, { valid: true }), null);
});

test("keeps only the newest request current when responses resolve out of order", () => {
  const tracker = createTracker();
  const first = tracker.trackRequest("+442077778888");
  const second = tracker.trackRequest("+420724982564");
  const latestPreview = { valid: true, normalized: "+420724982564" };

  // The newest response applies first; the stale response must then be ignored.
  assert.equal(tracker.resolve(second, latestPreview), latestPreview);
  assert.equal(tracker.isCurrent(first), false);
  assert.equal(tracker.resolve(first, { valid: true, normalized: "+442077778888" }), null);
  assert.equal(tracker.isCurrent(second), true);
});

test("discards a response when the input was cleared after the request was sent", () => {
  const tracker = createTracker();
  const snapshot = tracker.trackRequest("07777 888 999");
  tracker.trackRequest("");

  assert.equal(tracker.isCurrent(snapshot), false);
  assert.equal(tracker.resolve(snapshot, { valid: true }), null);
});

test("a superseded request resolves to null instead of an invalid fallback", () => {
  const tracker = createTracker();
  const stale = tracker.trackRequest("+420111111111");
  const current = tracker.trackRequest("+420724982564");

  // A stale (superseded/aborted) request must not surface an error state;
  // resolving to null lets the component leave the current UI untouched.
  assert.equal(tracker.resolve(stale, { valid: false }), null);
  assert.equal(tracker.isCurrent(current), true);
});

test("the snapshot keeps the requested value so a normalized response still applies", () => {
  const tracker = createTracker();
  const snapshot = tracker.trackRequest("00420724982564");
  const preview = { valid: true, normalized: "+420724982564" };

  // The component rewrites the visible input to the normalized E.164 value;
  // the snapshot still matches the value the request was sent for.
  assert.equal(tracker.resolve(snapshot, preview), preview);
  assert.equal(tracker.resolve(snapshot, preview)?.normalized, "+420724982564");
});
