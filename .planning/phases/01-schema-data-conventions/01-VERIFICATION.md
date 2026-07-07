---
phase: 01-schema-data-conventions
verified: 2026-07-07T13:45:00Z
status: passed
score: 6/6 roadmap success criteria verified (1 accepted via override)
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "prisma/migrations/<ts>_rename_and_widen_existing_tables/migration.sql — ONE hand-authored migration"
    reason: "Folded directly into the two already-unpushed migrations (20260616152601_init, 20260617121303_add_refresh_tokens) instead of a third file, per explicit user correction at the Task 2 blocking-human checkpoint — no migration in this set has ever been applied to a shared/pushed environment, so rewriting in place carries the same (zero) risk as a live RENAME would have carried, and better honors the project's own 'never stack a new migration, amend the existing unpushed one' rule."
    accepted_by: "Leah"
    accepted_at: "2026-07-07T14:00:00Z"
human_verification:
  - test: "Confirm the migration-safety deviation on the User→users change is acceptable: no `RENAME TABLE`/`ALTER TABLE ... RENAME` statement exists anywhere in the final migration files (grep confirms zero matches across all three migrations). Instead, the CREATE TABLE body inside the already-unpushed `20260616152601_init` migration was hand-edited in place to define `users` (BigInt PK) from the start. Separately, the developer's local dev database was reset out-of-band mid-phase (all tables dropped, migrations reapplied fresh), which discarded the single pre-existing `User` row that the Task-2 blocking-human gate was specifically convened to protect."
    expected: "Either (a) confirm this is acceptable because no migration in this set has ever been pushed/applied to a shared environment with real data, so rewriting the CREATE TABLE body in place is equivalent-and-safer than a live RENAME, and the discarded dev row was disposable and developer-authorized — or (b) require a literal `RENAME TABLE`/hand-verified no-data-loss migration before Phase 1 is considered satisfied, per the literal wording of ROADMAP Success Criterion 1 and REQUIREMENTS.md DATA-01 (\"hand-authored ALTER TABLE ... RENAME migration\")."
    why_human: "This is a judgment call about whether an approved-mid-execution deviation (folding the rename+widen into the two already-unpushed migrations, per user correction at the Task 2 checkpoint) still satisfies the specific data-loss-prevention contract the ROADMAP and REQUIREMENTS.md describe in explicit mechanism terms (RENAME TABLE, hand-verified no data loss). Grep/DB introspection can prove what mechanism was used (none — no RENAME statement exists) but cannot decide whether the substitute mechanism is an acceptable equivalent for this project's risk tolerance."
---

# Phase 1: Schema & Data Conventions Verification Report

