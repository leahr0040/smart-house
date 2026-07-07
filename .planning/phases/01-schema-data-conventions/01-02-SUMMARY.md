---
phase: 01-schema-data-conventions
plan: 02
subsystem: database
tags: [prisma, mariadb, mysql, schema, bigint, migrations]

# Dependency graph
requires:
  - phase: 01-schema-data-conventions (plan 01)
    provides: BigInt-widened users/refresh_tokens tables, deleted_at on users, snake_case @map convention established
provides:
  - Ten new domain models in prisma/schema.prisma (House, Room, Device, Command, CommandTarget, LightState, AcState, HeaterState, SensorState, Event)
  - Additive migration creating all ten tables live in MariaDB
  - Full Phase 1 acceptance gate green (migrate status clean, build clean, existing tests pass)
affects: [phase-02-entity-crud-multi-tenancy, phase-04-command-handler, phase-06-report-consumer]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "BigInt @id @default(autoincrement()) on every new PK (D-11)"
    - "public_id String @unique @db.VarChar(21) only on user-facing models (House/Room/Device/Command)"
    - "Denormalized FK-shaped columns (user_id, house_id, room_id, morph state_type/state_id, device_id, command_id) declared as plain scalars with explicit @@index, never @relation, under relationMode=prisma"
    - "Dual-id events table: BigInt id (ordering/cursor key) + separate Char(36) @unique event_id (idempotency key), never compared to each other"
    - "Per-type state tables carry last_event_at/last_event_id + @@unique([deviceId]) structural 1:1 guard"
    - "status/type/mode/kind/source columns are plain String, no native DB enums or CHECK constraints (D-06)"

key-files:
  created:
    - prisma/migrations/20260707094526_add_domain_schema/migration.sql
  modified:
    - prisma/schema.prisma
    - src/generated/prisma/** (regenerated client)

key-decisions:
  - "All ten new tables use BigInt autoincrement PKs; public_id (VarChar(21) @unique) shaped now on House/Room/Device/Command only, generator deferred to Phase 2"
  - "Events table carries a separate ordering id (BigInt) and idempotency event_id (Char(36) @unique) per D-12 — never interchanged"
  - "No native DB enums/CHECK/min-max anywhere in the new schema; all value/range/vocabulary rules deferred to TypeBox in later phases (D-06)"

requirements-completed: [DATA-01, DATA-02, DATA-03, DATA-04]

coverage:
  - id: D1
    description: "Ten new domain models (House, Room, Device, Command, CommandTarget, LightState, AcState, HeaterState, SensorState, Event) authored in schema.prisma with BigInt PKs, correct public_id placement, denormalized user_id, soft-delete columns, morph columns, and dual-id events — no @relation on any FK-shaped column, no native DB enums"
    requirement: "DATA-01"
    verification:
      - kind: other
        ref: "npx prisma validate; npm run build; grep counts documented in Task 1 verify block (all passed)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Additive migration generated and applied — ten CREATE TABLE statements, no DROP/ALTER against users/refresh_tokens"
    requirement: "DATA-04"
    verification:
      - kind: other
        ref: "npx prisma migrate dev --name add_domain_schema; npx prisma migrate status (up to date, no drift)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Full Phase 1 acceptance gate: migrate status clean, build zero errors, existing auth tests pass, convention audit (last_event_id x4, deleted_at x4, (deviceId,recordedAt) index) confirmed"
    requirement: "DATA-02"
    verification:
      - kind: unit
        ref: "npm test (dist/src/test/**/*.test.js) — 3/3 pass"
        status: pass
      - kind: other
        ref: "npx prisma migrate status; npm run build"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-07-07
status: complete
---

# Phase 1 Plan 2: Additive Domain Schema Summary

