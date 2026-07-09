# Phase 2: Entity CRUD & Multi-Tenancy - Context

**Gathered:** 2026-07-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver full REST CRUD for the **House → Room → Device** hierarchy with multi-tenancy enforced on every route, and eager per-type state-detail-row creation at device creation. Scope: HOUSE-01…05, ROOM-01…04, DEV-01…05, STATE-01, TEST-01/05/08. Not in scope (later phases): commands, state reads (STATE-02…04), event history, RabbitMQ.

This is the first phase with runtime application logic, so it follows the full **structure-first → tests-red → implement** sequence (not the Phase 1 compile/migration smoke-check exception).

</domain>

<decisions>
## Implementation Decisions

Most of the ownership/soft-delete/auth machinery is already locked by project docs and Phase 1 (see "Carried Forward" below). The decisions here resolve the API-surface and behavior gray areas discussed.

### URL structure & nesting
- **D-01 (shallow nesting):** Create and list under the parent; act on an item by its own id.
  - Houses: `POST /houses`, `GET /houses`, `GET/PATCH/DELETE /houses/:housePublicId`.
  - Rooms: `POST /houses/:housePublicId/rooms`, `GET /houses/:housePublicId/rooms`, `GET/PATCH/DELETE /rooms/:roomPublicId`.
  - Devices: `POST /rooms/:roomPublicId/devices`, plus **two list views** required by success criteria — `GET /rooms/:roomPublicId/devices` and `GET /houses/:housePublicId/devices` — and `GET/PATCH/DELETE /devices/:devicePublicId`.
  - Not fully nested (no `/houses/:h/rooms/:r/devices/:d`) — ownership is enforced by `user_id`, so full ancestry in the path is redundant.

- **D-02 (list response = bare array, no pagination):** List endpoints return the items directly (`[ ...items ]`) — no envelope, no pagination. House/room/device collections are small in v1; pagination is unwarranted (YAGNI). The Phase 7 event-history read is the paginated pattern; CRUD lists deliberately stay simple. Adding a `{ data, nextCursor }` envelope later is a non-breaking change if a real client ever needs it.

### Resource identifiers
- **D-03 (public_id everywhere):** Route paths and JSON responses use the NanoID `public_id`; the internal `BigInt` id is **never** exposed. Services resolve `{ publicId, userId }` → internal row. This realizes PROJECT.md's non-enumerable-external-id design and sidesteps BigInt-JSON serialization entirely (contrast the existing auth routes, which leak `Number(user.id)` — do not copy that on new routes).
- Nested creation/list paths therefore carry the **parent's** `public_id` (e.g. `POST /houses/:housePublicId/rooms`), and the service verifies parent ownership via `{ publicId, userId }` before acting.

### Update semantics & mutability
- **D-04 (PATCH, partial):** Updates are `PATCH` with only the fields to change; omitted fields are untouched. Matches DEV-03 "update metadata" and the mostly-optional field sets (address, floor, room_type, manufacturer, model).
- **D-05 (no re-parenting in v1):** `house_id` / `room_id` are fixed at creation. Update touches metadata only. Moving a room to another house or a device to another room is **not** supported — do it via delete + recreate. Avoids cross-parent ownership re-validation.
- **D-06 (device_type immutable):** `device_type` cannot change after creation — `state_type`/`state_id` and the eager state row are bound to it at creation time. PATCH on a device rejects any `device_type` change.