**Phase Goal:** Complete Prisma schema including the append-only events table (with entity_type + nullable device_id for command-lifecycle rows); snake_case @@map; soft-delete; BigInt autoincrement PKs + NanoID public_id (non-enumerable external IDs); user_id denormalization; polymorphic morph tables; last_event_id (BigInt) column for tuple guard.
**Verified:** 2026-07-07T13:45:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `prisma migrate dev` applies cleanly; rename migrations for `User`/`RefreshToken` produce `users`/`refresh_tokens`; snake_case everywhere; generated SQL hand-verified to emit `RENAME TABLE`, not DROP+CREATE — no data loss | ⚠️ WARNING (see Human Verification) | `npx prisma migrate status` → "Database schema is up to date!" (3 migrations, no drift). Live `SHOW CREATE TABLE users`/`refresh_tokens` confirm snake_case, BigInt, AUTO_INCREMENT. **But**: `grep -rn -i "rename" prisma/migrations/*/migration.sql` returns **zero matches** — no `RENAME TABLE` statement exists anywhere in the migration history. Per SUMMARY, the rename+widen was instead folded directly into the already-unpushed `20260616152601_init` migration's `CREATE TABLE` body (git `45cb1b6` → `99fccc0`), and the developer's dev DB was separately reset out-of-band mid-phase, discarding the 1 pre-existing `User` row the Task-2 gate existed to protect. End schema state is correct; the specific safety mechanism the ROADMAP/REQUIREMENTS.md describe was not the one used. |
| 2 | House/Room/Device/Command/CommandTarget + 4 state tables present with BigInt autoincrement PKs; public_id on House/Room/Device/Command only; Room/Device carry denormalized `user_id`; `deleted_at` on User/House/Room/Device; existing PKs widened Int→BigInt | ✓ VERIFIED | Live DB query lists all 10 new tables + `users`/`refresh_tokens`. Schema greps: `@@map(` = 12, `@db.VarChar(21)` = 4 (House/Room/Device/Command only — confirmed no `publicId` on CommandTarget/state tables/Event by direct read), `deleted_at` = 4 (users/houses/rooms/devices). `SHOW CREATE TABLE` confirms `users.id`/`refresh_tokens.id`/`refresh_tokens.user_id` are `bigint` with `AUTO_INCREMENT`/`NOT NULL` preserved. |
| 3 | `events` table: BigInt `id` PK (ordering key), separate `event_id` (uuid, UNIQUE), `entity_type`, nullable `device_id`, `device_type`, `command_id`, `snapshot`, `recorded_at`, compound `(device_id, recorded_at)` index | ✓ VERIFIED | Schema + migration SQL show exactly this shape. `@db.Char(36)` = 1 (event_id only), `entityType String` (plain, no enum), `deviceId BigInt?` nullable, `@@index([deviceId, recordedAt])` present (grep confirms 1 match). |
| 4 | Per-type state tables carry `last_event_at`/`last_event_id` (BigInt); `state_type`/`state_id` morph on Device; CommandTarget carries `deadline_at`; Command carries a `status` column supporting the full lifecycle vocabulary | ✓ VERIFIED | `last_event_id` grep = 4 (one per state table); `@@unique([deviceId])` = 4; Device has `stateType`/`stateId` plain scalars (no `@relation`); CommandTarget has `deadlineAt DateTime`; Command has `status String @default("received")` with all 7 values documented in an inline comment (plain String, TypeBox-validated later, no DB enum — by design, D-06). |
| 5 | NanoID `public_id` generation seam confirmed/documented as shaped-not-generated; no `@default(uuid())` anywhere | ✓ VERIFIED | `grep -Ec '@default\(uuid'` = 0; `grep -Ec '^enum '` = 0; no `nanoid`/`uuid` package in `package.json` yet (generator explicitly deferred to Phase 2 per both SUMMARYs and ROADMAP Success Criterion 5). |
| 6 | `npm run build` compiles zero-error; `npm test` passes existing auth tests; `prisma migrate dev` exits 0 | ✓ VERIFIED | `npm run build` → clean exit, no tsc errors. `npm test` → 3/3 pass (`support works standalone`, `example is loaded`, `default root route`). `npx prisma migrate status` → up to date, 3 migrations, no drift. |

**Score:** 5/6 success criteria cleanly verified; 1 flagged for human decision (not a code defect — a judgment call on whether an approved mid-execution deviation still satisfies the literal safety-mechanism wording of the roadmap/requirements contract).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `prisma/schema.prisma` | User/RefreshToken mapped + widened; 10 new models | ✓ VERIFIED | All 12 models present with correct `@@map`/`@map`, BigInt PKs, conventions applied uniformly (confirmed by direct read + grep audit, see Truths 2-5). |
| `prisma/migrations/<ts>_rename_and_widen_existing_tables/migration.sql` (per 01-01-PLAN.md frontmatter) | ONE hand-authored migration: RENAME + ADD COLUMN + 3× MODIFY COLUMN, no DROP/CREATE | ✗ DOES NOT EXIST | This exact artifact was never shipped. Commit `45cb1b6` created it; commit `99fccc0` deleted it again and instead hand-edited the two pre-existing migration files (`20260616152601_init`, `20260617121303_add_refresh_tokens`) directly, per an in-session user correction at the Task 2 checkpoint. The functional outcome (users/BigInt/deleted_at, live and correct) was still achieved — see Truth 1 and Human Verification for the full analysis of this deviation. **This looks intentional** — see override suggestion below. |
| `prisma/migrations/20260707094526_add_domain_schema/migration.sql` | Prisma-generated, 10 `CREATE TABLE` (not hand-edited) | ✓ VERIFIED | Confirmed 10 `CREATE TABLE` statements + supporting indexes; no `DROP`/`ALTER` against `users`/`refresh_tokens`. |
| Auth layer (`plugins/auth.ts`, `services/user.ts`, `services/refresh-token.ts`, `routes/auth/index.ts`) | Threaded `bigint` at Prisma boundary, `Number(...)` at JWT/response boundary | ✓ VERIFIED | Read all four files directly: `getUserById(id: bigint)`, `generateRefreshToken(userId: bigint)`, `verifyRefreshToken` returns `{ id: bigint, ... }`, `generateTokens` accepts `{ id: bigint, ... }` and signs `Number(user.id)`; `/me` does `getUserById(BigInt(request.user.id))`; all 4 response payloads do `Number(user.id)`. |

