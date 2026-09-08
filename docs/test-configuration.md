<!-- Test Suite: Single-Production-VPS Safe Configuration -->

# Test Suite Safe for Single-Production-VPS Environment

This repository has been configured to support safe testing on a single production VPS with one production database.

## Overview

The test suite is split into two categories:

- **Unit Tests**: Run without database requirements (default `npm test`)
- **Integration Tests**: Run only when explicitly configured with `TEST_DATABASE_URL` (run with `npm run test:integration`)

This ensures that:
1. Default test runs never require a separate database
2. PostgreSQL integration tests cannot accidentally use the production database
3. Test discovery works reliably on all platforms (including Linux)
4. Safe cleanup happens even if test setup fails

## Running Tests

### Run Unit Tests (No Database Required)
```bash
npm test
```

This runs all unit tests, type checking, and discovery tests without requiring PostgreSQL:
- CSRF token service
- Request body limits
- Vehicle management (non-database)
- Route authorization
- Test discovery verification
- Database safety verification

### Run PostgreSQL Integration Tests
```bash
TEST_DATABASE_URL='postgresql://localhost/ridematrix_test' npm run test:integration
```

Replace `postgresql://localhost/ridematrix_test` with your test database connection string.

PostgreSQL integration tests include:
- Customer management
- Staff user management
- Booking imports
- Demo data seeding
- Database migrations
- CSRF protection on routes

### Run All Tests
```bash
TEST_DATABASE_URL='postgresql://localhost/ridematrix_test' npm run test:all
```

### Type Checking
```bash
npm run typecheck
```

### Build
```bash
npm run build
```

## How It Works

### Test Discovery (`src/test-discover.ts`)

A Node.js test discovery script reliably finds test files across all platforms:

- **Unit tests**: Files that don't import from `test-helper.ts` or use `createTestDatabaseContext`
- **Integration tests**: Files that import database test helpers

This replaces the glob pattern `"src/**/*.test.ts"` which doesn't work reliably on Linux.

### Test Runner (`src/test-run.ts`)

A thin wrapper around Node's test runner that:
1. Uses the discovery script to find test files
2. Runs them with `node --import tsx --test --concurrency=1`
3. Gracefully handles missing `TEST_DATABASE_URL` for integration tests

### Database Safety (`src/database/test-helper.ts`)

#### `getBaseTestDatabaseUrl()`

**REQUIRES explicit `TEST_DATABASE_URL`** environment variable.

Throws a clear error if not set:
```
PostgreSQL integration tests require TEST_DATABASE_URL to be explicitly set.
This prevents accidental use of the production DATABASE_URL.
Set TEST_DATABASE_URL to a test-only PostgreSQL connection string and try again.
Example: TEST_DATABASE_URL='postgresql://localhost/ridematrix_test' npm run test:integration
```

**Never falls back to `DATABASE_URL`.**

#### `safeCleanupTestDatabase(dbContext)`

Safe cleanup helper for integration tests:
- Works even if `dbContext` is undefined (setup failed)
- Prevents errors like "Cannot read properties of undefined (reading cleanup)"
- Used in all integration test `after()` hooks

```typescript
let dbContext: TestDatabaseContext | undefined;

before(async () => {
  dbContext = await createTestDatabaseContext("test_name");
});

after(async () => {
  await safeCleanupTestDatabase(dbContext); // Safe even if setup failed
});
```

## Production Safety

✓ Production `DATABASE_URL` is never used as a test fallback  
✓ Production database is never modified during tests  
✓ Production migrations are never run against test databases  
✓ `npm test` requires no database setup  
✓ Integration tests must explicitly opt-in with `TEST_DATABASE_URL`

## Test Configuration

### Files

- **Test Discovery**: `src/test-discover.ts`
- **Test Runner**: `src/test-run.ts`
- **Database Safety**: `src/database/test-helper.ts`
- **Safety Tests**: `src/test-discovery.test.ts`

### Environment Variables

- `TEST_DATABASE_URL`: Required for integration tests (e.g., `postgresql://localhost/ridematrix_test`)
- `DATABASE_URL`: Production database (unchanged, never used for tests)
- `NODE_ENV`: Application environment (`production`, `development`, etc.)

### NPM Scripts

```json
{
  "test": "tsc --noEmit -p tsconfig.test.json && tsx src/test-run.ts --unit",
  "test:integration": "tsc --noEmit -p tsconfig.test.json && tsx src/test-run.ts --integration",
  "test:all": "tsc --noEmit -p tsconfig.test.json && tsx src/test-run.ts --all"
}
```

## Safety Verification

The test suite includes verification tests in `src/test-discovery.test.ts`:

- Discovery script identifies unit tests correctly
- Discovery script identifies integration tests correctly
- `getBaseTestDatabaseUrl()` throws when `TEST_DATABASE_URL` is missing
- `safeCleanupTestDatabase()` handles undefined contexts gracefully
- Test runner script exists and is executable
- Discovery script rejects invalid filters

Run `npm test` to verify all safety measures are in place.

## Troubleshooting

### Integration tests fail with "PostgreSQL integration tests require TEST_DATABASE_URL"

This is expected behavior when `TEST_DATABASE_URL` is not set. To enable integration tests:

```bash
TEST_DATABASE_URL='postgresql://localhost/ridematrix_test' npm run test:integration
```

### Integration tests fail with "Cannot read properties of undefined (reading cleanup)"

This shouldn't happen - all integration tests use `safeCleanupTestDatabase()`. If you see this error, please check that the test file has been updated to use the safe cleanup helper.

### Test discovery finds wrong test files

The discovery script checks for:
- Import from `../database/test-helper` or `../../database/test-helper`
- Usage of `TestDatabaseContext` type
- Usage of `createTestDatabaseContext()` function
- Import of `initializeDatabase` from connection

If your test should be categorized differently, ensure it matches or doesn't match these patterns.

## See Also

- [CSRF Protection](./csrf-protection.md)
- [Customer Persistence](./customer-persistence.md)
