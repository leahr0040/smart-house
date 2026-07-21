---
phase: 02-entity-crud-multi-tenancy
plan: 02
subsystem: house-slice
tags: [rest, crud, typebox, multi-tenancy, soft-delete, cascade, test-isolation]
status: complete

requires:
  - 02-01 (extended prisma client, publicId create hook, test factories, closeDb)
provides:
  - House CRUD REST slice (POST/GET /houses, GET/PATCH/DELETE /houses/:housePublicId)
  - src/services/house.ts (ownership-embedded queries + transactional cascade soft-delete)
  - the reference pattern the Room and Device slices mirror
  - test database isolation (.env.testing + resetDb) for every DB-touching test
affects:
  - 02-03 (room slice — mirrors this slice's route/service/test shape)
  - 02-04 (device slice — same)

tech-stack:
  added: []
  patterns:
    - "prefixOverride = '' — routes declare absolute paths; autoload would otherwise mount them at /houses/houses"
    - "TypeBox response schema per route (additionalProperties:false, publicId only) — the BigInt id is structurally unserializable, not merely omitted by discipline"
    - "cascade soft-delete via direct tx.*.updateMany inside $transaction — never tx.*.delete()"
    - "guarded writes: the extension injects deletedAt:null into update/updateMany too (not just reads); a write to a dead/cross-tenant row → P2025 → 404, so updateHouse needs no pre-read"
    - "upsert is blocked on soft-deletable models (a dead row still holds the unique public_id → P2002)"
    - "PATCH hands the validated body straight to Prisma — additionalProperties:false + ajv removeAdditional strip hostile keys, so mass assignment is unreachable without field-by-field copying"
    - "deleteHouse returns boolean (existed-and-deleted), not the pre-delete row"
    - "cascade assertions read through prismaRaw so soft-deleted rows are visible (readGuard would give a false green)"
    - "tests run against a dedicated database (.env.testing), truncated between tests, test files serialized (--test-concurrency=1) so one file's truncate can't wipe another's rows"

key-files:
  created:
    - src/routes/houses/schemas.ts
    - src/routes/houses/index.ts
    - src/services/house.ts
    - src/test/routes/houses.test.ts
    - src/test/env.ts
  modified:
    - src/test/helper.ts
    - src/test/helpers/fixtures.ts
    - src/test/routes/auth.test.ts
    - .gitignore

decisions:
  - "Cross-tenant miss returns 404, not 403 — ownership is embedded in the where clause, so 'not yours' and 'does not exist' are the same null"
  - "Test suite moved off the shared dev DB onto a dedicated smart_house_testing database, truncated per test (scope beyond this plan; adopted deliberately)"
  - "PATCH relies on schema stripping (additionalProperties:false + ajv removeAdditional), not field-by-field copying — the hostile-key case was proven unreachable with a throwaway probe"
  - "updateHouse is a single guarded update (extendedWhereUnique + P2025→404), no pre-read; deleteHouse returns boolean"
  - "Extension hardened during review: update/updateMany carry the read guard; upsert throws on soft-deletable models"
  - "Comment style pass: how-narration removed repo-wide, only short why-notes kept (user preference)"

metrics:
  duration: ~1h
  tasks: 3
  files: 9
  completed: 2026-07-14
---

# Phase 2 Plan 02: House CRUD Vertical Slice Summary

The full House slice end-to-end — TypeBox-validated routes, an ownership-embedded
service, a transactional cascade soft-delete, and multi-tenancy (404-not-403) plus
auth (401) enforced and tested on every route. This is the reference slice that the
Room and Device slices mirror.

## What Was Built

| Artifact | Purpose |
|---|---|
| `src/routes/houses/schemas.ts` | TypeBox `CreateHouseSchema` / `PatchHouseSchema` (`additionalProperties:false`), `HouseParamsSchema`, and `HouseResponseSchema` — publicId + safe metadata only, no `id` |
| `src/routes/houses/index.ts` | `FastifyPluginAsyncTypebox`; `prefixOverride = ''`; POST/GET `/houses`, GET/PATCH/DELETE `/houses/:housePublicId`; every route carries `preHandler: fastify.authenticate` and a response schema |
| `src/services/house.ts` | `createHouse`, `listHouses`, `getHouse`, `updateHouse` (single guarded update), `deleteHouse` (transactional cascade, returns boolean) |
| `src/test/routes/houses.test.ts` | integration tests via `build(t)` + `app.inject()` (11 house tests; 14 in the full suite) |
| `src/test/env.ts` | Points the suite at the test database; hard-fails if `.env.testing` is missing |

**Multi-tenancy is one mechanism, not a check.** Every read/update/delete resolves
`where: { publicId, userId }`. A house owned by another user and a house that does
not exist both come back `null`, and the route turns `null` into 404. There is no
code path that can return 403, so there is nothing to accidentally leak existence
through.

**The BigInt id cannot leak.** Two independent layers: `HouseResponseSchema`
declares only `publicId` + safe metadata with `additionalProperties:false`, so
fast-json-stringify structurally cannot emit an undeclared `id`; and every handler
still builds its response object field by field rather than sending a raw Prisma row.

**PATCH does not copy fields by hand.** The validated body is passed straight to
Prisma. `PatchHouseSchema` declares `additionalProperties:false`, and Fastify's ajv
runs `removeAdditional:true`, so a client's `userId`/`deletedAt` is stripped from the
body before the handler sees it — mass assignment is unreachable. A throwaway probe
confirmed a PATCH carrying another user's `userId` and a `deletedAt` wrote neither.

**The cascade stays inside its transaction.** `deleteHouse` calls
`tx.device.updateMany` / `tx.room.updateMany` / `tx.house.updateMany` directly. It
never calls `tx.*.delete()`: the extension's delete→update conversion re-dispatches
through a separately captured, un-extended client, which does not join the active
transaction — the cascade would have silently run outside it.

## Tasks & Commits

| Task | Commit | Notes |
|---|---|---|
| 1. Scaffold (schemas, service signatures, route stubs) | `f30d5c2` | `npm run build` green |
| — Test DB isolation | `e719a47` | Scope beyond this plan — see deviations |
| 2. Tests (red) | `d0c3ec7` | 8 tests, red against TODO handlers (500s) |
| 3. Implement service to green | `dca45b2` | House slice 8/8; full suite 11/11 |

## Test Coverage

| Requirement | Test |
|---|---|
| HOUSE-01/02/03 | create → 201 (`publicId` present, no `id`); list (bare array, D-02); get; patch (omitted fields untouched) |
| HOUSE-04 | cascade: 2 rooms + 2 devices seeded under the house, DELETE → all soft-deleted |
| HOUSE-05 / TEST-01 | cross-tenant GET/PATCH/DELETE → **404** and the house is verifiably unmutated |
| TEST-05 | soft-deleted house absent from `GET /houses` and 404 on `GET /houses/:id` |
| TEST-08 | all five routes → 401 for **both** a missing token and `Bearer definitelyfake` |

The cascade test reads the children back through `prismaRaw` (the un-extended client)
and asserts `deletedAt` is **set** — not that the rows vanished. Reading through the
extended `prisma` would have hidden soft-deleted rows behind `readGuard` and passed
whether the cascade ran or the rows never existed at all.

## Deviations from Plan

### 1. [Rule 4 → user-approved] Test suite moved to a dedicated database

**Raised during:** Task 2, at the user's request. Initially declined by the
orchestrator as out of scope, then reviewed and adopted.

**Issue:** every DB-touching test ran against the dev database named by `.env` and
left its rows behind. Plan 02-01's research had identified this (Pitfall 5) and
deliberately deferred it; the cost was that tests had to be written defensively
around a dirty, shared database.

**Change:**
- `src/test/env.ts` loads `.env.testing` with `override: true` and **hard-fails**
  if the file is absent — it never silently falls back to the dev database. It is
  imported first by `helper.ts` and `fixtures.ts`, because `src/lib/env.ts` runs
  `dotenv/config` at module load and dotenv will not overwrite variables already set.
- `fixtures.ts` gains `resetDb()`, truncating every table (listed explicitly, per
  CLAUDE.md's explicit-over-magic rule). `relationMode="prisma"` means MariaDB holds
  no FK constraints, so truncation order is irrelevant.
- `auth.test.ts` and `houses.test.ts` both call `beforeEach(resetDb)`.
- `.gitignore` widened to `.env.*` (with `!.env.example`) so test DB credentials
  cannot be committed.

**ONBOARDING CHANGE — new requirement for anyone running the suite:** a `.env.testing`
must exist at the repo root (`DATABASE_URL` pointing at a **separate** database, plus
`JWT_SECRET`), and that database must be migrated. The database used here is
`smart_house_testing`, created by loading `.env.testing` and running
`prisma migrate deploy`. Without the file the suite refuses to start rather than
touching dev data. **This is not yet documented in CLAUDE.md/README — see follow-ups.**

**Commit:** `e719a47`

### 2. [Rule 3 — blocking] Scaffold could not compile with bare `// TODO` bodies

The strict tsconfig (`noUnusedParameters`, `noImplicitReturns`) rejects a stub whose
parameters are unused. Scaffold functions therefore take `_`-prefixed parameters and
`throw new Error('not implemented')`, with explicit `Promise<House | null>` return
types so the route handlers type-check against the real shape before the bodies exist.
Resolved within Task 1; no impact on the delivered code.

## Known Issues / Follow-ups

- **Document the `.env.testing` requirement.** CLAUDE.md's Commands section and the
  README still imply `npm test` works with only `.env`. Both should state that the
  suite needs `.env.testing` + a migrated test database. An `.env.example` (now
  un-ignored by the `!.env.example` rule) and a `prisma:migrate:test` npm script are
  the obvious ways to make this self-service. Not done here — outside this plan's
  file set.
- **Legacy `/auth` responses still leak `Number(user.id)`** (carried over from 02-01).
  The new house routes do not; the auth routes remain to be migrated.
- **`src/routes/auth/schemas.ts` is still raw `as const` JSON Schema**, not TypeBox —
  untouched, per the "migrate when touched" rule.
- **Room and Device slices should copy this slice verbatim** — the `prefixOverride`,
  response-schema, ownership-query, and cascade patterns are all load-bearing.

## Verification

- `npm run build` — exits 0
- `node --test dist/src/test/routes/houses.test.js` — 8/8 pass
- `npm test` — 14/14 pass, **exit 0, process exits cleanly** (~20s); stable across repeated runs with `--test-concurrency=1`
- `deleteHouse` cascade uses `tx.*.updateMany` inside `$transaction`; no `tx.*.delete()` call
- `HouseResponseSchema` declares no `id`; create/get responses assert `!('id' in body)`
- Cross-tenant GET/PATCH/DELETE → 404 (not 403); no-token and invalid-token → 401