**This looks intentional.** To accept the missing `rename_and_widen_existing_tables` artifact as satisfied-by-alternate-implementation, add to this file's frontmatter:

```yaml
overrides:
  - must_have: "prisma/migrations/<ts>_rename_and_widen_existing_tables/migration.sql — ONE hand-authored migration"
    reason: "Folded directly into the two already-unpushed migrations (20260616152601_init, 20260617121303_add_refresh_tokens) instead of a third file, per explicit user correction at the Task 2 blocking-human checkpoint — no migration in this set has ever been applied to a shared/pushed environment, so rewriting in place carries the same (zero) risk as a live RENAME would have carried, and better honors the project's own 'never stack a new migration, amend the existing unpushed one' rule."
    accepted_by: "<your name>"
    accepted_at: "<ISO timestamp>"
```

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `User.@@map("users")` | live `users` table | Prisma client queries | ✓ WIRED | `prisma.user.*` calls in `services/user.ts`/`services/auth.ts` resolve against the live `users` table; confirmed via `SHOW CREATE TABLE` + `npm test` passing register/login/refresh regression. |
| Auth layer bigint boundary | JWT sign / HTTP response serializer | `Number(user.id)` conversion | ✓ WIRED | Verified inline at all 4 response call sites in `routes/auth/index.ts` and the `fastify.jwt.sign` call in `plugins/auth.ts`; `npm run build` compiles clean against the bigint-typed generated client (this is the strongest available check — no runtime auth integration tests exist for this boundary beyond the 3 pre-existing tests). |
| Each state table's `lastEventId` | `events.id` (never `events.event_id`) | comment convention (no real FK under `relationMode=prisma`) | ✓ WIRED (as designed) | Consistently annotated across all 4 state tables; correctly *not* a real FK since `relationMode = "prisma"` — this is a documented convention, not a DB-enforced constraint, matching the plan's own explicit instruction. |
| `Device.stateType`/`stateId` | one of 4 per-type state tables | plain scalar morph pointer, no `@relation` | ✓ WIRED (as designed) | Confirmed no `@relation` on these fields; `@@index([stateId])` present for lookup. |

### Data-Flow Trace (Level 4)

Not applicable — Phase 1 is schema-only with no runnable application logic consuming these models yet (by design; ROADMAP explicitly notes "this phase has no runnable application logic to test red").

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Migration state is clean/applied | `npx prisma migrate status` | "Database schema is up to date!" (3 migrations, no drift) | ✓ PASS |
| Build compiles | `npm run build` | exit 0, no tsc errors | ✓ PASS |
| Existing regression passes | `npm test` | 3/3 pass | ✓ PASS |
| Live schema matches migration files | direct MariaDB query (`SHOW TABLES`, `SHOW CREATE TABLE users`/`refresh_tokens`) | all 12 tables present; `users`/`refresh_tokens` match target BigInt/AUTO_INCREMENT/deleted_at shape | ✓ PASS |
| No RENAME statement anywhere in migration history | `grep -rn -i "rename" prisma/migrations/*/migration.sql` | zero matches | ✗ FAIL (see Truth 1 / Human Verification — not a build/test failure, a mechanism-vs-contract mismatch) |
| Referenced commits exist and match claimed content | `git show --stat <hash>` for all 7 commits cited in both SUMMARYs | all 7 found, diffs match the narrative (e.g. `45cb1b6` creates the third migration file, `99fccc0` deletes it and edits the other two) | ✓ PASS |

