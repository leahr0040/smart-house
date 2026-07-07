---
phase: 01-schema-data-conventions
plan: 01
subsystem: database
tags: [prisma, mariadb, migrations, jwt, bigint]

# Dependency graph
requires: []
provides:
  - "users table (renamed from User) with deleted_at soft-delete column"
  - "Uniform BigInt PKs/FKs across users.id, refresh_tokens.id, refresh_tokens.user_id"
  - "Bigint-safe auth layer (Prisma boundary bigint, JWT/HTTP response Number-encoded)"
affects: [01-02, phase-02]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "snake_case DB naming via @@map/@map, including on brownfield models"
    - "BigInt @default(autoincrement()) internal PK convention"
    - "bigint at the Prisma boundary, Number(...) at JWT/HTTP-response boundaries to keep responses JSON-safe"
    - "Unpushed-migration rule: amend still-local migration files in place instead of stacking new ones"

key-files:
  created: []
  modified:
    - prisma/schema.prisma
    - prisma/migrations/20260616152601_init/migration.sql
    - prisma/migrations/20260617121303_add_refresh_tokens/migration.sql
    - src/generated/prisma/** (regenerated client)
    - src/plugins/auth.ts
    - src/services/user.ts
    - src/services/refresh-token.ts
    - src/routes/auth/index.ts

key-decisions:
  - "Folded the rename + BigInt widen + deleted_at into the two existing unpushed migrations (rewriting their CREATE TABLE bodies) rather than adding a third hand-authored migration, per user correction at the Task 2 checkpoint — history now reads as if users was always named right and always BigInt"
  - "users.id and refresh_tokens.id/user_id are BigInt everywhere they touch Prisma; Number(...) at the JWT sign and HTTP response boundaries (a raw bigint throws in JSON.stringify)"
  - "Unrelated pre-existing repo drift (refresh_tokens unique-index name mismatch, and a migration-file-edited-after-apply checksum mismatch) was fixed non-destructively (index rename, checksum patch) purely to unblock the migrate workflow — separate from the plan's core deliverable"

patterns-established:
  - "Existing-table renames on brownfield Prisma models must be hand-authored (RENAME TABLE), never a generated diff, which emits destructive DROP+CREATE"
  - "MySQL/MariaDB MODIFY COLUMN is a full column redefinition — AUTO_INCREMENT/NOT NULL must be restated or they are silently dropped"

requirements-completed: [DATA-01, DATA-03]

coverage:
  - id: D1
    description: "users table live with deleted_at soft-delete column, prior data preserved in principle (dev DB was reset by the user out-of-band mid-session; see Issues Encountered)"
    requirement: DATA-03
    verification:
      - kind: other
        ref: "SHOW CREATE TABLE users — id bigint AUTO_INCREMENT, deleted_at DATETIME(3) NULL present"
        status: pass
    human_judgment: false
  - id: D2
    description: "Uniform BigInt keys: users.id, refresh_tokens.id, refresh_tokens.user_id all BIGINT with AUTO_INCREMENT/NOT NULL preserved"
    requirement: DATA-01
    verification:
      - kind: other
        ref: "SHOW CREATE TABLE users / SHOW CREATE TABLE refresh_tokens"
        status: pass
      - kind: other
        ref: "npx prisma migrate status — both migrations applied, no drift, no pending"
        status: pass
    human_judgment: false
  - id: D3
    description: "Auth layer (plugins/auth.ts, services/user.ts, services/refresh-token.ts, routes/auth/index.ts) compiles against the bigint Prisma client and stays JSON-safe at JWT/response boundaries"
    verification:
      - kind: unit
        ref: "npm run build (tsc, exit 0)"
        status: pass
      - kind: integration
        ref: "npm test — dist/src/test/**/*.test.js (3/3 pass)"
        status: pass
    human_judgment: false

duration: 56min
completed: 2026-07-07
status: complete
---

# Phase 01 Plan 01: Rename User->users, Widen to BigInt, Soft Delete Summary

**users table snake_case-mapped with uniform BigInt keys and deleted_at, delivered by amending the two existing unpushed migrations in place (not a third migration), auth layer threaded bigint-safe end to end.**

## Performance

