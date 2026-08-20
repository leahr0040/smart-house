---
phase: 01-schema-data-conventions
reviewed: 2026-07-07T11:01:44Z
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
  warning: 5
  info: 5
  total: 10
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-07-07T11:01:44Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Reviewed the schema/migration work (User→users rename, BigInt widen, `deleted_at`
addition, and the new additive domain-schema migration) plus the auth surfaces that
touch the reviewed files. TypeScript compiles cleanly (`tsc --noEmit` is green — the
`FastifyReply` reference in `auth.ts:11` resolves via declaration merging inside
`declare module 'fastify'`), and `@fastify/cookie` is correctly registered in `app.ts`,
so the cookie API used by the auth routes is valid at runtime.

**Migration safety (explicitly checked, no findings):** All three migration files are
internally consistent and the domain-schema migration is purely additive
(`CREATE TABLE` × 10 + two `CREATE INDEX`, one of which closes a pre-existing drift gap
on `refresh_tokens.user_id` rather than introducing new risk). No destructive
`DROP`/`RENAME`/`ALTER` survives into the final SQL; `AUTO_INCREMENT`/`NOT NULL` are
restated on every widened column. This part of the phase is sound.

No BLOCKER-severity defect was proven — the code is fairly clean. The warnings below are
correctness and convention gaps that this phase *establishes the substrate for*: the
newly formalized soft-delete (`deletedAt`) and single-use refresh-token conventions are
not yet honored by the code that reads those rows, and will silently misbehave the
moment a soft-delete write path or a concurrent refresh exists. They should be closed
before the domain endpoints that depend on them are built.

No `structural_findings` block was supplied, so this report is entirely narrative.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: Refresh-token rotation is not atomic — a leaked token can be redeemed more than once

**File:** `src/routes/auth/index.ts:90-100`, `src/services/refresh-token.ts:25-49`
**Issue:** `/auth/refresh` calls `verifyRefreshToken(raw)` and then, as a separate step,
`revokeRefreshToken(raw)`, then issues new tokens. Two concurrent requests presenting the
same still-valid `raw` can both pass `verifyRefreshToken` before either revokes, and the
route never checks `revokeRefreshToken`'s boolean return before proceeding — so although
only one atomic `UPDATE ... WHERE revoked_at IS NULL` succeeds, *both* requests still call
`generateTokens` and both receive a fully valid token pair. This defeats the single-use /
rotation invariant the schema (`revoked_at`, unique `token_hash`) was designed to enforce
and turns one leaked refresh token into two live sessions instead of "one wins, one is
rejected."
**Fix:** Gate the issue on the atomic revoke:
```ts
const user = await verifyRefreshToken(raw)
if (!user) { clearRefreshCookie(reply); throw fastify.httpErrors.unauthorized('Invalid or expired refresh token') }

const revoked = await revokeRefreshToken(raw)   // atomic: WHERE revoked_at IS NULL
if (!revoked) {
  clearRefreshCookie(reply)
  throw fastify.httpErrors.unauthorized('Refresh token already used')
}
const { accessToken, refreshToken, expiresAt } = await fastify.generateTokens(user)
```

### WR-02: Soft-delete (`deletedAt`) is not honored on any auth read

**File:** `src/services/auth.ts:9-24`, `src/services/user.ts:21-26`, `src/services/refresh-token.ts:30-39`
**Issue:** This phase formalizes `deleted_at` as the soft-delete column across the model,
but `loginUser`, `getUserById`, and `verifyRefreshToken` all query users with no
`deletedAt: null` filter. Nothing in the reviewed files sets or checks the column, so it
currently has zero behavioral effect — and the moment a deactivation path exists, a
soft-deleted user will still be able to log in, refresh, and resolve `/auth/me`. This is a
latent authorization gap baked in at the convention-setting layer.
**Fix:** Add the filter to every user-facing read now:
```ts
// getUserById
where: { id, deletedAt: null }
// loginUser: after findUnique, `if (!user || user.deletedAt) return null`
// verifyRefreshToken: reject when stored.user.deletedAt is set
```

### WR-03: Silent precision loss at the BigInt→Number JWT/HTTP boundary — no guard

**File:** `src/plugins/auth.ts:44`, `src/routes/auth/index.ts:72` (also 50, 65, 78, 102)
**Issue:** `Number(user.id)` makes the `bigint` id JSON/JWT-safe but silently rounds any
value beyond `2^53-1` — it does not throw. `/me` then decodes via `BigInt(request.user.id)`
and queries by the rounded value. The encode is a deliberate, commented Phase-1 shortcut
and is not an active risk (autoincrement ids are nowhere near the limit), but there is no
guard that fails loudly if the assumption ever breaks, so the failure mode would be silent
user mix-up rather than an error.
**Fix:** Assert the safe range at the encode boundary:
```ts
if (user.id > BigInt(Number.MAX_SAFE_INTEGER)) {
  throw new Error(`user id ${user.id} exceeds safe JS integer range for JWT encoding`)
}
```

