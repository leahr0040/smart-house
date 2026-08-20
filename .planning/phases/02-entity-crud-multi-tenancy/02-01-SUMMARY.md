---
phase: 02-entity-crud-multi-tenancy
plan: 01
subsystem: foundation
tags: [prisma, typebox, nanoid, public-id, test-fixtures, soft-delete]
status: complete

requires: []
provides:
  - generatePublicId (src/lib/nanoid.ts)
  - public_id create hook on the extended prisma client
  - TypeBox toolchain (@sinclair/typebox + @fastify/type-provider-typebox)
  - test factories (createTestUser, createTwoTestUsers, seedHouse, seedRoom, seedDevice)
  - closeDb() teardown for DB-touching tests
affects:
  - 02-02 (house slice)
  - 02-03 (room slice)
  - 02-04 (device slice)

tech-stack:
  added:
    - "@sinclair/typebox@0.34.52 (CJS-native; no engines.node floor)"
    - "@fastify/type-provider-typebox@5.2.0 (peer-matched to typebox 0.34)"
    - "nanoid@3.3.16 (CJS-native line)"
    - "@faker-js/faker@10.5.0 (devDependency — test data only)"
  patterns:
    - "exhaustive Record<Prisma.ModelName, {softDelete, publicId}> — tsc enforces completeness"
    - "create hook mints public_id via the query() continuation (tx-safe)"
    - "test factories: required FKs positional, everything else overridable"

key-files:
  created:
    - src/lib/nanoid.ts
    - src/test/helpers/fixtures.ts
    - src/test/routes/auth.test.ts
  modified:
    - src/lib/prisma.ts
    - prisma/schema.prisma
    - package.json

decisions:
  - "public_id typing resolved with @default(nanoid(21)) as a type-level affordance; the app-side CSPRNG hook still supplies every value"
  - "faker for test realism, uuid suffix for uniqueness (users.email is @unique)"
  - "publicId create-hook tests dropped at user request"

metrics:
  duration: ~2h
  tasks: 4
  files: 6
  completed: 2026-07-13
---

# Phase 2 Plan 01: Foundation & Shared Seam Summary

Stood up the Phase 2 toolchain (TypeBox + nanoid), wired the app-side `public_id`
minting hook into the existing extended Prisma client, and built the shared test
factories every Wave 2 slice depends on — plus the first auth test (a soft-deleted
user cannot log in).

## What Was Built

| Artifact | Purpose |
|---|---|
| `src/lib/nanoid.ts` | `generatePublicId()` — 21-char CSPRNG id, fits `@db.VarChar(21)` |
| `src/lib/prisma.ts` | `modelConfig` widened to `{softDelete, publicId}` (exhaustive over all 12 models); `needsPublicId()` predicate; new `create` handler on the existing `$allModels` extension |
| `src/test/helpers/fixtures.ts` | Factories: `createTestUser`, `createTwoTestUsers`, `seedHouse`, `seedRoom`, `seedDevice`, plus `closeDb()` |
| `src/test/routes/auth.test.ts` | TEST-05 auth clause — soft-deleted user gets 401 on login |
| `prisma/schema.prisma` | `@default(nanoid(21))` on the four `public_id` columns (type-level only) |

The `create` hook injects `publicId` through the `query()` continuation rather than
the captured `base` delegate that `softDelete()` uses, so minting composes correctly
inside `$transaction` (T-2-03). Verified empirically before the type work landed:
21-char ids, distinct per row, firing on the tx client, and correctly skipped for
models with no `public_id` column.

## Tasks & Commits

| Task | Commit | Notes |
|---|---|---|
| 1. Package legitimacy gate | — | Blocking-human gate; approved. No artifacts |
| 2. Install deps + regenerate client | `94c166d` | Regen was a verified no-op |
| 3. NanoID minter + create hook | `b26200e` | Runtime-proven before commit |
| — Option A typing fix | `5d99c4f` | See deviations |
| 4. Factories + auth test | `669a5cc` | Suite passes **and exits** |

## Deviations from Plan

### 1. [Rule 4 — Architectural, user-decided] `public_id` was required in Prisma's create input

**Found during:** Task 3 (RED step) — surfaced by the failing test, before any
service code was written.

**Issue:** A Prisma `query` extension mints `publicId` at **runtime** but does not
change the **static** create-input type. So the call shape used verbatim throughout
`02-PATTERNS.md`, `02-RESEARCH.md`, and all three Wave 2 slice plans did not compile:

```
prisma.house.create({ data: { userId, name } })
// TS2322: Property 'publicId' is missing in type ... but required in HouseUncheckedCreateInput
```

This would have blocked 02-02, 02-03, and 02-04 identically. The plan did not
anticipate it.

**Resolution (Option A, user-approved):** Added `@default(nanoid(21))` to the four
`public_id` columns as a **type-level affordance only**. A defaulted field is
optional in Prisma's create input, so callers never pass `publicId` and no casts are
needed — every Wave 2 call site compiles verbatim with zero churn.

