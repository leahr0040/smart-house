---
phase: 01-schema-data-conventions
fixed_at: 2026-07-08T14:24:50Z
review_path: .planning/phases/01-schema-data-conventions/01-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 4
skipped: 1
status: partial
---

# Phase 01: Code Review Fix Report

**Fixed at:** 2026-07-08T14:24:50Z
**Source review:** .planning/phases/01-schema-data-conventions/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope (critical + warning): 5
- Fixed: 4
- Skipped: 1

> Scope note: `fix_scope = critical_warning`. The review reported 0 critical and 5
> warning findings (WR-01…WR-05); Info findings (IN-01…IN-05) are out of scope and
> were not addressed.

> Verification note: the fixes were validated with a TypeScript **parse/syntax check**
> (via the compiler's `createSourceFile`), not a full project `tsc --noEmit` or test
> run, because the isolated review-fix worktree has no `node_modules` or generated
> Prisma client. WR-02 (authorization filter) and WR-01 (concurrency) are semantic
> fixes — the verifier phase should run `npm test` / `tsc --noEmit` in the main tree
> to confirm no type or behavioral regressions.

## Fixed Issues

### WR-01: Refresh-token rotation is not atomic — a leaked token can be redeemed more than once

**Files modified:** `src/routes/auth/index.ts`
**Commit:** e443d9d
**Applied fix:** `/auth/refresh` now captures the boolean return of the atomic
`revokeRefreshToken(raw)` (which runs `UPDATE ... WHERE revoked_at IS NULL`) and, when
it returns `false`, clears the refresh cookie and throws
`unauthorized('Refresh token already used')` before issuing any new tokens. Only the
single request whose revoke wins proceeds to `generateTokens`; concurrent redemptions of
the same token are rejected. This fix was completed by a prior interrupted run of this
agent; its worktree was recovered and the commit fast-forwarded onto the branch during
this session (see recovery note below).

### WR-02: Soft-delete (`deletedAt`) is not honored on any auth read

**Files modified:** `src/services/auth.ts`, `src/services/user.ts`, `src/services/refresh-token.ts`
**Commit:** e9ef148
**Applied fix:** Added `deletedAt`-awareness to every user-facing read:
- `loginUser` (`auth.ts`) — rejects with `null` when `user.deletedAt` is set
  (`if (!user || user.deletedAt) return null`).
- `getUserById` (`user.ts`) — filters the lookup with `where: { id, deletedAt: null }`
  (Prisma 7 extended `findUnique` where; verified supported by the project's Prisma
  version).
- `verifyRefreshToken` (`refresh-token.ts`) — added `|| stored.user.deletedAt` to the
  rejection condition so a token belonging to a soft-deleted user is treated as invalid.

Note: no soft-delete *write* path exists yet, so this is currently latent-but-correct —
it closes the authorization gap the moment a deactivation path is introduced.

### WR-03: Silent precision loss at the BigInt→Number JWT/HTTP boundary — no guard

**Files modified:** `src/plugins/auth.ts`
**Commit:** 95bf3f1
**Applied fix:** Added an assertion at the JWT encode boundary inside `generateTokens`,
immediately before `Number(user.id)` is signed into the token:
`if (user.id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(...)`. This fails loudly
rather than silently rounding an out-of-range id into a token for the wrong user.
Per coordinator direction, scope was limited to the encode boundary (option 1 in the
review's Fix); the response-body `Number(user.id)` conversions in
`src/routes/auth/index.ts` (a non-security display path) were intentionally left
untouched.

### WR-04: No length validation on `email`/`name` — oversized input becomes a 500

**Files modified:** `src/routes/auth/schemas.ts`
**Commit:** eb02941
**Applied fix:** Added `maxLength: 191` to `email` and `name` in `registerRouteSchema`
and to `email` in `loginRouteSchema`, matching the `VARCHAR(191)` column bounds. Oversized
input now fails JSON-schema validation with a 400 instead of reaching Prisma and surfacing
as a 500.

## Skipped Issues

### WR-05: `email` unique + soft delete permanently blocks re-registration after deletion

**File:** `prisma/schema.prisma:17`, `prisma/migrations/20260616152601_init/migration.sql:11`
**Reason:** skipped — requires a human architecture/convention decision, not a mechanical
fix. The review's Fix explicitly asks to *decide and encode* one of several mutually
exclusive semantics (hard-delete users; scrub/rename `email` on soft-delete; or move to an
application-enforced "unique among non-deleted" check) and document it. Each choice has
different data-model and behavioral trade-offs and also governs `public_id` uniqueness on
the domain tables. The project's CLAUDE.md working style mandates proposing an architecture
plan and waiting for approval before implementing such a decision, so the fixer did not pick
one unilaterally. Recommend resolving this as an explicit conventions decision (and
documenting it alongside the `deletedAt` convention) before domain endpoints that soft-delete
users are built.
**Original issue:** `users.email` carries a plain `@unique` while the model has a
`deletedAt` soft-delete column, so a soft-deleted row's email permanently blocks
re-registration of that address without a hard delete; the same pattern applies to
`public_id` uniqueness on the domain tables.

## Recovery note

A prior run of this agent was interrupted after committing the WR-01 fix but before its
worktree cleanup could run, leaving an orphan worktree
(`sv-01-reviewfix-F6fQWd` on branch `gsd-reviewfix/01-14104`) and a
`.review-fix-recovery-pending.json` sentinel. This session detected the sentinel,
fast-forwarded `feat/initial-setup` to capture the valid WR-01 commit (`e443d9d`), removed
the orphan worktree and branch, cleared the stale sentinel, then started a fresh isolated
worktree for WR-02…WR-05. No work was lost or duplicated.

---

_Fixed: 2026-07-08T14:24:50Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