### WR-04: No length validation on `email`/`name` — oversized input becomes a 500

**File:** `src/routes/auth/schemas.ts:29-56`
**Issue:** `email` and `name` have no `maxLength`, but the columns are `VARCHAR(191)`
(`20260616152601_init/migration.sql:4-6`). Input longer than 191 chars passes JSON-schema
validation, reaches Prisma, and fails at the database, surfacing through the global error
handler as a 500 instead of a 400. Client input should never produce a 5xx.
**Fix:** Add `maxLength: 191` to `email` and `name` in `registerRouteSchema` (and `email`
in `loginRouteSchema`), keeping schema and column bounds in sync.

### WR-05: `email` unique + soft delete permanently blocks re-registration after deletion

**File:** `prisma/schema.prisma:17`, `prisma/migrations/20260616152601_init/migration.sql:11`
**Issue:** `users.email` carries a plain `@unique` while the model also has a `deletedAt`
soft-delete column. Once a user is soft-deleted, the row (and its email) remain, and the
unique index permanently blocks re-registering that address without a hard delete. The
same pattern applies to `public_id` uniqueness on the domain tables. This is a convention
decision worth making explicitly during the conventions phase rather than discovering later.
**Fix:** Decide and encode the semantics: hard-delete users, scrub/rename `email` on
soft-delete, or move to an application-enforced "unique among non-deleted" check. Document
it alongside the `deletedAt` convention.

## Info

### IN-01: bcrypt silently truncates passwords beyond 72 bytes

**File:** `src/services/user.ts:11`, `src/routes/auth/schemas.ts:35`
**Issue:** `bcrypt.hash` uses only the first 72 bytes. With no `maxLength` on the register
schema, two distinct long passwords sharing a 72-byte prefix authenticate interchangeably,
silently.
**Fix:** Add `maxLength: 72` to the register `password` schema (or pre-hash with SHA-256 if
longer passwords must be supported).

### IN-02: Cookie `secure: true` is hardcoded regardless of environment

**File:** `src/routes/auth/index.ts:23`
**Issue:** `setRefreshCookie` always sets `secure: true`. Correct for production, but a
non-localhost dev server over plain HTTP will silently fail to store the refresh cookie,
breaking the refresh flow during local testing.
**Fix:** Gate on environment, e.g. `secure: env.NODE_ENV === 'production'`, defaulting to
`true`.

### IN-03: FK columns have no relations/referential actions under `relationMode="prisma"`

**File:** `prisma/schema.prisma:28-39` (RefreshToken), `41-190` (domain models)
**Issue:** With `relationMode = "prisma"` there are no real DB foreign keys and Prisma only
emulates referential actions it is told about. `RefreshToken.user` declares no `onDelete`,
and the domain models (House, Room, Device, Command, CommandTarget, state tables, Event)
intentionally carry raw `userId`/`houseId`/`roomId`/`deviceId` columns with no `@relation`
at all. When any hard-delete path is added, parents can be deleted leaving orphaned children
with dangling ids and no DB-level protection. Consistent with the documented denormalized/
morph design; noting it so the delete policy is decided deliberately.
**Fix:** Add an explicit `onDelete` to `RefreshToken.user` (e.g. `Cascade`), and confirm the
domain entities are soft-delete-only with app-level cascade handling documented.

### IN-04: `revokeRefreshToken`'s return value is discarded at `/logout`

**File:** `src/services/refresh-token.ts:42-49`, `src/routes/auth/index.ts:111`
**Issue:** `revokeRefreshToken` returns `result.count > 0` so callers can distinguish
"revoked" from "already revoked/absent," but `/logout` ignores it (the `/refresh` call site
is covered by WR-01). Harmless at logout, but a discarded signal.
**Fix:** Branch on or log the return value rather than discarding it.

### IN-05: Auth schemas still raw JSON Schema `as const`, not TypeBox

**File:** `src/routes/auth/schemas.ts:1-74`, `src/routes/auth/index.ts:8-17`
**Issue:** CLAUDE.md / PLAN rule 1.5 sets TypeBox (`Static<typeof schema>`) as the standard
and says to migrate the legacy auth schemas "when touched." This phase touches the auth
surface; the schemas remain hand-written JSON Schema with separate `RegisterBody`/`LoginBody`
aliases in `index.ts`, leaving two parallel sources of truth that can drift.
**Fix:** Migrate to TypeBox and derive the body types via `Static<typeof ...>`.

---

_Reviewed: 2026-07-07T11:01:44Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