Load-bearing details for the verifier:
- **The column is NOT nullable.** Confirmed at all three layers: DB column is
  `NOT NULL varchar(21)`; the Prisma read type is `publicId: string`; the create
  input is `publicId?: string` (optional to *omit*, cannot be `null` — contrast
  `address?: string | null` in the same generated type).
- **The app-side hook still supplies every value.** It sets `publicId` in the create
  args on every call, so Prisma's engine-side Rust `nanoid()` never actually fires.
  **T-2-01 remains satisfied by the existing, verified CSPRNG minter** regardless of
  what the query engine uses internally. The hook was deliberately kept, not deleted.
- **No database change, no migration.** Verified via `prisma migrate dev --create-only`,
  which produced *"This is an empty migration"* (30 bytes, zero SQL): Prisma mints
  these defaults in the query engine, so no SQL `DEFAULT` is emitted. The probe
  migration directory was deleted rather than committed. The plan's prohibition
  ("no new migration directory") is upheld — still exactly three migrations.

**Commit:** `5d99c4f`

### 2. [Rule 3 — Blocking] DB-touching tests hung `npm test` forever

**Found during:** Task 3 verification.

**Issue:** Prisma's connection pool keeps the Node event loop alive. A DB-touching
test file ran all assertions **green** and then never exited — it hung for 657s
before being killed. Left unfixed, this would have hung CI permanently the moment
Task 4's fixtures landed, and would have bitten every Wave 2 slice test file.

**Fix:** Added `closeDb()` to `fixtures.ts`; each DB-touching file calls
`after(closeDb)`. Homing it in the shared fixtures module means 02-02/03/04 inherit
the fix rather than each rediscovering the hang. `npm test` now exits cleanly (34s,
exit code 0).

**Commit:** `669a5cc`

### 3. [User-directed] Test data via faker factories

**Requested by user during execution.** Fixtures were built as factories (required
FKs positional, everything else overridable) using `@faker-js/faker` (devDependency,
verified: `faker-js` org, no `postinstall`).

**Caveat encoded in the code:** faker's name/email pool is small and repeats, and
`users.email` is `@unique` — faker alone would eventually throw P2002. Emails
therefore carry a uuid suffix: realism from faker, uniqueness from the uuid.

### 4. [User-directed] public_id create-hook tests dropped

The Task 3 TDD tests (21-char minting, distinctness, tx-safety, no-publicId-on-
RefreshToken) were written and passed **green** against the implemented hook, then
removed at the user's explicit request ("no need publicid tests").

**Coverage note for the verifier:** the create hook is consequently **not covered by
an automated test**. Its behavior was verified manually during execution (all four
behaviors confirmed, including the tx-safe continuation). The Wave 2 slice tests
will exercise it indirectly, since every `seedHouse`/`seedRoom`/`seedDevice` call
depends on the hook minting a valid `publicId`.

### 5. Prisma regeneration was a no-op; dev DB was already correct

Task 2 was marked `[BLOCKING]` to prevent a false-positive verification state (build
passing from the committed schema while the live table lacked `house_id`). Checked
directly against the database: the live `devices` table already had `house_id` **and**
`devices_house_id_idx`, the committed generated client already carried `houseId`, and
`migrate status` reported no drift.

Consequence: **the destructive `prisma migrate reset` fallback was never needed** and
was not run — no dev data was lost.

## Known Issues / Follow-ups

- **Zombie tests removed from `dist/`.** `npm test` was previously executing two
  compiled tests (`support works standalone`, `example is loaded`) whose **source
  files no longer exist** anywhere in `src/`. They were stale artifacts in `dist/`
  from long-deleted sources. Clearing `dist` removed them; the true suite is 3 tests
  across 2 files. Not caused by this plan — flagged because it means the previously
  reported "3 passing tests" included 2 phantoms.
- **Legacy `src/routes/auth/schemas.ts` remains raw `as const` JSON Schema**, not
  TypeBox — untouched by this plan, per its stated prohibition.
- **The legacy `/auth` responses still leak `Number(user.id)`.** This is the
  internal-id leak the phase exists to eliminate; the new fixtures deliberately do
  **not** depend on that field (they re-resolve the bigint id via a direct lookup).
  Remediation belongs to the Wave 2 slices / a follow-up.

## Verification

- `npm run build` — exits 0
- `npm test` — 3/3 pass **and the process exits** (exit code 0, 34s)
- `npx prisma validate` — schema valid
- `npx prisma migrate status` — 3 migrations, database up to date, no drift
- `npm ls @sinclair/typebox @fastify/type-provider-typebox nanoid` — all resolved,
  no UNMET, no peer warnings; `@sinclair/typebox@0.34.52` deduped under the provider
- `package.json` contains **no** `engines.node` floor (all three deps CJS-native)
- `prisma/migrations/` contains exactly the original three directories

## Self-Check: PASSED
