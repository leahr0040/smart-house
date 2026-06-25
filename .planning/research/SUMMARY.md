# Research Summary — Smart-House Device State & Telemetry Platform

**Project:** smart-house
**Synthesized:** 2026-06-25
**Overall confidence:** HIGH

---

## Executive Summary

This project extends an already-functional Fastify 5 / Prisma / MariaDB authentication API into a multi-tenant smart-home device-state and telemetry platform. All domain references (Home Assistant, AWS IoT, Azure IoT Hub, Apple HomeKit, Google Home API, SmartThings, Tuya Cloud) converge on the same containment hierarchy — User → House → Room → Device — with denormalized current state for fast reads and an append-only event log for history. The recommended approach keeps strictly within the existing stack (zero new production databases in v1) and adds only `@sinclair/typebox` as a new dependency to satisfy the project's existing TypeBox-as-route-schema-standard.

The critical architectural decision is "denormalized current state alongside an append-only event log." Current state lives inline on the Device row (a JSON string validated per device type in the service layer), and every write also inserts an immutable DeviceEvent row — both operations inside a single `prisma.$transaction()`. Device state shapes are enforced by TypeBox discriminated-union validators keyed by device type (`src/lib/device-state.ts`), not DB-level enums, so new device types require code changes but no migrations.

The dominant risk category is multi-tenancy: the existing codebase has zero authorization checks beyond "is the user authenticated," and the hierarchy is four levels deep. Every service function must embed the ownership join in its Prisma query. A close second is event-log schema permanence: columns like `eventKind`, `deviceType`, `source`, and `recordedAt` cost almost nothing at schema-design time and require a full table migration later — they must be locked in before any write path ships.

---

## Key Findings

### From STACK.md

| Technology | Role | Rationale |
|---|---|---|
| `@sinclair/typebox` ^0.34.x (NEW) | Route schemas + type inference | Only new production dependency; plugs into Fastify natively as JSON Schema |
| MariaDB `Json` column (existing) | Flexible per-device state storage | Avoids migration per new device type; validated in code via TypeBox |
| Prisma `DeviceEvent` append-only table (new) | Immutable event log | Single-store; designed to extract to time-series DB in v2 without API changes |
| `BigInt` for `DeviceEvent.id` | Event PK | Avoids Int overflow (~2B row limit) at IoT volumes |
| Prisma cursor pagination (built-in) | Event history queries | Offset degrades linearly; cursor is O(1) per page |
| Zod (existing, env-only) | Env validation | Stays isolated to env; NOT used for routes |

### From FEATURES.md

**Must-have (table stakes):**
- User → House → Room → Device CRUD with multi-tenancy throughout
- Device-type catalog (code-level enum + TypeBox schemas: light, AC, heater, sensor)
- Current-state read: single device, room scope, house scope
- Command endpoint `POST /devices/:id/command` — validates, updates state, appends event
- Report endpoint `POST /devices/:id/report` — same write path, `source = REPORT`
- Append-only event log with queries by device, by time range, cursor pagination
- `source` field on every event (command vs. report), full `stateSnapshot` (not diff)

**Should-have (include in schema design, implementation can follow):**
- `eventKind`, `actor_id` for dual-origin tracking
- `last_seen_at` on Device for presence tracking
- Bulk house snapshot `GET /houses/:id/snapshot`
- Timezone field on House
- Soft-delete on Device (`deletedAt`)

**Defer to future milestone:** Hardware protocol adapters, AI rule engine, WebSocket/SSE, DB-backed device-type catalog, notification delivery, analytics aggregation endpoints.

### From ARCHITECTURE.md

**Major components:**
- `src/routes/houses/`, `rooms/`, `devices/`, `events/` — HTTP boundary, TypeBox validation
- `src/services/house.ts`, `room.ts`, `device.ts`, `event.ts` — pure DB functions with ownership joins
- `src/lib/device-state.ts` — TypeBox discriminated-union validators keyed by device type
- Prisma schema additions: House, Room, Device, DeviceEvent with all indexes

**Key patterns:**
1. Atomic state-update + event-insert via `prisma.$transaction()` — always
2. Ownership-embedded Prisma queries: `findFirst({ where: { id, house: { userId } } })`
3. Single `updateDeviceState(deviceId, userId, newState, source)` service function
4. State validation in `src/lib/device-state.ts` before any DB write

**Schema additions summary:**
- House: `id (cuid)`, `userId`, `@@index([userId])`
- Room: `houseId`, `onDelete: Cascade`, `@@index([houseId])`
- Device: `type (String)`, `currentState (Json)`, `deletedAt (nullable)`, `@@index([roomId])`
- DeviceEvent: `id (BigInt)`, `source`, `eventKind`, `deviceType (denormalized)`, `stateSnapshot`, `recordedAt`, `@@index([deviceId, recordedAt])`

### From PITFALLS.md

**Top 5 critical pitfalls:**

| # | Pitfall | Prevention | Phase |
|---|---|---|---|
| 1 | Cross-tenant data leakage | UUID PKs; ownership join in every service; second-user test per route | Phase 1 |
| 2 | Current-state / event-history split-brain | `prisma.$transaction()` for every state mutation | Phase 2 |
| 3 | Race condition on concurrent state updates | Optimistic concurrency (`version` column) or `SELECT FOR UPDATE` | Phase 2 |
| 4 | Over-rigid enums or unvalidated JSON | TypeBox validator map; normalize before storing | Phase 1 |
| 5 | AI-hostile event schema | `eventKind`, `deviceType`, `source`, `recordedAt` from day one | Phase 1 |