### Probe Execution

No probes declared or discovered for this phase (`scripts/*/tests/probe-*.sh` not present; not a migration/tooling phase in the probe-execution sense). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| DATA-01 | 01-01, 01-02 | snake_case via `@map`/`@@map` everywhere, incl. existing User/RefreshToken; existing-table rename via hand-authored `ALTER TABLE ... RENAME` migration | ⚠️ SATISFIED WITH CAVEAT | Snake_case fully delivered and verified (`@@map(` = 12). The specific mechanism clause ("hand-authored `ALTER TABLE ... RENAME` migration") is **not** literally satisfied — no RENAME statement exists in any migration file (see Truth 1). |
| DATA-02 | 01-02 | `user_id` denormalized onto Room/Device/Command; ownership checks use it directly (no joins), incl. `GET /commands/:id` | ✓ SATISFIED (schema level only) | `user_id BigInt` present on rooms/devices/commands, indexed. The "ownership checks use it directly" clause is runtime/route-level behavior that does not exist yet — correctly deferred to Phase 2 (no routes exist yet). Not a Phase 1 gap; flagging only because REQUIREMENTS.md marks the full ID "Complete" already. |
| DATA-03 | 01-01, 01-02 | Soft delete (`deleted_at`) on User/House/Room/Device; all reads exclude soft-deleted rows; a soft-deleted user cannot authenticate | ✓ SATISFIED (schema level only) | `deleted_at` present on all 4 models (grep = 4, confirmed live via `SHOW CREATE TABLE users`). The runtime-enforcement clause ("all reads exclude...", "cannot authenticate") is **confirmed not yet wired** — 01-REVIEW.md's WR-03 explicitly flags `getUserById` does not filter on `deletedAt`. This is correctly deferred to Phase 2 (ROADMAP Phase 2 Success Criterion 6 owns this), not a Phase 1 gap — but REQUIREMENTS.md marking the full ID "Complete" under Phase 1 is premature relative to its own full text. |
| DATA-04 | 01-02 | Batched `IN` queries; tuple-guarded `UPDATE`; event idempotency via unique index on `event_id`; CAS target transitions; roll-up under `SELECT ... FOR UPDATE`; report consumer as one transaction | ✓ SATISFIED (schema level only) | Only the schema-level foundation exists: `events.event_id` unique index (`@db.Char(36) @unique`, confirmed), `last_event_at`/`last_event_id` tuple-guard columns (grep = 4). None of the runtime behaviors (batched queries, CAS, `SELECT ... FOR UPDATE`, one-transaction consumer) exist yet — they belong to Phase 4/6 per the ROADMAP's own phase breakdown. This matches both PLAN 01-02's own success-criteria text ("delivered **at the schema level**") and ROADMAP Phase 1's narrower Success Criteria (3-4), so it is **not a Phase 1 gap** — but REQUIREMENTS.md's coverage table assigns DATA-04 solely to "Phase 1" and marks it fully "Complete," which does not match the requirement's own full text. Flagging for project-tracking accuracy, not as a phase-blocking issue. |

No orphaned requirements — REQUIREMENTS.md's Phase 1 mapping (DATA-01..04) exactly matches the union of both plans' `requirements` frontmatter.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any file modified by this phase (`prisma/schema.prisma`, `src/plugins/auth.ts`, `src/services/user.ts`, `src/services/refresh-token.ts`, `src/routes/auth/index.ts`).

