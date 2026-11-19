import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const scripts = [
  "public/js/customer-address-autocomplete.js",
  "public/js/new-booking.js",
  "public/js/airport-fees.js",
  "public/js/poi-places.js",
  "public/js/setup-address-autocomplete.js"
];

test("every Google Places autocomplete is restricted to UK suggestions", () => {
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(process.cwd(), script), "utf8");
    assert.match(
      source,
      /includedRegionCodes\s*=\s*\["gb"\]|new [^\n]*PlaceAutocompleteElement\(\s*\{\s*includedRegionCodes:\s*\["gb"\]\s*\}\s*\)/,
      script
    );
  }
});