### Soft-delete cascade
- **D-07 (cascade soft-delete):** Deleting a house soft-deletes all its rooms **and** devices; deleting a room soft-deletes its devices — in **one transaction**. Because routes expose items at top level (`GET /devices/:id`), a non-cascading delete would leave a live-looking orphan device reachable directly; cascade makes children vanish from every read consistently.
  - Implementation seam: the Phase 1 Prisma `$extends` turns `delete`/`deleteMany` into soft-delete `updateMany` for soft-deletable models. Cascade = explicit `deleteMany` on children inside a transaction. **Device now carries a denormalized `house_id`** (added to the schema in Phase 2), so the house→device cascade is a **direct** `device.deleteMany({ where: { houseId } })` — no join through room ids. Delete house → `device.deleteMany({ where: { houseId } })`, `room.deleteMany({ where: { houseId } })`, then the house; delete room → `device.deleteMany({ where: { roomId } })`, then the room.
  - Compatible with Phase 7: a soft-deleted device's event history stays readable there because that read deliberately bypasses the `deletedAt` guard.
  - Per-type state rows are internal-only (not soft-deletable) — they simply remain; the device row is the access gate, so no orphan is reachable.

### Claude's Discretion (researcher/planner to decide)
- **NanoID `public_id` generation seam** — deferred from Phase 1: a Prisma client `create`-extension vs. minting in each `createX` service. Add the `nanoid` dependency (not currently installed). Confirm 21-char length fits `@db.VarChar(21)`.
- **TypeBox introduction** — TypeBox is the mandated validation standard (CLAUDE.md / PLAN.md rule 1.5) but is **not yet a dependency** (`zod` is the only validator installed today). Phase 2 adds `@sinclair/typebox` + the Fastify TypeBox type-provider and writes all new schemas with it (`Static<typeof schema>`), per project rule. Do not migrate the legacy auth `as const` schemas unless touched.
- **Field validation limits** — name lengths, `floor` range, `brightness` 0–100, `target_temp` bounds, `ac_states.mode` vocabulary, sensor `unit` — all live in the TypeBox app layer (no DB constraints, per Phase 1 D-01…D-06). Pick sensible defaults.
- **Eager state-row defaults** — the Phase 1 schema defaults (`is_on=false`, `brightness=0`, etc.; `ac_states.mode` and `sensor_states.reading`/`unit` have no schema default) need concrete creation-time values; choose sane ones.
- **BigInt serialization strategy** — since responses expose only `public_id`, internal BigInt ids should never reach the serializer; confirm no BigInt leaks into any response schema.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Planning specs (authoritative for Phase 2)
- `.planning/ROADMAP.md` §"Phase 2: Entity CRUD & Multi-Tenancy" — Goal, the six Success Criteria (the acceptance contract), and the structure-first/test-first scaffold/test/implement notes (route/service/schema file layout).
- `.planning/REQUIREMENTS.md` §Houses / §Rooms / §Devices / §Device State (STATE-01) — HOUSE-01…05, ROOM-01…04, DEV-01…05, STATE-01; §Testing TEST-01/05/08.
- `.planning/PROJECT.md` §Constraints & §Key Decisions — multi-tenancy via denormalized `user_id`, soft-delete semantics, non-enumerable `public_id`, TypeBox validation standard, service-layer + Prisma-singleton pattern, polymorphic morph state.

### Prior phase context
- `.planning/phases/01-schema-data-conventions/01-CONTEXT.md` — the locked schema decisions (D-01…D-12): per-type state columns, `public_id` sizing, no DB enums/limits, morph `state_type`/`state_id`, the NanoID-generator-lands-in-Phase-2 note.

### Codebase maps
- `.planning/codebase/CONVENTIONS.md` — naming / `@map` conventions to extend.
- `.planning/codebase/STRUCTURE.md`, `.planning/codebase/ARCHITECTURE.md` — autoload plugin/route layout, service-layer + Prisma-singleton patterns.
- `.planning/codebase/TESTING.md` — `build(t)` + `app.inject()` convention (the test harness Phase 2 uses).

