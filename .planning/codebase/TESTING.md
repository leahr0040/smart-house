# Testing Patterns

**Analysis Date:** 2026-06-25

## Test Framework

**Runner:**
- Node.js built-in `node:test` module (no external test runner)
- Version: Node.js ES2020+ (TypeScript compiled to CommonJS)
- Config: `tsconfig.json` includes test files via `"include": ["src/**/*", "test/**/*"]`

**Assertion Library:**
- Node.js built-in `node:assert` module (no external assertion library)
- Usage: `assert.deepStrictEqual()`, standard Node.js assert API

**Run Commands:**
```bash
npm run build         # Compile TypeScript to dist/
npm test              # Build (tsc) then run all tests with: node --test dist/src/test/**/*.test.js
npm run dev           # Start dev server (for manual testing)
```

**Test Compilation:**
- Tests are TypeScript (`.ts` files) in `src/test/`
- Compiled to JavaScript (`.js` files) in `dist/src/test/` via `tsc`
- Test runner points to compiled JavaScript: `node --test dist/src/test/**/*.test.js`

## Test File Organization

**Location:**
- Co-located with source: `src/test/` mirrors application structure
- Example: `src/test/routes/root.test.ts` tests `src/routes/root.ts`
- Helper utilities in `src/test/helper.ts`

**Naming:**
- Pattern: `{name}.test.ts` for test files
- Example: `root.test.ts`, auth tests would be at `src/test/routes/auth.test.ts` (not yet created)

**Structure:**
```
src/test/
├── helper.ts                    # Fastify build helper
└── routes/
    └── root.test.ts             # Tests for src/routes/root.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { test } from 'node:test'
import assert from 'node:assert'
import { build } from '../helper'

test('default root route', async (t) => {
  const app = await build(t)
  
  const res = await app.inject({
    url: '/'
  })
  assert.deepStrictEqual(JSON.parse(res.payload), { root: true })
})
```

**Patterns:**
- Single `test()` function per test case
- Test function is async and receives `t` parameter (test context)
- `t.after()` used for teardown (registered via `build()` helper)
- No nested suites (top-level tests only)

**Setup Pattern:**
```typescript
const app = await build(t)  // Builds full Fastify instance with all plugins/routes
t.after(() => app.close()) // Automatically called after test completes
```

**Teardown Pattern:**
- Registered inside `build()` helper via `t.after(())`
- Fastify instance closed automatically between tests

**Assertion Pattern:**
- `assert.deepStrictEqual(actual, expected)` for JSON payload verification
- `JSON.parse(res.payload)` to parse HTTP response body
- Node.js assert module provides `strictEqual`, `equal`, `throws`, etc.

## Build Helper

**Location:** `src/test/helper.ts`

**Purpose:** Factory function that creates a fresh Fastify instance for each test with automatic teardown

**Implementation:**
```typescript
async function build(t: { after: (fn: () => void) => void }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(appPlugin)
  t.after(() => app.close())
  return app
}
```

**Key Details:**
- Accepts test context `t` with `after()` method for cleanup registration
- Creates Fastify with `logger: false` to suppress logs during testing
- Registers `appPlugin` (from `app.ts`) which loads all plugins and routes
- Returns full app instance ready for `app.inject()` calls
- Cleanup hook ensures database connections close between tests

## Mocking

**Framework:** No mocking framework currently used (Jest/Sinon not in devDependencies)

**Current State:**
- Tests use real Fastify instance
- Tests use real database (Prisma) — no mocking layer
- All plugins (auth, error handler, sensible) are real
- HTTP requests via `app.inject()` — no external HTTP calls mocked

**Patterns Not Yet Implemented:**
- No Prisma query mocking
- No cryptographic function mocking (`bcrypt`, `crypto`)
- No environment variable override mechanism in tests

**What to Mock (Guidance for Future Tests):**
- Database queries that are slow or have side effects (long-running operations)
- External APIs (if added later)
- Time-dependent operations (token expiration, timestamps)

