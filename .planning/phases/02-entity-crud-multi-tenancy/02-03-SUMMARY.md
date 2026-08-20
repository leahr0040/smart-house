---
phase: 02-entity-crud-multi-tenancy
plan: 03
subsystem: room-slice
tags: [rest, crud, typebox, multi-tenancy, soft-delete, cascade, nested-resource]
status: complete

requires:
  - 02-01 (extended prisma client, publicId create hook, test factories, closeDb)
  - 02-02 (house slice — the reference shape this slice mirrors; nullIfNotFound, toResponse producer, test-DB isolation)
provides:
  - Room CRUD REST slice (nested create/list under a house; get/patch/delete by room publicId)
  - src/services/room.ts (ownership-embedded queries, parent-verified create, room→devices cascade)
affects:
  - 02-04 (device slice — nests under a room the same way this nests under a house)

tech-stack:
  added: []
  patterns:
    - "nested create/list under /houses/:housePublicId/rooms; get/patch/delete address the room directly by its own publicId"
    - "createRoom verifies parent-house ownership (findFirst {publicId, userId}) before inserting; missing/unowned/dead parent → null → 404, never an orphan"
    - "no transaction around createRoom — a single write has nothing to make atomic and wouldn't close the parent-deleted-mid-insert race without FOR UPDATE (declined)"
    - "listRooms 404s when the parent house isn't owned — no 403 existence leak"
    - "mirrors house slice verbatim: toRoomResponse producer, nullIfNotFound guarded update, boolean delete, deletedAt:null-guarded cascade inside $transaction"

key-files:
  created:
    - src/routes/rooms/schemas.ts
    - src/routes/rooms/index.ts
    - src/services/room.ts
    - src/test/routes/rooms.test.ts

decisions:
  - "createRoom keeps a pre-read ownership check rather than insert-and-catch: relationMode=prisma means no FK, so a bad houseId inserts silently (no error to catch), and an FK checks existence not ownership anyway"
  - "Transaction removed from createRoom (single write); kept in deleteRoom where the room→devices cascade is multiple writes that must be all-or-nothing"

metrics:
  tasks: 3
  files: 4
  completed: 2026-07-21
---

# Phase 2 Plan 03: Room CRUD Vertical Slice Summary

The Room slice, mirroring the House reference slice. Rooms are nested under a parent
house: create and list live under `/houses/:housePublicId/rooms` and require the
parent; get/patch/delete address a room directly by its own `publicId`. Multi-tenancy
(404-not-403) and auth (401) are enforced and tested on every route.

## What Was Built

| Artifact | Purpose |
|---|---|
| `src/routes/rooms/schemas.ts` | TypeBox `CreateRoomSchema` / `PatchRoomSchema` (`additionalProperties:false`), param schemas, `RoomResponseSchema` (publicId + safe metadata, no `id`), and a `toRoomResponse` producer kept next to the schema |
| `src/routes/rooms/index.ts` | `prefixOverride = ''`; nested POST/GET under `/houses/:housePublicId/rooms`; GET/PATCH/DELETE `/rooms/:roomPublicId`; every route has `preHandler: fastify.authenticate` + a response schema and calls `toRoomResponse` |
| `src/services/room.ts` | `createRoom` (parent-verified), `listRooms` (parent-verified), `getRoom`, `updateRoom` (`nullIfNotFound`), `deleteRoom` (transactional cascade, boolean) |
| `src/test/routes/rooms.test.ts` | integration tests via `build(t)` + `app.inject()` |

**A room can never be orphaned.** `createRoom` resolves the parent house by
`{ publicId, userId }` first; a house that is missing, soft-deleted, or owned by
another user comes back null and the route returns 404. This is multi-tenancy
enforcement, not a redundant existence check — `relationMode="prisma"` means the DB
has no foreign key, so a bad `houseId` would otherwise insert silently.

**The cascade stays inside its transaction.** `deleteRoom` soft-deletes the room's
devices then the room via `tx.*.updateMany` (each guarded with `deletedAt: null`),
never `tx.*.delete()`. `createRoom` is deliberately *not* transactional: one write has
nothing to make atomic, and without `FOR UPDATE` a transaction would not close the
parent-deleted-mid-insert race (that race was reviewed and left open by decision).

## Tasks & Commits

| Task | Commit | Notes |
|---|---|---|
| 1. Scaffold (schemas, service signatures, route stubs) | `e2cdf46` | build green |
| 2. Tests (red) | `84ff171` | failing against stub handlers |
| 3. Implement service to green | `bdbc87b` | includes review edits (transaction removed from createRoom) |

## Test Coverage

| Requirement | Test |
|---|---|
| ROOM-01/02/03 | nested create → 201 (publicId, no id); list under a house; get; patch (omitted fields untouched) |
| ROOM-04 | cascade: devices seeded under a room, DELETE room → devices soft-deleted (read back via prismaRaw) |
| Multi-tenancy | create under / list of / get / patch / delete of another user's resource → **404** (not 403) |
| Auth | every route → 401 without a valid token |

## Deviations from Plan

**Transaction removed from `createRoom` (review).** The plan/House-mirror wrapped the
parent check + insert in `$transaction`. Removed during review: a single write has
nothing to make atomic, and the transaction did not close the orphan race without
`FOR UPDATE` (declined). The cascade in `deleteRoom` keeps its transaction, where
multiple writes genuinely need all-or-nothing. Behavior is identical; the code no
longer implies a guarantee it wasn't providing.

## Verification

- `npm run build` — exits 0
- `npm test` — 23/23 pass, exit 0, process exits cleanly
- Nested create/list verify parent ownership; cross-tenant → 404; no-token/invalid-token → 401
- `deleteRoom` cascade uses `tx.device.updateMany` inside `$transaction`; no `tx.*.delete()`
