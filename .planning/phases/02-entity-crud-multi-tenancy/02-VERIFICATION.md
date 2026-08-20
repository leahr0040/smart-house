---
phase: 02-entity-crud-multi-tenancy
verified: 2026-07-30T11:55:52Z
status: passed
score: 6/6 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 2: Entity CRUD & Multi-Tenancy Verification Report

**Phase Goal:** Users can fully manage their houses, rooms, and devices via REST; every ownership boundary is enforced; a per-type state detail row is created eagerly for every new device.
**Verified:** 2026-07-30T11:55:52Z
**Status:** passed
**Re-verification:** No — initial verification

**Test execution note:** This was NOT limited to static inspection. `npm run build` was re-run (exits 0, zero type errors) and the FULL test suite was executed against a live MariaDB instance via `npm test` (`tsc && node --test dist/src/test/**/*.test.js`). Result: **39/39 tests pass**, process exits cleanly, 0 failures. Every claim below is backed by a passing assertion in a real HTTP round-trip (`app.inject()`) against real Prisma/MariaDB reads and writes — not by SUMMARY.md narration.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can create/list/view/update/soft-delete own houses; cross-tenant `GET /houses/:id` → 404 not 403 | ✓ VERIFIED | `src/routes/houses/index.ts` full CRUD; `src/test/routes/houses.test.ts` — "POST /houses creates...", "GET /houses lists only...", "GET .../:id returns...", "PATCH .../:id updates...", "DELETE .../:id soft-deletes...", "cross-tenant access ... returns 404, not 403" — all pass live |
| 2 | User can create/list/update/soft-delete rooms in an owned house; soft-deleted rooms/houses excluded from all list responses | ✓ VERIFIED | `src/routes/rooms/index.ts`; `src/services/room.ts` (`createRoom` verifies parent house ownership via `findFirst` before insert); `rooms.test.ts` — nested create, list, update, soft-delete-exclusion, parent-ownership-bypass 404 all pass live |
| 3 | User can add a device of type light/AC/heater/sensor to an owned room; list/view by room and by house; update metadata; soft-delete | ✓ VERIFIED | `src/routes/devices/index.ts` (6 routes incl. by-room and by-house lists); `devices.test.ts` — create for all 4 types, by-room list, by-house list (aggregates across 2 rooms), get, patch, delete — all pass live |
| 4 | Per-type state detail row inserted with defaults immediately at device creation; device type fixed at creation; no state row created anywhere else in v1 | ✓ VERIFIED | `src/services/device.ts` `deviceStateConfig[type].createWithState` — a single nested `prisma.device.create({ data: { ...base, lightState: { create: {} } }, include: {...} })` per type; Prisma wraps nested writes in one implicit transaction (atomic, no separate write). Test "device create inserts exactly one matching per-type state row with defaults (STATE-01)" asserts all 4 types' defaults via direct Prisma reads — passes live. `updateDevice` destructures only name/manufacturer/model (grep-confirmed, no deviceType/stateType/stateId in update data); `PatchDeviceSchema` omits `deviceType` entirely (400 on inclusion via `additionalProperties:false`). Grep across `src/` confirms zero other `*State.create` call sites outside `deviceStateConfig` |
| 5 | TypeBox validates device type on creation (unknown → 400); every new endpoint returns 401 without valid JWT | ✓ VERIFIED | `CreateDeviceSchema` = `Type.Union(DEVICE_TYPES.map(Type.Literal))`; test "POST .../devices with an unknown device_type returns 400 (DEV-05)" passes live. All three test files include a dedicated 401 test iterating every route with (a) no token and (b) `Bearer definitelyfake` — all pass live (TEST-08) |
| 6 | Second authenticated user gets 404 for all resources they don't own; soft-deleted rows excluded from all reads; soft-deleted user cannot log in | ✓ VERIFIED | Cross-tenant 404 tests present and passing for houses, rooms, devices (incl. parent-ownership-bypass on nested creates); `readGuard` in `src/lib/prisma.ts` injects `deletedAt: null` on every read query for soft-deletable models; `auth.test.ts` "a soft-deleted user cannot log in" — 200 before delete, 401 after — passes live |