**Ten new domain models (houses/rooms/devices/commands/command_targets + four per-type state tables + append-only events) added to schema.prisma and applied as one clean CREATE-TABLE-only migration; full Phase 1 acceptance gate green.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-07T09:45:00Z (approx.)
- **Completed:** 2026-07-07T10:09:01Z
- **Tasks:** 3 completed
- **Files modified:** prisma/schema.prisma, 1 new migration.sql, regenerated src/generated/prisma/**

## Accomplishments
- Authored House, Room, Device, Command, CommandTarget, LightState, AcState, HeaterState, SensorState, and Event models in `prisma/schema.prisma`, uniformly applying BigInt autoincrement PKs, snake_case `@map`/`@@map`, `public_id` (VarChar(21) @unique) on the four user-facing models only, denormalized `user_id` on Room/Device/Command, `deleted_at` on House/Room/Device, the Device morph pair (`state_type`/`state_id`), and the events dual-id split (BigInt `id` ordering key + separate `event_id` Char(36) @unique idempotency key)
- Generated and applied the single additive migration (`20260707094526_add_domain_schema`) via `npx prisma migrate dev --name add_domain_schema` — pure `CREATE TABLE`/`CREATE INDEX`, no hand-editing needed, no `DROP`/`ALTER` touched `users`/`refresh_tokens`
- Ran the complete Phase 1 acceptance gate: `prisma migrate status` clean (3 migrations, no drift), `npm run build` zero errors, `npm test` green (3/3 existing auth tests), and a convention audit confirming all six ROADMAP success criteria hold

## Task Commits

Each task was committed atomically:

1. **Task 1: Author all ten new models in schema.prisma per the locked conventions** - `a656d5b` (feat)
2. **Task 2: Generate and apply the additive domain-schema migration** - `9c0be44` (feat)
3. **Task 3: Full Phase 1 acceptance gate** — no code change beyond the Task 1 comment fix below; verification-only, folded into the fix commit below

**Fix commit (Rule 1 — auto-fixed during Task 3 verification):** `1a7aacb` (fix)

**Plan metadata:** committed separately per `<final_commit>` step (STATE.md/ROADMAP.md/REQUIREMENTS.md/SUMMARY.md)

_Note: Task 3 was a verification-only task (migrate status + build + test + grep audit); it produced one small deviation (below), not a standalone feature commit._

## Files Created/Modified
- `prisma/schema.prisma` - Ten new models added (House, Room, Device, Command, CommandTarget, LightState, AcState, HeaterState, SensorState, Event)
- `prisma/migrations/20260707094526_add_domain_schema/migration.sql` - Generated additive migration, 10 CREATE TABLE + supporting indexes
- `src/generated/prisma/**` - Regenerated Prisma client reflecting the ten new models

## Decisions Made
- Followed the plan's locked conventions exactly: BigInt PKs everywhere (D-11), public_id only on House/Room/Device/Command, no `@relation` on any denormalized/morph FK under `relationMode=prisma`, events dual-id split (D-12), no native DB enums/CHECK/min-max anywhere (D-06), `events.snapshot` as the sole `Json` column (D-07)
- No architectural deviations — this plan was purely additive and matched the RESEARCH.md worked examples closely enough that no Rule 4 checkpoint was needed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Reworded Event.id doc comment to fix a grep-count false positive**
- **Found during:** Task 3 (Full Phase 1 acceptance gate — convention audit)
- **Issue:** The Task 3 verify script asserts `grep -c 'last_event_id' prisma/schema.prisma` equals exactly 4 (one per state table). My explanatory comment on `Event.id` also contained the literal string "last_event_id" ("target referenced by every state table's last_event_id"), pushing the count to 5 and failing the automated check.
- **Fix:** Reworded the comment to describe the same D-12 intent ("the guard-comparison target each state table's tuple guard points at") without repeating the literal column-name token. Regenerated the Prisma client (doc comments feed generated JSDoc) and re-ran `npx prisma validate`, `npm run build`, and the full grep audit — all pass, count is now exactly 4.
- **Files modified:** prisma/schema.prisma, src/generated/prisma/internal/class.ts
- **Verification:** `grep -c 'last_event_id' prisma/schema.prisma` → 4; `npx prisma validate` and `npm run build` both exit 0
- **Committed in:** `1a7aacb`

---

**Total deviations:** 1 auto-fixed (1 bug — comment wording, no functional/schema change)
**Impact on plan:** Cosmetic only; no change to any column, index, type, or migration SQL. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required. Local MariaDB instance (`smart_house` on `localhost:3306`) was already reachable and up to date at the start of this plan.

## Next Phase Readiness

Phase 1 (Schema & Data Conventions) is now complete — both plans executed:
- All six ROADMAP Phase 1 success criteria confirmed satisfied: (1) migrations apply cleanly with snake_case naming; (2) all ten new tables present with BigInt PKs, correct public_id/user_id/deleted_at placement; (3) events table shaped with entity_type + nullable device_id + compound index; (4) tuple-guard columns (last_event_at/last_event_id) and morph columns present; (5) NanoID public_id seam confirmed shaped-not-generated (generator explicitly deferred to Phase 2, per RESEARCH Open Question 4); (6) build/test/migrate all green.
- **Flagged forward to Phase 2 planning** (per RESEARCH.md Pattern 3 and Pitfall 3): internal BigInt `id` fields serialize as JS `bigint`, which `JSON.stringify()`/Fastify's serializer cannot handle by default. Phase 2 (first phase to return these models in HTTP responses) must decide: (a) a global `BigInt.prototype.toJSON` shim, (b) a Prisma Client `result` extension stringifying BigInt fields on read, or (c) never returning internal `id` in API responses — only `public_id` — which this project's own id-strategy suggests is the cleanest fit. This decision is NOT made in Phase 1; it is explicitly raised here for the Phase 2 planner.
- **Flagged forward to Phase 2 planning:** the NanoID `public_id` generation seam (Prisma `$extends` query extension on `create` for House/Room/Device/Command, illustrated non-normatively in RESEARCH.md Pattern 2) still needs to be implemented — Phase 1 only shaped the `@unique VarChar(21)` column.
- No blockers. The complete target schema (existing auth tables + all ten new domain tables) is now locked and live in MariaDB, ready for Phase 2 entity CRUD to build on stable columns/indexes.

---
*Phase: 01-schema-data-conventions*
*Completed: 2026-07-07*

## Self-Check: PASSED

- FOUND: prisma/migrations/20260707094526_add_domain_schema/migration.sql
- FOUND: .planning/phases/01-schema-data-conventions/01-02-SUMMARY.md
- FOUND: a656d5b (Task 1 commit)
- FOUND: 9c0be44 (Task 2 commit)
- FOUND: 1a7aacb (Task 3 fix commit)
- FOUND: ddc752c (SUMMARY commit)
