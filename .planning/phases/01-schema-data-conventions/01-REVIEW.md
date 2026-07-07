---
phase: 01-schema-data-conventions
reviewed: 2026-07-07T12:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - prisma/migrations/20260616152601_init/migration.sql
  - prisma/migrations/20260617121303_add_refresh_tokens/migration.sql
  - prisma/migrations/20260707094526_add_domain_schema/migration.sql
  - prisma/schema.prisma
  - src/plugins/auth.ts
  - src/routes/auth/index.ts
  - src/services/refresh-token.ts
  - src/services/user.ts
findings:
  critical: 0
  warning: 3
  info: 2
  total: 5
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-07-07T12:00:00Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Reviewed the schema/migration rewrite (User→users rename, BigInt widen, `deleted_at` addition, and the new additive domain-schema migration) plus the auth layer's bigint-safety changes.

**Migration safety (explicitly checked, no findings):** All three migration files were traced against their producing commits (`45cb1b6`, `99fccc0`, `9c0be44`). The rename+widen was hand-folded into the two originally-unpushed migrations as `CREATE TABLE ... users (id BIGINT NOT NULL AUTO_INCREMENT, ...)` — no `DROP TABLE`/`RENAME TABLE`/`ALTER` survives into the final file content, `AUTO_INCREMENT` and `NOT NULL` are correctly restated on every widened column, and the domain-schema migration is purely additive (`CREATE TABLE` × 10 + two `CREATE INDEX` statements, one of which closes a pre-existing, unrelated drift gap on `refresh_tokens.user_id` rather than introducing new risk). This part of the phase is sound.

**BigInt/Number boundary:** the `Number(user.id)` encoding at the JWT-sign and HTTP-response boundaries (and the corresponding `BigInt(request.user.id)` decode in `/me`) is a deliberate, explicitly-commented Phase-1 choice. It is not unsafe today (autoincrement ids are nowhere near `Number.MAX_SAFE_INTEGER`), but it is a silent-precision-loss point with no bounds check or thrown error if that assumption ever breaks — see WR-01.

Two further issues were found that are not new to this phase but live in the reviewed files: a non-atomic refresh-token rotation sequence (WR-02) and the newly-added `deleted_at` column never actually being consulted by any query, so it currently has no runtime effect (WR-03).

## Warnings

### WR-01: Silent precision loss (and possible user mix-up) at the BigInt↔Number JWT/HTTP boundary

**File:** `src/plugins/auth.ts:44`, `src/routes/auth/index.ts:72` (also 50, 65, 78, 102)
**Issue:** `Number(user.id)` is used to make the `bigint` Prisma id JSON/JWT-safe. `Number()` silently rounds any `bigint` beyond `2^53-1` (`Number.MAX_SAFE_INTEGER`) to the nearest representable double — it does not throw. The reverse conversion in `/me` (`BigInt(request.user.id)`) then queries by that rounded value. If two user ids ever land on the same rounded double (only possible once the `users` autoincrement sequence grows past ~9 quadrillion, so not an active risk today), `/me` would silently fetch and return a *different* user's `email`/`name` to the requesting session. The comment above the encode (`auth.ts:40-43`) correctly identifies this as a deferred, Phase-1-only shortcut, but there is currently no guard (e.g. asserting `user.id <= Number.MAX_SAFE_INTEGER` before encoding) that would fail loudly instead of silently, so the failure mode if the assumption is ever violated is data corruption, not an error.
**Fix:**
```ts
// auth.ts — fail loudly instead of silently truncating
if (user.id > BigInt(Number.MAX_SAFE_INTEGER)) {
  throw new Error(`user id ${user.id} exceeds safe JS integer range for JWT encoding`)
}
const accessToken = fastify.jwt.sign({ id: Number(user.id), email: user.email, name: user.name })
```

### WR-02: Refresh-token rotation is not atomic — a stolen/leaked token can be redeemed more than once

