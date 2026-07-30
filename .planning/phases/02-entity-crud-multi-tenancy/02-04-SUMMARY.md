---
phase: 02-entity-crud-multi-tenancy
plan: 04
subsystem: device-slice
tags: [rest, crud, typebox, multi-tenancy, soft-delete, cascade, eager-state, relations]
status: complete

requires:
  - 02-01 (extended prisma client, publicId hook, test factories, closeDb)
  - 02-02 (house slice reference shape: nullIfNotFound, toResponse producer, test-DB isolation)
  - 02-03 (room slice: nested parent-verified create, room→devices cascade)
provides:
  - Device CRUD REST slice (nested create/list under a room; get/patch/delete by device publicId; list by house)
  - eager per-type state row creation (STATE-01) via a typed deviceStateConfig
  - device state returned in GET /devices/:id and POST as a discriminated union
  - device→state soft-delete cascade, and its reuse in the room and house cascades
affects:
  - later phases building on device state (telemetry, commands) inherit the per-type tables + relations

tech-stack:
  added: []
  patterns:
    - "no morph pointer: stateType/stateId dropped; state located via the per-type relation (unique device_id) + deviceType"
    - "eager state: one nested create inserts device + its per-type state row; stateType/stateId gone so no second write"
    - "state in responses: TypeBox union discriminated structurally (distinct required keys + additionalProperties:false), narrowed via a tagged LoadedState"
    - "state tables soft-deletable; deleteDevice/Room/House cascade to state via grouped updateMany per present type (never .delete(), which escapes the tx)"
    - "Device↔state 1:1 relations (relationMode=prisma, no FK); enables a future list-with-state via relationLoadStrategy join"
    - "load stays two typed queries (device + state findUnique); join deferred until a list endpoint needs it"

key-files:
  created:
    - src/routes/devices/schemas.ts
    - src/routes/devices/index.ts
    - src/services/device.ts
    - src/test/routes/devices.test.ts
  modified:
    - prisma/schema.prisma (relations, per-type deleted_at, morph pointer removed)
    - prisma/migrations/20260707094526_add_domain_schema/migration.sql (amended — unpushed)
    - src/lib/prisma.ts (state tables softDelete:true)
    - src/services/house.ts, src/services/room.ts (cascade to device state)
    - src/test/helpers/fixtures.ts (seedDevice creates the state row)
    - package.json, .npmrc, tsconfig.json (Node 22 / ES2024 floor)

decisions:
  - "Dropped the state_type/state_id morph pointer — redundant with the per-type relation (unique device_id) + deviceType; removed from schema, migration, and planning docs"
  - "GET /devices/:id and POST return the resolved state; lists stay metadata-only (list-with-state deferred to a future join)"
  - "State is a device child: delete cascades device→state, and the house/room cascades were extended to soft-delete descendant device state too"
  - "Kept the two-query state load rather than a raw multi-table join, for type safety and consistency with the extension as the single soft-delete source of truth"
  - "removeAdditional stays at the Fastify default (strip) — device_type immutability holds because the field is stripped before the update"

metrics:
  tasks: 3
  completed: 2026-07-30
---

# Phase 2 Plan 04: Device CRUD Vertical Slice Summary

The Device slice — the phase's most architecturally significant, because each device
carries an eager per-type state row (STATE-01). It mirrors the house/room slices and
adds: state creation in the same nested write, state in the detail responses, and a
soft-delete cascade down to state that the house and room cascades reuse.

## What Was Built

| Artifact | Purpose |
|---|---|
| `src/routes/devices/schemas.ts` | TypeBox create/patch/param schemas, `DeviceResponseSchema` (no `id`), a discriminated `DeviceStateSchema` union + `DeviceDetailResponseSchema`, and `toDeviceResponse`/`toDeviceDetailResponse` producers |
| `src/routes/devices/index.ts` | `prefixOverride=''`; nested POST/GET under `/rooms/:roomPublicId/devices`, GET-by-house, GET/PATCH/DELETE `/devices/:devicePublicId`; auth + response schema on every route |
| `src/services/device.ts` | `deviceStateConfig` (typed per-type create + load), `createDevice`, list-by-room/house, `getDevice` (device + state), metadata-only `updateDevice`, cascade `deleteDevice`, and the shared `softDeleteDeviceStates`/`groupDeviceIdsByType` cascade helpers |
| `src/test/routes/devices.test.ts` | integration tests incl. per-type state in responses, device_type immutability, and the state cascade |

**Eager state, no morph pointer.** Create inserts the device and its per-type state
row in one nested `create` keyed by `deviceType`. The old `state_type`/`state_id`
morph columns were dropped — the state is found via the per-type relation (each state
row holds a unique `device_id`) plus `deviceType`, so the forward pointer was
redundant. Removing it also removed the second write the pointer used to require.

**State is returned, and is a child on delete.** `GET /devices/:id` and `POST` return
the resolved state as a structurally-discriminated union (a `deepStrictEqual`-per-type
test proves no key bleed). Because the state row is a child of the device, `deleteDevice`
cascades the soft-delete to it — and the same `softDeleteDeviceStates` helper extends
the room and house cascades so a house/room delete soft-deletes descendant device state
too, one grouped `updateMany` per state type actually present.

## Deviations from Plan

- **Morph pointer removed** (was `state_type`/`state_id` on Device). Superseded by the
  per-type relations; planning docs (PROJECT/REQUIREMENTS/ROADMAP/STATE) updated to match.
- **State soft-delete + cascade added** beyond the original leaf-delete plan, after two
  bugs surfaced: state tables weren't soft-deletable, and device delete didn't cascade to
  state. Fixed by making the four state tables `softDelete:true` (amended `deleted_at` into
  the unpushed domain migration) and turning `deleteDevice` into a cascade.
- **Tooling floor raised** — Node ≥22 (`engine-strict`) + `ES2024.Object` lib.

## Verification

- `npm test` — 39/39 pass, exit 0, process exits cleanly
- Nested create verifies parent-room ownership; cross-tenant → 404; no-token/invalid → 401
- Per-type state row created on device create (STATE-01); state returned per type in GET/POST
- device_type immutable on PATCH; unknown device_type on create → 400
- DELETE device/room/house cascades the soft-delete to descendant device state (read back via prismaRaw)
