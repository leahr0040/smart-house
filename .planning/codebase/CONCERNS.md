# Codebase Concerns

**Analysis Date:** 2026-06-25

## Tech Debt

**TypeBox Schema Migration:**
- Issue: `src/routes/auth/schemas.ts` uses hand-written `as const` JSON Schema with separate TypeScript type aliases instead of TypeBox. PLAN.md Rule 1.5 explicitly requires TypeBox for all new schemas so types derive from the schema, not parallel hand-written definitions.
- Files: `src/routes/auth/schemas.ts`, `src/routes/auth/index.ts` (contains type aliases `RegisterBody`, `LoginBody`)
- Impact: Type safety contracts are harder to maintain; runtime validation and static types can drift
- Fix approach: Migrate auth schemas to TypeBox, derive `Static<typeof schema>` types, remove parallel type aliases

**Empty Placeholder File:**
- Issue: `code.ts` exists at repo root but is empty and serves no purpose
- Files: `code.ts`
- Impact: Clutters repository; suggests incomplete scaffolding cleanup
- Fix approach: Delete `code.ts`

---

## Security Considerations

**Weak Password Requirements:**
- Risk: Minimum password length is 6 characters with no complexity rules (uppercase, numbers, symbols, etc.)
- Files: `src/routes/auth/schemas.ts` line 35 (`minLength: 6`)
- Current mitigation: bcrypt hashing with cost factor 10 prevents offline cracking speed advantage
- Recommendations: Increase minimum to 12 characters; add complexity validation (at least one uppercase, number, symbol); consider rate-limiting failed login attempts

**Secure Cookie Flag in Development:**
- Risk: `secure: true` flag in `src/routes/auth/index.ts` line 23 requires HTTPS; will silently fail to set cookie in development on `http://localhost`. Developers may bypass by removing the flag without realizing the security impact.
- Files: `src/routes/auth/index.ts` lines 20–27 (setRefreshCookie function)
- Current mitigation: Cookie flags are otherwise secure (httpOnly, sameSite: strict)
- Recommendations: Add environment-aware logic to disable `secure` flag only in development (check `process.env.NODE_ENV`); document this behavior in CLAUDE.md

**No Rate Limiting on Auth Endpoints:**
- Risk: Register, login, and refresh endpoints have no rate-limiting. An attacker can brute-force passwords or enumerate valid email addresses.
- Files: `src/routes/auth/index.ts` lines 34–103 (all auth endpoints)
- Current mitigation: None
- Recommendations: Implement rate-limiting per IP address or per email for login/register; consider exponential backoff or CAPTCHA

**Token Not Validated Before Use in Refresh:**
- Risk: `src/routes/auth/index.ts` line 84 retrieves `request.cookies.refreshToken` without validating it is a 40-byte hex string. Malformed tokens are passed directly to `verifyRefreshToken()`, which then hashes whatever is provided.
- Files: `src/routes/auth/index.ts` line 84
- Current mitigation: SHA-256 hash of malformed token will not match any stored hash, so verification fails safely
- Recommendations: Add explicit format validation before hashing (regex: `^[a-f0-9]{80}$`)

**Prisma Client Not Disconnected on Shutdown:**
- Risk: `src/server.ts` starts the Fastify server but does not register a graceful shutdown handler to disconnect the Prisma client. Long-running connections may leak.
- Files: `src/server.ts`, `src/lib/prisma.ts`
- Current mitigation: None
- Recommendations: Add `fastify.addHook('onClose', async () => { await prisma.$disconnect() })` in the app plugin or server startup

---

## Test Coverage Gaps

**No Auth Endpoint Tests:**
- What's not tested: Register, login, refresh token rotation, logout, and the /me endpoint all lack test coverage
- Files: `src/routes/auth/index.ts`; test directory: `src/test/`
- Risk: Regression bugs in authentication (the security-critical path) go undetected. Token rotation logic, cookie handling, and error cases are untested.
- Priority: High

**No Service Layer Tests:**
- What's not tested: `loginUser()` bcrypt verification, `createUser()` hashing, `verifyRefreshToken()` expiry logic, `revokeRefreshToken()` single-use enforcement
- Files: `src/services/auth.ts`, `src/services/user.ts`, `src/services/refresh-token.ts`
- Risk: Core business logic has no contract verification. Changes to bcrypt cost, token hashing, or expiry checks may break without detection.
- Priority: High

**Only One Test File:**
- What's not tested: Only `src/test/routes/root.test.ts` exists, which tests only the trivial root route. Zero coverage for the actual application logic.
- Files: `src/test/routes/` (only root.test.ts; no auth.test.ts or service tests)
- Risk: High risk of silent failures in a security-sensitive application
- Priority: High

**No Error Case Tests:**
- What's not tested: Invalid email format, duplicate email on register, password mismatch on login, expired or revoked tokens, missing cookies
- Files: `src/routes/auth/index.ts` (error handling paths)
- Risk: Error handling (status codes, response shapes, state mutations) is not verified
- Priority: Medium

---

## Fragile Areas

**Auth Plugin Decorator Order Assumption:**
- Files: `src/plugins/auth.ts` lines 34–43
- Why fragile: `authenticate` decorator calls `request.jwtVerify()` on the assumption that `@fastify/jwt` has already been registered. If plugin load order changes or jwt registration fails, decorator will crash at runtime.
- Safe modification: Add defensive checks; ensure jwt registration is explicit in tests
- Test coverage: Plugin must be tested in isolation to verify jwt decorator is registered

