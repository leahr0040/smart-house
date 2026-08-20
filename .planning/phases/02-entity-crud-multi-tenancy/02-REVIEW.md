---
phase: 02-entity-crud-multi-tenancy
reviewed: 2026-07-30T13:27:58Z
depth: standard
files_reviewed: 20
files_reviewed_list:
  - prisma/migrations/20260707094526_add_domain_schema/migration.sql
  - prisma/schema.prisma
  - src/lib/nanoid.ts
  - src/lib/prisma.ts
  - src/routes/devices/index.ts
  - src/routes/devices/schemas.ts
  - src/routes/houses/index.ts
  - src/routes/houses/schemas.ts
  - src/routes/rooms/index.ts
  - src/routes/rooms/schemas.ts
  - src/services/device.ts
  - src/services/house.ts
  - src/services/room.ts
  - src/test/env.ts
  - src/test/helper.ts
  - src/test/helpers/fixtures.ts
  - src/test/routes/auth.test.ts
  - src/test/routes/devices.test.ts
  - src/test/routes/houses.test.ts
  - src/test/routes/rooms.test.ts
findings:
  critical: 0
  warning: 2
  info: 4
  total: 6
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-07-30T13:27:58Z
**Depth:** standard
**Files Reviewed:** 20
**Status:** issues_found

## Summary

This phase adds House / Room / Device CRUD with per-user tenancy, a soft-delete +
public-id minting Prisma client extension, and per-type device state cascades. The
implementation is careful and unusually well-tested: cross-tenant isolation (404-not-403),
soft-delete guarding, atomic cascade deletes, and the VARCHAR→union device-type seam all
have dedicated tests, and the tenancy boundary (ownership verified on the parent before
every insert, denormalized `userId` on every row) holds up under tracing.

I verified several things that initially looked suspicious and cleared them:

- **`PATCH` stripping `deviceType`** (devices/schemas.ts:17) relies on Fastify's default
  ajv `removeAdditional: true`; since `app.ts` supplies no custom ajv options, the default
  applies and the extra field is silently dropped — the co-located test's `200` expectation
  is correct, and `deviceType` can never reach the update. Not a bug.
- **`update({ where: { publicId, userId } })` + readGuard adding `deletedAt: null`** is valid
  under Prisma 7's GA extended-where-unique (a unique field is present); non-matching filters
  yield P2025 → `null` → 404, exactly as tested. Not a bug.
- **App-side public-id minting vs. the `@default(nanoid(21))`** — the engine-side default is a
  genuine fallback (Prisma 7 mints `nanoid()` in the query engine), so unhooked create paths
  still get an id. No NULL-insert failure.

No security vulnerabilities or data-loss defects were found. The remaining findings are a
latent gap in the client-extension's operation coverage, one input-validation bound, and
maintainability items.

## Warnings

### WR-01: Client-extension guard coverage is incomplete for `*ManyAndReturn` operations