**Additional schema-time pitfalls:** missing composite index `(deviceId, recordedAt)`, timestamp/timezone chaos (`DATETIME(3)` UTC only), authorization gaps in nested hierarchy, missing soft-delete on Device, unbounded event log growth.

---

## Implications for Roadmap

### Suggested Phase Structure: 3 phases

**Phase 1 — Entity Modeling & Foundation**

Rationale: Schema decisions (device type as String, `deletedAt`, `eventKind`, composite indexes) are cheap now, migration-expensive later. Multi-tenancy must be established before any data can be created. Prisma-generated types gate all downstream code.

Delivers: Prisma schema additions + migrations; `src/lib/device-state.ts` TypeBox validators; House/Room/Device CRUD services with ownership; House/Room/Device CRUD routes; current-state read endpoints; multi-tenancy integration tests (second-user 404 per route).

Pitfalls addressed: 1 (cross-tenant), 4 (state modeling), 9 (hierarchy auth gap), 10 (soft-delete), 8 (AI-hostile schema columns).

Research flag: **STANDARD PATTERNS — no additional research needed.**

---

**Phase 2 — Event Log & Write Paths**

Rationale: Event schema must be stable before any write path ships. Command and report share one service function; the transaction boundary is the central correctness invariant.

Delivers: `DeviceEvent` schema finalized; `updateDeviceState()` service with `prisma.$transaction()`; Command route; Report route; Event query service with cursor pagination; Event history routes; concurrent-update handling.

Pitfalls addressed: 2 (split-brain), 3 (race condition), 5 (split-brain), 6 (timestamps), 7 (composite index), 12 (partial writes).

Research flag: **NEEDS RESEARCH** — optimistic concurrency vs. `SELECT FOR UPDATE` in Prisma + `@prisma/adapter-mariadb` has edge cases worth validating before planning.

---

**Phase 3 — Polish & Differentiators**

Rationale: These features add value but have no blocking dependencies on each other or on Phase 2 correctness.

Delivers: Bulk house snapshot; device presence tracking (`last_seen_at`); event queries by room and by event type; retention policy (batch-delete); timezone field on House; full edge-case test coverage.

Pitfalls addressed: 2 (event log growth), 6 (timezone in house-scoped queries).

Research flag: **STANDARD PATTERNS — no additional research needed.**

---

## Confidence Assessment

| Area | Confidence | Notes |
|---|---|---|
| Stack — TypeBox for routes | HIGH | Official Fastify recommendation; matches project rule 1.5 |
| Stack — MariaDB for current state + events | HIGH | Already in use; Prisma JSON stable |
| Features — entity hierarchy and CRUD | HIGH | Consistent across 6+ domain reference platforms |
| Features — command/report write paths | HIGH | Standard IoT device-shadow pattern |
| Architecture — denormalized state + event log | HIGH | Avoids event-sourcing complexity; AI-consumable |
| Architecture — transaction boundary | HIGH | Standard ACID requirement; Prisma `$transaction` well-supported |
| Pitfalls — multi-tenancy | HIGH | Directly confirmed by existing CONCERNS.md in codebase |
| Pitfalls — concurrent update handling | MEDIUM | General pattern known; Prisma + MariaDB adapter specifics less documented |
| Stack — deferring time-series DB | MEDIUM | Right for v1 scope; future migration effort real but bounded |

**Overall: HIGH**

---

## Gaps to Address During Planning

1. **Optimistic concurrency implementation** — Prisma has no built-in optimistic locking primitive. Validate exact pattern (`version` column with conditional update, or `$executeRaw SELECT FOR UPDATE`) against Prisma + `@prisma/adapter-mariadb` before Phase 2 planning.

2. **`Json` vs. `String` for `currentState`/`stateSnapshot`** — STACK.md recommends Prisma `Json` type; PITFALLS.md notes MariaDB JSON is less mature than Postgres JSONB. Recommendation: use Prisma `Json`; avoid server-side JSON path queries (full-document read/write only). If portability needed, use `String` in Prisma + serialize/parse in service layer.

3. **Event retention defaults** — Product decision needed before Phase 2 schema finalized: e.g., 90 days for sensor readings, indefinite for user commands.

4. **`cuid` vs. `uuid` for entity PKs** — ARCHITECTURE.md uses `cuid()` (sortable, good for cursor pagination); PITFALLS.md recommends UUID for anti-enumeration. Functionally equivalent for security purposes; confirm one standard before Phase 1 migration.

---

## Sources (Aggregated)

- Project codebase: `CLAUDE.md`, `PLAN.md`, `.planning/PROJECT.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`
- Prisma docs: Json field type, cursor pagination, BigInt, `$transaction`
- Fastify docs: TypeBox type provider, `@fastify/autoload`
- Domain references: Home Assistant, AWS IoT Device Shadow, Azure IoT Hub Device Twin, Google Home API, Apple HomeKit, Tuya Cloud API, SmartThings, OpenHAB
- MariaDB docs: JSON column (10.2+, stable 10.5+), InnoDB composite index behavior, `DATETIME(3)` vs. `TIMESTAMP`