### Existing code (the patterns to mirror / integration points)
- `prisma/schema.prisma` — House/Room/Device/CommandTarget + four `*_states` models (the tables this phase writes).
- `src/lib/prisma.ts` — the `$extends` soft-delete + read-guard client (the cascade seam and free soft-delete exclusion).
- `src/routes/auth/index.ts` — Fastify route/plugin shape, `preHandler: fastify.authenticate`, `httpErrors` usage, Prisma error mapping (P2002 → conflict).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`src/lib/prisma.ts` `prisma` (extended client)** — reads auto-inject `deletedAt: null` (`readGuard`) for User/House/Room/Device, so soft-delete exclusion (TEST-05) is free on all CRUD reads. `delete`/`deleteMany` auto-convert to soft-delete `updateMany`. `prismaRaw` exists for genuine hard delete if ever needed. Cascade delete builds on the `deleteMany` seam.
- **`fastify.authenticate`** (from `src/plugins/auth.ts`) — the 401 boundary (TEST-08); attach as `preHandler` to every new route exactly as `/auth/me` does.
- **`fastify.httpErrors`** (sensible plugin) — `notFound()` for cross-tenant 404 (HOUSE-05 / TEST-01), `conflict()` etc. Global error-handler normalizes to `{ error, message, statusCode }`.
- **`src/lib/strings.ts`** — home for small reusable string helpers (per CLAUDE.md "extract generic helpers"); the NanoID generator is a candidate for a sibling `src/lib/` module.
- **`@fastify/autoload`** — dropping files in `src/routes/houses/`, `src/routes/rooms/`, `src/routes/devices/` auto-maps them to URL paths; each exports a `FastifyPluginAsync`.

### Established Patterns
- **Service layer:** pure functions in `src/services/` talk to Prisma; routes call services (`src/services/house.ts`, `room.ts`, `device.ts` per ROADMAP scaffold notes). Ownership queries embed `where: { publicId, userId }` — never join through the hierarchy (DATA-02).
- **relationMode = "prisma"** — no real FK constraints; morph back-links and denormalized `user_id`/`house_id` are plain columns. Cascade must be done in application code (no DB ON DELETE CASCADE).
- **Device carries denormalized `house_id`** (`@@index([houseId])`, added in Phase 2) — `GET /houses/:housePublicId/devices` and the house→device cascade both query `houseId` directly, never joining through rooms (DATA-02 spirit). ⚠ This is an **additive schema change on top of the "locked" Phase 1 schema** — Phase 2 must ship the migration + `prisma generate` for it.
- **Cross-tenant → 404 not 403** — an ownership-scoped read that matches nothing yields `notFound`, never `forbidden` (don't reveal existence).

### Integration Points
- **Eager state row (STATE-01):** device creation inserts the device **and** the matching `*_states` row in one `prisma.$transaction`, setting `state_type` + `state_id` on the device. A typed `Record<deviceType, …>` config (per CLAUDE.md "explicit over magic", one handler per type) maps device_type → which state table + defaults — no `$allOperations`-style catch-all.
- **Legacy schemas:** the existing auth `schemas.ts` uses raw `as const` JSON Schema; new Phase 2 schemas must use TypeBox. Don't retrofit auth unless touched.

</code_context>

<specifics>
## Specific Ideas

- **Do not copy the auth routes' `Number(user.id)` id exposure** onto new routes — responses expose `public_id` only (D-03).
- Device-type → state-table mapping should be a typed, enumerated `Record` (light/ac/heater/sensor), letting the type system enforce completeness — consistent with the `modelConfig` pattern already in `src/lib/prisma.ts` and the Phase 1 "no catch-all" style.

</specifics>

<deferred>
## Deferred Ideas

- **Setting initial device state at creation** (e.g. create a light already on) — v1 creates the eager state row with **defaults only** (STATE-01); client-supplied initial state is out of scope.
- **Re-parenting** (move room → house, device → room) — deferred; v1 has fixed parents, move = delete + recreate (D-05).
- **Filtering/search on list endpoints** (by device_type, name, etc.) — not in Phase 2 scope; add per real need.
- **Migrating the legacy auth schemas to TypeBox** — only when those routes are next touched (per CLAUDE.md rule).

None of the above are blockers; discussion stayed within phase scope.

</deferred>

---

*Phase: 2-Entity CRUD & Multi-Tenancy*
*Context gathered: 2026-07-08*
