import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Manage VPS keeps the safe recovery placeholder as a button and relies on the global workspace action", () => {
  const template = fs.readFileSync("src/views/pages/role-section.ejs", "utf8");

  assert.match(template, /class="button button--execute-helper" href="\/recovery">Open reboot and recovery placeholder/);
  assert.match(template, /Safety notice:<\/strong> reboot and recovery are placeholders/);
  assert.doesNotMatch(template, /<p><a href="\/choose-role">Switch workspace<\/a><\/p>/);
});
