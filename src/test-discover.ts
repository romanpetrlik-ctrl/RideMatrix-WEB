/**
 * Test discovery script: finds and categorizes test files.
 * Usage: tsx src/test-discover.ts [--unit | --integration]
 *
 * Identifies tests as "integration" if they contain markers indicating
 * PostgreSQL database dependency:
 * - import from "test-helper" (uses TestDatabaseContext)
 * - import from "connection" with createTestDatabaseContext
 *
 * All other .test.ts files are categorized as "unit" tests.
 */

import fs from "fs";
import path from "path";

/**
 * Recursively find all .test.ts and .integration.test.ts files
 */
function findTestFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentPath: string): void {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      // Skip node_modules and dist
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith(".test.ts") || entry.name.endsWith(".integration.test.ts"))) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files.sort();
}

/**
 * Determine if a test file is an integration test by checking for database imports
 */
function isIntegrationTest(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf-8");

  // Check for database test helper imports
  if (content.includes('from "../database/test-helper"') || content.includes('from "../../database/test-helper"')) {
    return true;
  }

  // Check for TestDatabaseContext type usage
  if (content.includes("TestDatabaseContext") || content.includes("createTestDatabaseContext")) {
    return true;
  }

  // Check for initializeDatabase import from connection
  if (content.includes('from "../database/connection"') || content.includes('from "../../database/connection"')) {
    if (content.includes("initializeDatabase")) {
      return true;
    }
  }

  return false;
}

/**
 * Main entry point
 */
function main(): void {
  const filter = process.argv[2]; // --unit or --integration
  const srcDir = path.join(process.cwd(), "src");

  if (!fs.existsSync(srcDir)) {
    console.error(`Error: src directory not found at ${srcDir}`);
    process.exit(1);
  }

  const allTests = findTestFiles(srcDir);
  const unitTests = allTests.filter((f) => !isIntegrationTest(f));
  const integrationTests = allTests.filter((f) => isIntegrationTest(f));

  let testFiles: string[] = [];

  if (filter === "--unit") {
    testFiles = unitTests;
  } else if (filter === "--integration") {
    testFiles = integrationTests;
  } else if (filter === "--all") {
    testFiles = allTests;
  } else if (!filter) {
    // Default: return both unit and integration
    testFiles = allTests;
  } else {
    console.error(`Unknown filter: ${filter}. Use --unit, --integration, or --all`);
    process.exit(1);
  }

  // Output each file on a separate line
  for (const file of testFiles) {
    console.log(file);
  }

  // Exit with error if no tests found and integration tests requested
  if (testFiles.length === 0 && filter === "--integration") {
    process.exit(1);
  }
}

main();