- **Duration:** ~56 min
- **Started:** 2026-07-07T08:42:17Z
- **Completed:** 2026-07-07T09:38:52Z
- **Tasks:** 3 (Task 1 auto, Task 2 blocking-human checkpoint x2 review passes, Task 3 auto)
- **Files modified:** 12 (schema, 2 migration files, generated client, 4 auth-layer files)

## Accomplishments

- `User` model mapped to the live `users` table (`@@map("users")`) with a new nullable `deleted_at` soft-delete column (DATA-03)
- `users.id`, `refresh_tokens.id`, and `refresh_tokens.user_id` all widened from `Int`/`INTEGER` to `BigInt`/`BIGINT`, with `AUTO_INCREMENT` and `NOT NULL` preserved — uniform integer key foundation for the rest of Phase 1 (DATA-01, DATA-02 foundation)
- Auth layer (`plugins/auth.ts`, `services/user.ts`, `services/refresh-token.ts`, `routes/auth/index.ts`) threads `bigint` at every Prisma boundary and `Number(...)`-encodes at the JWT-sign and HTTP-response boundaries so responses stay JSON-safe
- Per user correction during checkpoint review: the rename/widen/soft-delete was folded directly into the two existing unpushed migrations (`20260616152601_init`, `20260617121303_add_refresh_tokens`) instead of a third hand-authored migration — migration history now reads as if `users` was always named right and always `BigInt`
- Full acceptance gate green: `SHOW CREATE TABLE` confirms both id columns `bigint AUTO_INCREMENT`, `refresh_tokens.user_id bigint NOT NULL`, `users.deleted_at` present, index names `users_email_key` / `refresh_tokens_token_hash_key`; `npx prisma migrate status` reports both migrations applied with no drift/pending; `npm run build` and `npm test` both green (3/3 tests pass)

## Task Commits

Each task was committed atomically:

1. **Task 1: Map User->users + deleted_at, widen keys to BigInt, hand-author combined migration** - `45cb1b6` (feat)
2. **Task 1 (revision): Fold rename/widen/deleted_at into the existing unpushed migrations instead of a third file** - `99fccc0` (fix) — per user correction at the Task 2 checkpoint
3. **Task 3: Verification + acceptance gate** — no code changes; verification-only (`SHOW CREATE TABLE`, `prisma migrate status`, `npm run build`, `npm test`), all read-only against the DB. No live-DB reconciliation DDL or `_prisma_migrations` checksum patch was executed — the dev database had already been brought to the target schema by the user resetting it out-of-band during this session (see Issues Encountered).

**Plan metadata:** (this commit) - `docs(01-01): complete plan`

## Files Created/Modified

- `prisma/schema.prisma` - `User` gains `@@map("users")`, `deletedAt @map("deleted_at")`, `id BigInt`; `RefreshToken` gains `id BigInt`, `userId BigInt @map("user_id")`
- `prisma/migrations/20260616152601_init/migration.sql` - hand-edited: `CREATE TABLE` now emits `users` directly with `id BIGINT AUTO_INCREMENT`, `deleted_at DATETIME(3) NULL`, and unique index `users_email_key`
- `prisma/migrations/20260617121303_add_refresh_tokens/migration.sql` - hand-edited: `id`/`user_id` are now `BIGINT` in the `CREATE TABLE` block
- `src/generated/prisma/**` - regenerated client reflecting the mapped/widened models
- `src/plugins/auth.ts` - `generateTokens` accepts `{ id: bigint, ... }`; JWT payload Number-encodes the id with an inline rationale comment
- `src/services/user.ts` - `getUserById(id: bigint)`
- `src/services/refresh-token.ts` - `generateRefreshToken(userId: bigint)`; `verifyRefreshToken` returns `{ id: bigint, ... }`
- `src/routes/auth/index.ts` - `/me` converts the decoded numeric JWT id back to `bigint` via `BigInt(...)` for the query; all four response payloads Number-encode `user.id`

## Decisions Made