**Score:** 6/6 truths verified (0 present-but-behavior-unverified — every truth has a passing live-DB test, not just static presence)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/routes/houses/{index,schemas}.ts` | House CRUD routes + TypeBox schemas | ✓ VERIFIED | Full 5-route plugin; `prefixOverride=''`; response schemas on every route (`HouseResponseSchema`, no `id` field) |
| `src/services/house.ts` | Ownership-embedded service + cascade | ✓ VERIFIED | `createHouse/listHouses/getHouse/updateHouse/deleteHouse`; cascade uses `tx.device.updateMany`/`tx.room.updateMany`/`tx.house.updateMany` — zero `deleteMany` calls in the file (grep-confirmed) |
| `src/routes/rooms/{index,schemas}.ts` | Room CRUD incl. nested create | ✓ VERIFIED | 5 routes incl. `POST/GET /houses/:housePublicId/rooms`; response schema declares no `id`/`houseId` |
| `src/services/room.ts` | Parent-ownership check + cascade | ✓ VERIFIED | `createRoom` resolves house via `findFirst({publicId,userId})` before insert; `deleteRoom` cascades to devices + device state via `softDeleteDeviceStates`, direct `updateMany` only |
| `src/routes/devices/{index,schemas}.ts` | Device CRUD incl. by-room/by-house lists | ✓ VERIFIED | 6 routes; `DeviceResponseSchema` (no id/stateId — note: stateId doesn't exist at all post-refactor); `DeviceDetailResponseSchema` (state union) on GET/POST |
| `src/services/device.ts` (`deviceStateConfig`) | Exhaustive per-type state config | ✓ VERIFIED | `Record<DeviceType, {...}>` with exactly 4 entries (light/ac/heater/sensor), each with `createWithState`, `loadState`, `softDeleteState` — no catch-all dispatch |
| `src/test/routes/{houses,rooms,devices}.test.ts` | Live-DB integration tests | ✓ VERIFIED | 14 + 10 + 15 = 39 total tests across the phase (incl. `auth.test.ts` x2), all passing against real MariaDB |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `src/routes/houses/index.ts` | `src/services/house.ts` | direct function calls, `userId = BigInt(request.user.id)` | ✓ WIRED | Every ownership query embeds `{ publicId, userId }` |
| `src/routes/rooms/index.ts` | `src/services/room.ts` → parent `house` ownership check | `findFirst({ publicId: housePublicId, userId })` before insert | ✓ WIRED | Test "POST .../rooms against a house owned by another user returns 404" passes |
| `src/routes/devices/index.ts` | `src/services/device.ts` → parent `room` ownership check | `findFirst({ publicId: roomPublicId, userId })` before insert | ✓ WIRED | Test "POST .../devices against a room owned by another user returns 404" passes |
| `createDevice` → `deviceStateConfig[type].createWithState` | per-type state table | nested Prisma `create` (implicit transaction) | ✓ WIRED | State row exists with defaults immediately after create, confirmed live |
| `deleteHouse`/`deleteRoom`/`deleteDevice` | `softDeleteDeviceStates` | grouped `updateMany` per present type | ✓ WIRED | Mixed-type cascade tests (one device of each of the 4 types) confirm all 4 state tables get soft-deleted, not just one |
| `src/lib/prisma.ts` `readGuard` | every `findMany`/`findFirst`/`findUnique` on soft-deletable models | `$extends().query.$allModels` | ✓ WIRED | Soft-deleted rows excluded from all list/get reads (tested at every layer) |
| `src/lib/prisma.ts` `create` hook | `generatePublicId()` | `query()` continuation (tx-safe) | ✓ WIRED | Every created House/Room/Device carries a `publicId`; no `id` ever appears in any response (asserted per-test) |

### Data-Flow Trace (Level 4)

Not applicable in the UI-rendering sense (this is a REST API, no client-rendered views), but the equivalent check — "does the list/get endpoint return data sourced from a real query, not a static stub" — is satisfied: every list/get handler calls its service, which issues a real Prisma query (`findMany`/`findFirst` scoped by `userId`/`publicId`), and the live tests assert non-trivial returned data (correct `publicId`, correct nested state values, correct exclusion of other users' rows).

### Behavioral Spot-Checks / Full Test Run

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full phase test suite against live MariaDB | `npm test` | `tests 39, pass 39, fail 0` | ✓ PASS |
| Build (type-check) | `npm run build` | exit 0, zero errors | ✓ PASS |
| Debt-marker scan (TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER) across `src/` | grep | no matches | ✓ PASS |
| Morph-pointer (`stateType`/`stateId`) leftover check | grep across `src/`, `prisma/schema.prisma` | no matches | ✓ PASS (deliberate removal, documented in 02-04-SUMMARY.md and reflected in REQUIREMENTS.md DEV-05 wording) |

This satisfies Step 7b's constraint against re-running the full suite per must-have — the suite was run exactly once, and its output evidences all six roadmap truths simultaneously.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| HOUSE-01 | 02-02 | Create a house | ✓ SATISFIED | `POST /houses` test passes |
| HOUSE-02 | 02-02 | List/view own houses | ✓ SATISFIED | `GET /houses`, `GET /houses/:id` tests pass |
| HOUSE-03 | 02-02 | Update owned house | ✓ SATISFIED | `PATCH /houses/:id` test passes |
| HOUSE-04 | 02-02 | Soft-delete owned house | ✓ SATISFIED | `DELETE /houses/:id` + cascade tests (incl. mixed-type state cascade) pass |
| HOUSE-05 | 02-02 | Cross-tenant → 404 not 403 | ✓ SATISFIED | dedicated cross-tenant test passes |
| ROOM-01 | 02-03 | Create room in owned house | ✓ SATISFIED | nested-create + parent-ownership-bypass tests pass |
| ROOM-02 | 02-03 | List rooms in owned house | ✓ SATISFIED | `GET /houses/:id/rooms` test passes |
| ROOM-03 | 02-03 | Update owned room | ✓ SATISFIED | `PATCH /rooms/:id` test passes |
| ROOM-04 | 02-03 | Soft-delete owned room | ✓ SATISFIED | `DELETE /rooms/:id` + device cascade tests pass |
| DEV-01 | 02-04 | Add typed device to owned room | ✓ SATISFIED | create test for all 4 types passes |
| DEV-02 | 02-04 | List/view devices by room and house | ✓ SATISFIED | by-room, by-house, by-id tests pass |
| DEV-03 | 02-04 | Update device metadata | ✓ SATISFIED | `PATCH /devices/:id` test passes |
| DEV-04 | 02-04 | Soft-delete device | ✓ SATISFIED | `DELETE /devices/:id` + state-cascade test passes |
| DEV-05 | 02-04 | Per-type state tables, TypeBox-validated, no morph pointer | ✓ SATISFIED | schema has no `stateType`/`stateId`; `@@unique([deviceId])` per state table; union-literal TypeBox validation; unknown-type-400 test passes |
| STATE-01 | 02-04 | Eager per-type state row in same transaction as device create | ✓ SATISFIED | nested-create (Prisma implicit tx) test passes for all 4 types with correct defaults |
| TEST-01 | 02-02/03/04 | Second-user 404 for every ownership-scoped endpoint | ✓ SATISFIED | present in all 3 test files, incl. nested-create bypass cases |
| TEST-05 | 02-01/02/03/04 | Soft-delete exclusion + soft-deleted user cannot log in | ✓ SATISFIED | `auth.test.ts` + exclusion assertions in all 3 CRUD test files |
| TEST-08 | 02-02/03/04 | 401 without valid JWT on every new endpoint | ✓ SATISFIED | dedicated 401 test (missing + invalid token) in all 3 test files |

**No orphaned requirements found.** Cross-referencing `.planning/REQUIREMENTS.md`'s Traceability table (all 18 IDs marked "Phase 2") against the four plans' `requirements:` frontmatter confirms every ID is claimed by at least one plan, and every claim above is independently test-verified.

### Anti-Patterns Found

None. Grep for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER|not yet implemented|coming soon` across `src/` returned zero matches. No stub returns (`return null`/`return {}`/`return []` used only in legitimate null-means-404 or empty-array-means-no-rows contexts, all backed by real queries). No console.log-only handlers. No hardcoded empty props feeding responses — every response producer (`toHouseResponse`, `toRoomResponse`, `toDeviceResponse`, `toDeviceDetailResponse`) reads from the real DB row passed in.