**Refresh Token Single-Use Enforcement:**
- Files: `src/services/refresh-token.ts` line 44-48 (revokeRefreshToken uses `updateMany` with `revokedAt: null`)
- Why fragile: If `revokeRefreshToken()` is called concurrently with `verifyRefreshToken()` for the same token, both operations might succeed (race condition), issuing two valid token pairs from one refresh call. No database-level locking prevents this.
- Safe modification: Use Prisma transactions: `await prisma.$transaction(async (tx) => { const token = await tx.refreshToken.findUnique(...); if (!token || token.revokedAt) throw; await tx.refreshToken.update(...) })`
- Test coverage: Must test concurrent refresh attempts with same token

**Cookie-Based Refresh Token in Routes:**
- Files: `src/routes/auth/index.ts` lines 20–32, 84, 108
- Why fragile: Routes directly access `request.cookies.refreshToken`. If cookie parsing fails or middleware chain changes, the token source becomes unreliable. The pattern couples the route to Fastify's cookie plugin.
- Safe modification: Add a dedicated service function `getRefreshTokenFromRequest(request)` that extracts and validates the token; this decouples the route from cookie implementation details
- Test coverage: Test with missing cookie, malformed cookie, and cookie over size limit

**Prisma Singleton Without Lifecycle Management:**
- Files: `src/lib/prisma.ts`
- Why fragile: Single `prisma` instance is exported and imported everywhere. No connection pool size tuning, timeout configuration, or graceful disconnection on process shutdown.
- Safe modification: Wrap prisma instance in a manager that handles initialization, pooling config, and cleanup hooks
- Test coverage: Integration tests should verify reconnection on connection loss

---

## Missing Critical Features

**No Authorization Checks:**
- Problem: Endpoints have no ownership verification. A user can call `GET /me` for any user ID (if such routes existed) without checking that the caller owns that resource.
- Blocks: Phase 1 (House/Room/Device CRUD) cannot ship without authorization middleware
- Recommendation: Design and implement authorization context in the auth plugin (e.g., `request.user.id` populated by JWT, used to check ownership before operations)

**No Email Verification:**
- Problem: A user can register with a typo'd or fake email. No confirmation flow or validation that the email is reachable.
- Blocks: Phase 1 onboarding experience; password reset flows
- Recommendation: Add email verification token flow (similar to refresh tokens) with expiry

**No Password Reset:**
- Problem: Users cannot recover a forgotten password; they are locked out.
- Blocks: Production readiness
- Recommendation: Implement password reset via secure time-limited tokens sent to email

---

## Dependencies at Risk

**No TypeBox Dependency Installed:**
- Risk: PLAN.md Rule 1.5 mandates TypeBox for all schemas, but `package.json` does not list `typeboxjs` or `@sinclair/typebox` as a dependency.
- Impact: Cannot migrate auth schemas to TypeBox without adding the dependency
- Migration plan: Run `npm install @sinclair/typebox`; update all schema definitions; verify Fastify integration

---

## Architectural Gaps

**No Validation Middleware:**
- Problem: Request bodies rely on Fastify's schema validation alone. No custom validators for business logic (e.g., email uniqueness at schema definition time, password strength).
- Impact: Validation errors are generic JSON Schema messages, not business-domain errors
- Improvement: Create a validation layer in services or schemas that returns detailed, client-friendly error messages

**No Input Sanitization:**
- Problem: User names and emails are stored as-is. No trimming, lowercasing, or sanitization of whitespace or special characters.
- Impact: Duplicate accounts for `user@example.com` vs `user@example.com ` (trailing space); display inconsistencies
- Improvement: Add sanitization to `createUser()` and normalize email input (lowercasing, trimming)

**No Logging Context:**
- Problem: `src/plugins/error-handler.ts` logs all errors via `this.log.error(error)` but does not include request context (user ID, endpoint, request ID). Impossible to trace errors back to user actions.
- Impact: Production debugging is hampered; cannot correlate errors with user reports
- Improvement: Use Fastify request hooks to attach a `requestId` to all logs; include user context if authenticated

---

## Performance Considerations

**No Database Query Optimization:**
- Problem: No indexes defined beyond the `userId` index on `RefreshToken`. If queries grow (e.g., "find all tokens for user X"), full table scans are inevitable.
- Files: `prisma/schema.prisma`
- Improvement: Add indexes for `User.email` (already unique), `RefreshToken.expiresAt` (for cleanup queries), consider partial indexes for non-revoked tokens

**No Connection Pool Tuning:**
- Problem: `src/lib/prisma.ts` does not configure pool size, timeout, or connection acquisition strategy. Default MySQL adapter settings may exhaust connections under load.
- Files: `src/lib/prisma.ts`
- Improvement: Define pool config in PrismaClient constructor; load pool size from environment variables

---

## Implementation Debt Summary

| Area | Severity | Effort | Blocks |
|------|----------|--------|--------|
| TypeBox schema migration | Medium | 2–3 hours | None (tech debt) |
| Add auth endpoint tests | High | 4–6 hours | None (quality gate) |
| Implement rate-limiting | High | 2–3 hours | Production |
| Fix secure cookie dev detection | Medium | 30 min | Development workflow |
| Add email verification | High | 6–8 hours | Phase 1 onboarding |
| Add password reset flow | High | 6–8 hours | Production |
| Implement authorization context | High | 4–6 hours | Phase 1 entity access |
| Graceful Prisma shutdown | Medium | 30 min | Deployment robustness |

---

*Concerns audit: 2026-06-25*
