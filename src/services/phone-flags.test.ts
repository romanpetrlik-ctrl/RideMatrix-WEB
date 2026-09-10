import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

function loadFlagHelper(): (isoCode?: string) => string {
  const source = fs.readFileSync(path.join(process.cwd(), "public/js/phone-flags.js"), "utf8");
  const sandbox = { Intl, window: {} as { PhoneFlags?: { flagForIso: (isoCode?: string) => string } } };
  vm.runInNewContext(source, sandbox);
  assert.ok(sandbox.window.PhoneFlags);
  return sandbox.window.PhoneFlags.flagForIso;
}

test("converts supported country codes to flags and unknown codes to a globe", () => {
  const flagForIso = loadFlagHelper();

  assert.equal(flagForIso("CZ"), "🇨🇿");
  assert.equal(flagForIso("GB"), "🇬🇧");
  assert.equal(flagForIso("FR"), "🇫🇷");
  assert.equal(flagForIso("unknown"), "🌐");
  assert.equal(flagForIso("ZZ"), "🌐");
});