**File:** `src/routes/auth/index.ts:90-99`, `src/services/refresh-token.ts:25-49`
**Issue:** `/auth/refresh` calls `verifyRefreshToken(raw)` then, separately, `revokeRefreshToken(raw)`, then issues new tokens. Two concurrent requests presenting the same still-valid `raw` token can both pass `verifyRefreshToken` (neither has revoked it yet), and the route never checks `revokeRefreshToken`'s boolean return value (`result.count > 0`) before proceeding — so even though only one of the two `UPDATE ... WHERE revoked_at IS NULL` succeeds, *both* requests still call `generateTokens` and both get a fresh, fully valid token pair. This defeats the single-use/rotation invariant the DB schema (`revoked_at`, unique `token_hash`) was designed to enforce, and turns a single leaked refresh token into two live sessions instead of the intended "one wins, one is rejected."
**Fix:**
```ts
// routes/auth/index.ts
const user = await verifyRefreshToken(raw)
if (!user) { clearRefreshCookie(reply); throw fastify.httpErrors.unauthorized('...') }

const revoked = await revokeRefreshToken(raw)
if (!revoked) {
  // another concurrent request already redeemed this token — reject this one
  clearRefreshCookie(reply)
  throw fastify.httpErrors.unauthorized('Refresh token already used')
}

const { accessToken, refreshToken, expiresAt } = await fastify.generateTokens(user)
```

### WR-03: `deleted_at` is stored but never consulted — soft-deleting a user has no runtime effect

**File:** `src/services/user.ts:21-26`
**Issue:** This phase adds `deleted_at` to `users` (and to `houses`/`rooms`/`devices`) for soft delete (DATA-03), but `getUserById` (the only query in the reviewed auth-layer files that fetches a `User` row) does not filter on `deletedAt`. Nothing in the reviewed files ever sets or checks this column, so as implemented a soft-deleted user (however that eventually gets triggered) would still pass `/me` lookups and — since `loginUser`/`getUserById` in `src/services/auth.ts` and `user.ts` also don't filter on it — would still be able to log in. If enforcement is intentionally deferred to a later phase, worth confirming that's tracked; as it stands the column currently has zero behavioral effect.
**Fix:**
```ts
export async function getUserById(id: bigint) {
  return prisma.user.findUnique({
    where: { id, deletedAt: null },
    select: { id: true, email: true, name: true }
  })
}
```

## Info

### IN-01: `RefreshToken.user` relation has no `onDelete` behavior under `relationMode="prisma"`

**File:** `prisma/schema.prisma:28-39`
**Issue:** With `relationMode = "prisma"`, MariaDB enforces no real foreign key on `refresh_tokens.user_id`, and Prisma only emulates referential actions it's explicitly told about. No `onDelete` is specified on the `user` relation, so if/when a user-delete path is added, deleting a `users` row will leave orphaned `refresh_tokens` rows pointing at a nonexistent `user_id` (Prisma's emulation for an unspecified action typically just lets the delete through). No user-deletion endpoint exists yet, so this is low urgency, but worth deciding (`onDelete: Cascade` vs `Restrict`) before that feature is built rather than after.
**Fix:** Add an explicit referential action, e.g. `user User @relation(fields: [userId], references: [id], onDelete: Cascade)`.

### IN-02: `revokeRefreshToken`'s success/failure return value is discarded by both callers

**File:** `src/services/refresh-token.ts:42-49`, `src/routes/auth/index.ts:97, 111`
**Issue:** `revokeRefreshToken` returns `result.count > 0` specifically so callers can distinguish "revoked" from "was already revoked/didn't exist," but neither call site (`/auth/refresh` line 97, `/auth/logout` line 111) reads it. This is the concrete cause of WR-02 at the `/refresh` call site; at `/logout` it's harmless but still dead signal.
**Fix:** See WR-02's fix for `/refresh`; at minimum, log or branch on the return value rather than discarding it silently.

---

_Reviewed: 2026-07-07T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
