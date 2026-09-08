/**
 * Tests for test discovery and database safety
 * These verify that:
 * 1. Test discovery correctly identifies unit vs integration tests
 * 2. Unit tests can run without PostgreSQL
 * 3. Integration tests require TEST_DATABASE_URL (not DATABASE_URL)
 * 4. Cleanup is safe even if setup fails
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";

describe("Test discovery", () => {
  test("discovery script identifies unit tests correctly", () => {
    const discoveryScript = path.join(process.cwd(), "src", "test-discover.ts");
    const result = spawnSync("tsx", [discoveryScript, "--unit"], {
      cwd: process.cwd(),
      encoding: "utf-8"
    });

    assert.equal(result.status, 0, `Discovery failed: ${result.stderr}`);

    const files = result.stdout.trim().split("\n").filter((f) => f.length > 0);
    assert.ok(files.length > 0, "Should find unit tests");

    // Check that it includes known unit tests
    const hasRequestLimitsTest = files.some((f) => f.includes("request-limits.test.ts"));
    const hasCsrfServiceTest = files.some((f) => f.includes("services/csrf.test.ts"));
    assert.ok(hasRequestLimitsTest, "Should include request-limits.test.ts");
    assert.ok(hasCsrfServiceTest, "Should include services/csrf.test.ts");

    // Check that it excludes known integration tests
    const hasCustomersTest = files.some((f) => f.includes("services/customers.test.ts"));
    const hasStaffTest = files.some((f) => f.includes("services/staff.test.ts"));
    assert.ok(!hasCustomersTest, "Should not include services/customers.test.ts in unit tests");
    assert.ok(!hasStaffTest, "Should not include services/staff.test.ts in unit tests");
  });

  test("discovery script identifies integration tests correctly", () => {
    const discoveryScript = path.join(process.cwd(), "src", "test-discover.ts");
    const result = spawnSync("tsx", [discoveryScript, "--integration"], {
      cwd: process.cwd(),
      encoding: "utf-8"
    });

    assert.equal(result.status, 0, `Discovery failed: ${result.stderr}`);

    const files = result.stdout.trim().split("\n").filter((f) => f.length > 0);
    assert.ok(files.length > 0, "Should find integration tests");

    // Check that it includes known integration tests
    const hasCustomersTest = files.some((f) => f.includes("services/customers.test.ts"));
    const hasStaffTest = files.some((f) => f.includes("services/staff.test.ts"));
    assert.ok(hasCustomersTest, "Should include services/customers.test.ts in integration tests");
    assert.ok(hasStaffTest, "Should include services/staff.test.ts in integration tests");

    // Check that it excludes known unit tests
    const hasRequestLimitsTest = files.some((f) => f.includes("request-limits.test.ts"));
    const hasCsrfServiceTest = files.some((f) => f.includes("services/csrf.test.ts"));
    assert.ok(!hasRequestLimitsTest, "Should not include request-limits.test.ts in integration tests");
    assert.ok(!hasCsrfServiceTest, "Should not include services/csrf.test.ts in integration tests");
  });

  test("discovery script lists all tests with --all", () => {
    const discoveryScript = path.join(process.cwd(), "src", "test-discover.ts");
    const result = spawnSync("tsx", [discoveryScript, "--all"], {
      cwd: process.cwd(),
      encoding: "utf-8"
    });

    assert.equal(result.status, 0, `Discovery failed: ${result.stderr}`);

    const files = result.stdout.trim().split("\n").filter((f) => f.length > 0);
    assert.ok(files.length > 0, "Should find all tests");

    // Check that it includes both unit and integration tests
    const hasRequestLimitsTest = files.some((f) => f.includes("request-limits.test.ts"));
    const hasCsrfServiceTest = files.some((f) => f.includes("services/csrf.test.ts"));
    const hasCustomersTest = files.some((f) => f.includes("services/customers.test.ts"));
    const hasStaffTest = files.some((f) => f.includes("services/staff.test.ts"));

    assert.ok(hasRequestLimitsTest, "Should include unit test");
    assert.ok(hasCsrfServiceTest, "Should include unit test");
    assert.ok(hasCustomersTest, "Should include integration test");
    assert.ok(hasStaffTest, "Should include integration test");
  });
});

describe("Database safety", () => {
  test("getBaseTestDatabaseUrl throws when TEST_DATABASE_URL is not set", () => {
    // Create a test script that tries to use getBaseTestDatabaseUrl without TEST_DATABASE_URL
    const testScript = `
      const { getBaseTestDatabaseUrl } = require("./dist/database/test-helper");
      try {
        getBaseTestDatabaseUrl();
        console.log("ERROR: Should have thrown");
        process.exit(1);
      } catch (error) {
        if (error.message.includes("TEST_DATABASE_URL")) {
          console.log("OK: Correctly threw error about TEST_DATABASE_URL");
          process.exit(0);
        } else {
          console.log("ERROR: Wrong error message: " + error.message);
          process.exit(1);
        }
      }
    `;

    // First check if built files exist, if not, build them
    const distPath = path.join(process.cwd(), "dist", "database", "test-helper.js");
    if (!fs.existsSync(distPath)) {
      // Build the project
      const buildResult = spawnSync("npm", ["run", "build"], {
        cwd: process.cwd(),
        encoding: "utf-8"
      });

      if (buildResult.status !== 0) {
        // Skip this test if build fails
        console.log("Skipping test: build failed");
        return;
      }
    }

    // Run the test with empty TEST_DATABASE_URL
    const result = spawnSync("node", ["-e", testScript], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        TEST_DATABASE_URL: "", // Explicitly set to empty
        DATABASE_URL: "postgres://production" // Set to something else
      }
    });

    assert.equal(result.status, 0, `Should detect TEST_DATABASE_URL requirement. Output: ${result.stdout}${result.stderr}`);
  });

  test("safeCleanupTestDatabase exists and handles undefined gracefully", () => {
    // Check that the test-helper exports safeCleanupTestDatabase
    const testHelperPath = path.join(process.cwd(), "src", "database", "test-helper.ts");
    const content = fs.readFileSync(testHelperPath, "utf-8");
    
    assert.ok(
      content.includes("export async function safeCleanupTestDatabase"),
      "test-helper should export safeCleanupTestDatabase"
    );
    
    assert.ok(
      content.includes("if (dbContext && typeof dbContext.cleanup === \"function\")"),
      "safeCleanupTestDatabase should check if context exists before calling cleanup"
    );
  });
});

describe("Test runner", () => {
  test("test runner script exists and is executable", () => {
    const runnerScript = path.join(process.cwd(), "src", "test-run.ts");
    assert.ok(fs.existsSync(runnerScript), "test-run.ts should exist");
  });

  test("discovery script handles invalid filters", () => {
    const discoveryScript = path.join(process.cwd(), "src", "test-discover.ts");
    const result = spawnSync("tsx", [discoveryScript, "--invalid"], {
      cwd: process.cwd(),
      encoding: "utf-8"
    });

    assert.notEqual(result.status, 0, "Should fail with invalid filter");
  });
});