- Folded the existing-table changes into the two already-applied-but-unpushed migrations rather than a third migration, per explicit user correction during the Task 2 checkpoint review — honors the Phase 1 unpushed-migration rule more directly (history reads as if it was always this way) than stacking an additional rename+widen migration on top
- `Number(user.id)` at the JWT/HTTP-response boundary is a deliberate, documented Phase-1-only choice (safe for small autoincrement ids); a global BigInt-serialization strategy is deferred to Phase 2 per RESEARCH Open Question 4
- Two pre-existing, unrelated drift issues in the dev DB/migration history (a stale unique-index name on `refresh_tokens`, and a migration file that had been hand-edited after being applied without a matching checksum update) were fixed non-destructively (index rename, checksum patch) solely to unblock the `prisma migrate dev` workflow this plan depends on — out of this plan's scope otherwise, logged here for traceability

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed stale `refresh_tokens` unique-index name to unblock `prisma migrate dev`**
- **Found during:** Task 1, Step C (drafting the migration)
- **Issue:** The live dev DB had the unique index on `refresh_tokens.token_hash` named `refresh_tokens_tokenHash_key`, while the already-applied migration file and current schema expect `refresh_tokens_token_hash_key`. This pre-existing drift made `prisma migrate dev` refuse to proceed (demanding a destructive `migrate reset`).
- **Fix:** `ALTER TABLE refresh_tokens RENAME INDEX refresh_tokens_tokenHash_key TO refresh_tokens_token_hash_key;` — metadata-only, no data touched.
- **Files modified:** none (DB-only)
- **Verification:** `npx prisma migrate status` returned to "up to date" afterward
- **Committed in:** n/a (DB-only change, not a file commit)

**2. [Rule 3 - Blocking] Patched a stale `_prisma_migrations` checksum (twice, across the plan revision)**
- **Found during:** Task 1, Step C, and again after the Task 2 revision
- **Issue:** The `20260617121303_add_refresh_tokens` migration file had been hand-edited after being applied, without the DB's recorded checksum being updated, causing `prisma migrate dev` to detect "modified after applied" drift. After the Task 2 revision further edited both migration files' content, both checksums needed recomputation again.
- **Fix:** Computed sha256 of each file's current content and updated the corresponding `_prisma_migrations.checksum` row. (In the end, the user reset the dev DB out-of-band before I applied my own patch in Task 3, and the reset reapplied both migrations fresh with checksums that already match the current file content — so no further checksum patch was needed at Task 3 time.)
- **Files modified:** none (DB-only)
- **Verification:** `_prisma_migrations` checksums confirmed matching current file content via direct query
- **Committed in:** n/a (DB-only change, not a file commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking pre-existing drift, DB-metadata-only, unrelated to this plan's schema changes but required to unblock the migration workflow)
**Impact on plan:** No scope creep into application code; both fixes were narrowly targeted at unblocking `prisma migrate dev` against pre-existing, unrelated repo/DB drift.

## Issues Encountered

- **Interactive-CLI limitation:** `npx prisma migrate dev --create-only` refused to run non-interactively in this environment ("Prisma Migrate has detected that the environment is non-interactive"). Resolved by hand-authoring the migration file content directly (fully specified by the plan's Step C), rather than relying on the interactive draft-generation step — no DDL was ever applied via this path.
- **Dev database reset out-of-band mid-session:** Between the Task 2 checkpoint approval and Task 3 verification, a read-only check revealed the dev database had already been fully reset (all tables dropped and migrations reapplied fresh from their current file content) and both `users`/`refresh_tokens` tables were empty (0 rows), where a `migrate dev` dry-run earlier in the session had reported 1 existing row in the `User` table. This was flagged as a potential data-loss incident and execution was halted pending clarification. **Resolved:** the user confirmed they personally ran the reset in another session against this disposable dev database — not a bug, not caused by this plan's changes, and not a data-loss concern. As a result, the previously-approved reconciliation DDL and `_prisma_migrations` checksum-patch statements were never executed in Task 3 (the DB was already in the target state from the reset); Task 3 proceeded straight to the read-only verification + acceptance gate.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `users` (renamed, BigInt-keyed, soft-deletable) and `refresh_tokens` (BigInt-keyed) are live and confirmed via `SHOW CREATE TABLE`; the auth API compiles and its existing regression tests pass
- Uniform BigInt PK/FK convention is now established for every table Phase 1's remaining plan (01-02) will add (House/Room/Device/Command/etc., with `user_id` denormalization)
- No blockers for 01-02

---
*Phase: 01-schema-data-conventions*
*Completed: 2026-07-07*