Three findings surfaced by the phase's own code-review pass (`01-REVIEW.md`, commit `4ed4d0c`), reproduced here for completeness since SUMMARYs must not be trusted as evidence on their own — all independently corroborated by direct file reads during this verification:

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/plugins/auth.ts:44`, `src/routes/auth/index.ts:50,65,78,102` | WR-01 | `Number(user.id)` silently rounds past `Number.MAX_SAFE_INTEGER` instead of throwing | ⚠️ Warning | Documented, deliberate Phase-1-only choice (not an active risk at current id scale); no bounds guard exists. Does not block Phase 1's schema goal. |
| `src/routes/auth/index.ts:90-99`, `src/services/refresh-token.ts:25-49` | WR-02 | Refresh-token rotation is non-atomic; `revokeRefreshToken`'s return value discarded, allowing a leaked token to be redeemed twice under concurrency | ⚠️ Warning | **Pre-existing** — confirmed via `git log` that this pattern predates Phase 1 (present since commit `43dba21`, before any Phase 1 commit). Not introduced by this phase; out of Phase 1's schema-conventions scope. |
| `src/services/user.ts:21-26` | WR-03 | `deleted_at` column added but never consulted by any query — soft-delete has zero runtime effect today | ℹ️ Info | Expected — enforcement is explicitly Phase 2's job (ROADMAP Phase 2 Success Criterion 6). Not a Phase 1 gap. |

### Human Verification Required

**Resolved 2026-07-07:** Accepted as satisfied via override (see frontmatter `overrides`) — the developer confirmed the in-place migration rewrite is an acceptable substitute for a literal `RENAME TABLE`, since no migration in this set has ever been pushed/applied outside this developer's own dev environment.

### 1. Migration-safety mechanism deviation on the User→users rename

**Test:** Review `prisma/migrations/20260616152601_init/migration.sql` and `prisma/migrations/20260617121303_add_refresh_tokens/migration.sql` and confirm no `RENAME TABLE` statement exists anywhere (verifiable independently via `grep -rn -i "rename" prisma/migrations/*/migration.sql` — returns zero matches). Cross-reference SUMMARY's "Issues Encountered" section describing the out-of-band dev-DB reset.
**Expected:** A decision on whether folding the rename/widen/soft-delete directly into the two already-unpushed migration files (rather than emitting a literal, hand-verified `RENAME TABLE`) satisfies the intent of ROADMAP Success Criterion 1 and REQUIREMENTS.md DATA-01's "hand-authored `ALTER TABLE ... RENAME` migration" clause, given these migrations have never been pushed/applied anywhere but this developer's own (now-reset) local dev database.
**Why human:** This is a judgment call about acceptable risk and contract interpretation, not something grep/build/test can resolve. The end schema state is objectively correct (verified above); what's in question is whether the *documented safety mechanism* the roadmap promised was actually the mechanism used, given a mid-execution, human-approved pivot away from it.

### Gaps Summary

No missing artifacts, no stub implementations, no unwired key links, and no unresolved debt markers were found. `npm run build`, `npm test`, and `npx prisma migrate status` are all clean, and the live MariaDB schema was independently queried and matches the target design (BigInt PKs throughout, snake_case naming, `public_id`/`deleted_at`/`user_id` placement exactly as specified, dual-id `events` table, tuple-guard columns on all 4 state tables, zero native DB enums, zero uuid-based defaults).

The sole open item is not a code defect: the plan's own frontmatter promised a specific, hand-authored `RENAME TABLE` migration as the mechanism for proving zero data loss on the pre-existing `User`/`RefreshToken` tables. That exact mechanism was abandoned mid-execution (with an in-session user correction, honestly documented in the SUMMARY) in favor of rewriting the CREATE TABLE bodies of the two already-unpushed migrations directly — which is likely fine given those migrations have never been pushed, but which also means the specific "no data loss" claim was never actually exercised against a live, at-risk table (the one row that existed in the developer's local dev DB was in fact discarded via an out-of-band reset). This is surfaced for a human decision rather than silently accepted or silently failed.

Two REQUIREMENTS.md entries (DATA-02, DATA-04, and to a lesser extent DATA-03) are marked fully "Complete" under Phase 1 even though their full requirement text describes runtime/query behavior that correctly belongs to later phases (2, 4, 6) per the ROADMAP's own phase breakdown and both plans' own success-criteria wording ("delivered at the schema level"). This is a project-tracking accuracy note, not a Phase 1 gap — Phase 1's own ROADMAP-defined goal (schema only) is fully achieved for all four requirement IDs.

---

_Verified: 2026-07-07T13:45:00Z_
_Verifier: Claude (gsd-verifier)_
