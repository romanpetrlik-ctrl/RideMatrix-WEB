/**
 * Test runner: discovers tests and runs them with Node's test runner
 * Usage: tsx src/test-run.ts [--unit | --integration]
 *
 * This is a thin wrapper around Node's built-in test runner that:
 * 1. Uses the test discovery script to find test files
 * 2. Runs them with node --import tsx --test
 * 3. Handles missing TEST_DATABASE_URL for integration tests gracefully
 */

import { spawn } from "child_process";
import path from "path";
import fs from "fs";

async function getTestFiles(filter: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const discoveryScript = path.join(process.cwd(), "src", "test-discover.ts");
    const child = spawn("tsx", [discoveryScript, filter], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        // Exit code 1 is OK for integration tests if none found
        // (when TEST_DATABASE_URL not set)
        const files = stdout
          .trim()
          .split("\n")
          .filter((f) => f.length > 0);
        resolve(files);
      } else {
        reject(new Error(`Discovery script failed: ${stderr}`));
      }
    });
  });
}

async function runTests(testFiles: string[], filter: string): Promise<number> {
  if (testFiles.length === 0) {
    if (filter === "--integration") {
      const testDatabaseUrl = process.env.TEST_DATABASE_URL;
      if (!testDatabaseUrl) {
        console.warn(
          "\n[test-runner] TEST_DATABASE_URL is not set. " +
            "PostgreSQL integration tests are disabled.\n" +
            "To enable integration tests, set TEST_DATABASE_URL and run:\n" +
            "  npm run test:integration\n"
        );
        return 0; // Exit cleanly - this is expected behavior
      }
      console.error("[test-runner] No integration tests found.");
      return 1;
    } else {
      console.error("[test-runner] No unit tests found.");
      return 1;
    }
  }

  return new Promise((resolve) => {
    const args = ["--import", "tsx", "--test", "--test-concurrency=1", ...testFiles];
    const child = spawn("node", args, {
      cwd: process.cwd(),
      stdio: "inherit"
    });

    child.on("close", (code) => {
      resolve(code || 0);
    });
  });
}

async function main(): Promise<void> {
  const filter = process.argv[2] || "--unit";

  // Validate filter
  if (!["--unit", "--integration", "--all"].includes(filter)) {
    console.error(`Unknown filter: ${filter}. Use --unit, --integration, or --all`);
    process.exit(1);
  }

  try {
    const testFiles = await getTestFiles(filter);
    const exitCode = await runTests(testFiles, filter);
    process.exit(exitCode);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