### Deviation from Plan (documented, not a gap)

02-04-SUMMARY.md documents a mid-phase design change: the originally-planned `stateType`/`stateId` "morph pointer" columns on `Device` were dropped in favor of the state being located via each state table's own unique `device_id` + the device's `deviceType` string. This is reflected consistently across `prisma/schema.prisma`, `src/services/device.ts`, `src/lib/prisma.ts` (`modelConfig`), `src/routes/devices/schemas.ts`, and `.planning/REQUIREMENTS.md`'s DEV-05 wording ("no morph pointer column on the device") — i.e., REQUIREMENTS.md was updated to match the implementation, and the implementation satisfies the requirement as currently written. No leftover references to the old design were found anywhere in the codebase. This is a legitimate architecture simplification, not an unresolved gap, and does not need an override entry since it doesn't reduce scope — the eager-state invariant (STATE-01) is still met, just via a single nested `create` instead of a create+update pair.

### Human Verification Required

None. Every observable truth is covered by a live, passing integration test against a real MariaDB instance — not merely static presence/wiring checks.

### Gaps Summary

No gaps. All 6 roadmap success criteria and all 18 requirement IDs (HOUSE-01..05, ROOM-01..04, DEV-01..05, STATE-01, TEST-01, TEST-05, TEST-08) are satisfied with live-test evidence. Build is clean. No debt markers. No orphaned requirements. Phase goal is achieved.

---

_Verified: 2026-07-30T11:55:52Z_
_Verifier: Claude (gsd-verifier)_