**What NOT to Mock (Guidance for Future Tests):**
- Fastify instance or routing
- bcrypt password hashing (verify real behavior)
- JWT signing/verification (verify real token integrity)
- Error handler behavior (test real error mapping)
- Prisma client basics (too foundational; test against real schema)

## Fixtures and Factories

**Test Data:**
- Not yet implemented in codebase
- Current test (`root.test.ts`) requires no fixture data

**Recommended Pattern for Future Tests:**
```typescript
// Suggested location: src/test/fixtures/
const testUser = {
  email: 'test@example.com',
  password: 'testPassword123'
}

async function createTestUser(app: FastifyInstance) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: testUser
  })
  return JSON.parse(res.payload)
}
```

**Location:**
- Fixtures would belong in `src/test/fixtures/` (not yet created)
- Factory functions in helper files or inline in test files

## Coverage

**Requirements:** No coverage requirement configured

**View Coverage:**
- Not configured in package.json
- Would need to add Istanbul/c8 to devDependencies
- Command would be something like: `npm run test -- --coverage` (not implemented)

## Test Types

**Unit Tests:**
- **Scope:** Individual route handlers, service functions, utility functions
- **Approach:** Use `app.inject()` to call route handlers; capture response and assertions
- **Example:** `root.test.ts` verifies GET / returns `{ root: true }`
- **Database:** Real Prisma queries run; no test database isolation yet
- **Current Coverage:** Only root route tested

**Integration Tests:**
- **Scope:** Multi-endpoint flows (e.g., register → login → refresh → logout)
- **Approach:** Same as unit tests via `app.inject()`; chain multiple requests
- **Not Yet Implemented:** No auth flow tests, no token rotation tests
- **Database:** Real database required; need test DB cleanup between tests

**E2E Tests:**
- **Framework:** Not used (tests use in-process `app.inject()`, not external HTTP)
- **Approach:** Could add end-to-end via actual HTTP (npm start + curl) but not configured

## Common Patterns

**Async Testing:**
```typescript
test('route name', async (t) => {
  const app = await build(t)
  
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: '...', password: '...' }
  })
  
  assert.strictEqual(res.statusCode, 200)
})
```

**Payload Parsing:**
```typescript
const data = JSON.parse(res.payload)
assert.deepStrictEqual(data, { expectedKey: 'expectedValue' })
```

**Status Code Assertion:**
```typescript
assert.strictEqual(res.statusCode, 200)  // Success
assert.strictEqual(res.statusCode, 401)  // Unauthorized
assert.strictEqual(res.statusCode, 409)  // Conflict
```

**Error Testing (Not Yet Implemented Example):**
```typescript
test('login with invalid credentials returns 401', async (t) => {
  const app = await build(t)
  
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'test@example.com', password: 'wrong' }
  })
  
  assert.strictEqual(res.statusCode, 401)
  const data = JSON.parse(res.payload)
  assert.strictEqual(data.message, 'Invalid credentials')
})
```

## Recommended Testing Roadmap

**Missing Test Coverage (High Priority):**
1. **Auth Registration:** Test successful registration, duplicate email conflict, validation errors
2. **Auth Login:** Test successful login, invalid credentials, user not found
3. **Auth Refresh:** Test token rotation, expired tokens, invalid refresh token
4. **Auth Logout:** Test refresh token revocation, cookie clearing
5. **Protected Route:** Test `/me` with valid token, expired token, no token

**Test Database Strategy:**
- Current: Tests run against real MariaDB
- Recommendation: Add transaction rollback between tests OR separate test database
- Prisma provides transaction API: wrap each test in `prisma.$transaction()` with rollback

**Mocking Strategy (Future):**
- Add `jest-mock-extended` or `sinon` if mocking becomes necessary
- Focus on performance-critical paths (crypto operations, external APIs)
- Keep Fastify/Prisma real for integrity testing

---

*Testing analysis: 2026-06-25*