**File:** `src/lib/prisma.ts:71-104`
**Issue:** The `$allModels` query hooks enumerate a fixed set of operations
(`findUnique`…`groupBy`, `create`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`).
Prisma's `updateManyAndReturn` (and `createManyAndReturn`) are **not** intercepted. For a
soft-deletable model, a future caller using `updateManyAndReturn` would bypass `readGuard`
entirely and can read/return soft-deleted rows — the same tenant/soft-delete boundary the
extension exists to enforce. `upsert` was explicitly hardened with a throw, but these
siblings were left silent. None are called today, so this is latent, but the extension
presents itself as a universal guard and a new caller would get an unguarded escape by
accident.
**Fix:** Either add hooks for the `*ManyAndReturn` operations, or make the closed set
explicit and fail loudly on the unhandled ones, mirroring the `upsert` guard:
```ts
updateManyAndReturn({ model, args, query }) { return query(readGuard(model, args)) },
createManyAndReturn({ model, args, query }) {
  if (!needsPublicId(model)) return query(args)
  // …mint publicId per row, then query(withData)
}
```

### WR-02: `floor` accepts unbounded integers → 500 instead of 400 on out-of-range input

**File:** `src/routes/rooms/schemas.ts:7,17`
**Issue:** `floor: Type.Integer()` (both create and patch) has no `minimum`/`maximum`. The
column is a MySQL `INT` (4-byte, migration.sql:24). A client sending
`floor: 3000000000` (or a large negative) passes validation, reaches Prisma, and MySQL
rejects it as out-of-range — surfacing as a 500 rather than a clean 400. `floor` is the only
client-settable integer this phase (brightness/targetTemp are server defaults), so the blast
radius is small, but user input should not be able to force a 500.
**Fix:** Bound the schema to the column's range, e.g.
`Type.Integer({ minimum: -128, maximum: 1000 })` (pick a sane building-floor range) or at
minimum the INT32 bounds `{ minimum: -2147483648, maximum: 2147483647 }`.

## Info

### IN-01: Reflection dispatch in `softDelete` contradicts the project style rule

**File:** `src/lib/prisma.ts:49`
**Issue:** `const delegate = (base as Record<string, any>)[lowerFirst(model)]` is exactly the
`(x as Record<string, any>)[name]` reflection-dispatch pattern CLAUDE.md's code-style section
tells contributors to avoid in favor of an enumerated/explicit form. The rest of the file
(the `modelConfig` `Record<Prisma.ModelName, …>`) follows the enumerated approach; this one
spot breaks it.
**Fix:** Resolve the delegate through a typed, enumerated map keyed by `Prisma.ModelName`
rather than string-indexing the client, or document why the reflection is unavoidable here.

### IN-02: Near-identical cascade-delete bodies in `house.ts` and `room.ts`

**File:** `src/services/house.ts:55-67`, `src/services/room.ts:76-88`
**Issue:** The "fetch live devices → `softDeleteDeviceStates` → `updateMany` the exact device
ids" block is duplicated almost verbatim between `deleteHouse` and `deleteRoom`, including the
identical explanatory comment. Duplication means a future fix to the cascade (e.g. adding a
new child entity) must be applied in two places or they drift.
**Fix:** Extract a shared helper, e.g.
`cascadeSoftDeleteDevices(tx, where: { houseId?: bigint; roomId?: bigint }, now: Date)`, and
call it from both services.

### IN-03: PATCH schemas cannot clear nullable fields back to null

**File:** `src/routes/houses/schemas.ts:13-19`, `src/routes/rooms/schemas.ts:14-21`, `src/routes/devices/schemas.ts:19-26`
**Issue:** `address`, `roomType`, `manufacturer`, and `model` are nullable columns, but their
PATCH schemas type them as non-null `String` only. Once set, a client has no way to clear
them back to `null` via PATCH. This is a product/API-completeness gap rather than a defect,
but worth a conscious decision.
**Fix:** If clearing should be supported, allow null, e.g.
`manufacturer: Type.Union([Type.String({ maxLength: 191 }), Type.Null()])`, and pass it
through to the update.

### IN-04: A single corrupt `device_type` fails the entire collection read, not just one row

**File:** `src/lib/prisma.ts:57-69`, `src/services/device.ts:198,205`
**Issue:** The result-extension `compute` throws on an unknown `device_type`. This is the
intended "fail loud" seam and is tested for the single-device GET (devices.test.ts:380).
However, `listDevicesByRoom` / `listDevicesByHouse` return the raw array and the route runs
`devices.map(toDeviceResponse)`, which touches `.deviceType` on every element — so one
corrupt row makes `GET /houses/:id/devices` and `GET /rooms/:id/devices` return 500 for the
**whole** list, hiding every healthy device in that scope. The design trade-off is deliberate,
but the collection-level blast radius is broader than the documented single-row case.
**Fix:** Accept as-is if fail-loud-wide is intended; otherwise consider isolating the
validation per row (skip + log the corrupt one) so a single bad row can't blank an entire
listing.

---

_Reviewed: 2026-07-30T13:27:58Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
