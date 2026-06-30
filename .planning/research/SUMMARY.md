# Research Summary — Smart-House Event-Driven Platform

**Project:** smart-house
**Synthesized:** 2026-06-28
**Replaces:** SUMMARY.md dated 2026-06-25 (pre-architecture-pivot)
**Overall confidence:** HIGH

> **⚠ 2026-06-30 UPDATE (c) — single-store pivot, supersedes all MongoDB references below.** Events now live in a **MariaDB append-only `events` table**, not MongoDB. MongoDB and the `mongodb` driver are DROPPED. Consequences: the report consumer's event-insert + guarded state-update + target CAS + roll-up are **one local MariaDB transaction** (no cross-store window, no write-order invariant); idempotency = MariaDB unique index on `event_id`; event history is queried from MariaDB; testcontainers spins up **MariaDB + RabbitMQ only (2 containers)**. Also added: command targets use compare-and-set with **first-terminal-wins**, command create is **persist-then-publish**, a **fan-out cap** (~200), the **DLQ is not drained in v1**, and a soft-deleted device's history stays readable. The RabbitMQ/event-driven design is otherwise unchanged. PROJECT.md / REQUIREMENTS.md are authoritative.
>
> **⚠ 2026-06-28 UPDATE (b) — supersedes parts of this summary.** The data model was refined after this was synthesized. Where this conflicts with the points below, the points below win (PROJECT.md / REQUIREMENTS.md are authoritative).
>
> - **No desired/reported twin.** Each device has a SINGLE current-state record (its real state), updated on report. "Desired"/pending lives on the `commands` table. All `desired_*` / `reported_*` columns and `sync_status` are removed.
> - **Current state via polymorphic morph** (`state_type` + `state_id` → per-type detail tables); no JSON; new type = new detail table, no `Device` change; loose FK integrity OK (rebuildable projection).
> - **`user_id` denormalized on Room and Device** (ownership without joins; batched `IN`, no N+1).
> - **Soft delete (`deleted_at`)** on User/House/Room/Device; reads exclude soft-deleted; soft-deleted user cannot authenticate.
> - **Atomic guarded updates** (single conditional `UPDATE … WHERE last_event_at < :incoming`); event idempotency via a Mongo unique index.
> - **`commands` selector** is a TypeBox discriminated union; stored normalized (`selector_kind` + `selector_scope_id` + `selector_device_type`) with resolved devices in `command_targets`.
> - **Summary impact:** phase structure below is unchanged in shape; the "typed per-type state tables + twin" work becomes "single current-state projection via morph." STATE requirements drop from 5 → 4.

---

## Executive Summary

This project extends an already-functional Fastify 5 / Prisma / MariaDB authentication API into a multi-tenant, event-driven smart-home device-state and telemetry platform. The architecture pivoted decisively from a single-store, transaction-based model to a three-store event-driven design: **MariaDB** holds the relational hierarchy and twin-state projection (desired vs. reported per device), **MongoDB** holds an immutable append-only event log (the source of truth), and **RabbitMQ** mediates all state changes between the API and devices. Commands fan out as broker messages; a simulated device worker consumes effects and publishes reports; a report consumer projects state and appends events. Nothing about the auth API changes — the event-driven platform layers over it cleanly.

The recommended approach is well-defined by the PROJECT.md key decisions and has zero open questions about core technology choices. New dependencies are: `mongodb` v6 native driver (not Mongoose, not the Prisma MongoDB connector), `amqplib` + `amqp-connection-manager` for RabbitMQ, and `@fastify/type-provider-typebox` to wire TypeBox into Fastify route handler types. Per-device-type state is stored in dedicated typed tables in MariaDB (not a JSON column), each carrying `desired_*` and `reported_*` columns that faithfully model the twin-state contract. Commands are first-class entities with selector-based fan-out and per-device completion tracking. Every effect and report produces an immutable event document in MongoDB, making the history a complete AI-consumable corpus from day one.

The dominant risk category is consistency across two stores without a distributed transaction. The write-order contract — MongoDB event append first, MariaDB projection upsert second, idempotency key enforced at both steps — is the single most important implementation invariant. A close second is multi-tenancy: MongoDB has no awareness of the ownership chain, so every MongoDB query must be preceded by a MariaDB ownership resolution. The existing codebase has zero authorization checks beyond authentication; this debt must be paid in full during the entity CRUD phase before any messaging work begins.

---

## Key Findings

### From STACK.md

| Technology | Role | Rationale |
|---|---|---|
| `mongodb` ^6.x (NEW) | Event history client | Native driver; time-series collection support; no ODM overhead for append-only log |
| `amqplib` ^0.10.x (NEW) | RabbitMQ AMQP 0-9-1 client | De facto standard; precise topology control |
| `amqp-connection-manager` ^4.x (NEW) | RabbitMQ reconnection wrapper | Without it, broker restart kills the app permanently |
| `@fastify/type-provider-typebox` ^4.x (NEW) | TypeBox-to-Fastify wiring | Enables full type inference in route handlers from TypeBox schemas |
| `@sinclair/typebox` ^0.34.x | Discriminated-union schemas for device state and command actions | Zero-dep; Fastify consumes natively; `Static<>` derives TypeScript types |
| MariaDB typed state tables (Prisma) | Twin state (desired + reported per device type) | Real columns, indexed, Prisma-typed; replaces old JSON column recommendation |
| `src/lib/prisma.ts` (existing) | MariaDB singleton — unchanged | Entity hierarchy, twin state, commands, auth |
| `src/lib/mongo.ts` (NEW) | MongoDB singleton | Event documents only |
| `src/lib/rabbitmq.ts` (NEW) | AMQP connection + channel wrappers | Decoupled lifecycle from Fastify plugins |

**Reversed from old STACK.md (critical):** JSON column for device state, MariaDB `DeviceEvent` table, `prisma.$transaction()` for dual-write, no message broker in v1, defer second store.

### From FEATURES.md

**Must-have (table stakes):**
- User → House → Room → Device CRUD with multi-tenancy throughout (404 for not-owned, not 403)
- Device-type catalog as TypeBox discriminated-union schemas (light, AC, heater, sensor) — code enum for v1
- Twin-state reads: single device, room scope, house scope (`desired + reported + sync_status`)
- Commands: `POST /commands` with selector targeting (explicit ids / room / house + optional type filter), per-device fan-out via RabbitMQ, status queryable via `GET /commands/:id`
- Illogical action for a device type → 400 before dispatch (CMD-03)
- Append-only event log in MongoDB; `source`, `event_kind`, `device_type`, `command_id`, `state_snapshot`, `recorded_at` on every document
- Event history queries: by device, by time range, cursor paginated

**Should-have (design into schema, implement as bandwidth allows):**
- `command_id` linkage on events (multi-device command → one event per device, shared `command_id`)
- `projection_updated_at` on twin-state rows (expose staleness)
- Soft-delete on Device (`deleted_at`) from the first migration
- Timezone field on House (cheap now, expensive to retrofit)
- `schema_version: 1` on every event document (future AI migration path)

**Defer to future milestone:** Real hardware protocol adapters, AI rule engine, WebSocket/SSE push, DB-backed device-type catalog, notification delivery, analytics aggregation.

### From ARCHITECTURE.md

**Major components:**

| Component | Responsibility |
|---|---|
| `src/routes/commands/` | POST /commands (issue); GET /commands/:id (status) |
| `src/command-handler/index.ts` | Selector resolution (ownership-anchored), TypeBox action validation, command row write, effect publish |
| `src/command-handler/translator.ts` | Action → EffectMessage translation per device type |
| `src/workers/device-simulator.ts` | Consumes effects queue, applies, publishes report |
| `src/workers/report-consumer.ts` | Consumes reports queue, appends event (Mongo), upserts twin (Prisma), updates command status |
| `src/services/twin-state.ts` | `upsertDesiredState`, `upsertReportedState`, `getDeviceTwinState` |
| `src/services/event-query.ts` | `queryEvents` — ownership-scoped (MariaDB first), cursor-paged (MongoDB second) |
| `src/lib/device-actions.ts` | TypeBox action schemas per device type; action→effect translation registry |

**Key patterns:**
1. Write-order invariant in report consumer: append to MongoDB first, upsert MariaDB projection second. Abort on Mongo failure; projection failure is tolerable (rebuildable).
2. Idempotency: every event carries a deterministic `event_id` (`sha256(commandId+deviceId+eventKind)` for effects; `sha256(reportId)` for reports). MongoDB unique index enforces no duplicates.
3. Ownership-embedded service queries: `device.findFirst({ where: { id, room: { house: { userId } } } })` — the `userId` anchor is never omitted.
4. Two-step MongoDB access: resolve `device_id` in MariaDB first (ownership check), then query MongoDB — never pass caller-supplied IDs directly to Mongo.
5. `prefetch(1)` on both RabbitMQ consumers — single in-flight message, bounded requeue blast on crash.
6. Selector resolution as a shared service function `resolveOwnedDeviceIds(userId, selector)` — one code path for all selector types.

**Build order:** Schema + Entity CRUD → Messaging Infrastructure → Command Handler → Simulated Worker → Report Consumer + Projector → Event History Routes → Integration Tests.

### From PITFALLS.md

**Critical pitfalls (must prevent before going live):**

| # | Pitfall | Prevention | Phase |
|---|---|---|---|
| 1 | Dual-store consistency: event written, projection not updated (or vice versa) | Mongo write first, Prisma upsert second; nack on Mongo failure; projection rebuild path tested early | Report consumer phase |
| 2 | Cross-tenant MongoDB query without MariaDB ownership resolution | Two-step contract: resolve owned IDs in MariaDB, then query Mongo; `resolveOwnedDeviceIds()` helper everywhere | Event history phase + command handler |
| 3 | Device identity spoofing on reports queue | Validate `deviceId` exists in MariaDB before processing any report; design per-device credential now (same contract as v2 hardware) | Messaging phase |
| 4 | Duplicate events from at-least-once redelivery | Idempotency key (`event_id`) with MongoDB unique index; MariaDB upsert guarded by `last_event_at` timestamp | Messaging phase (consumer day one) |
| 5 | Poison message / retry storm | Distinguish permanent vs. transient errors; nack-with-requeue only for transient; DLQ for permanent; max retry count via `x-death` | Messaging infra phase |
| 6 | Out-of-order reports corrupting twin state | Sequence number or `last_event_at` guard on projection upsert — only apply if newer | Report consumer phase |

**Moderate pitfalls (design mitigations in):**
- Desired state never confirmed → `sync_status: 'timeout'` watchdog + publisher confirms (Pitfall 7)
- Projection lag not visible → `projection_updated_at` on state rows (Pitfall 8)
- Unacked message blast on restart → `prefetch(1)` (Pitfall 9)
- AI-hostile event schema → `event_kind`, `device_type`, `numeric_value`, `schema_version` from day one (Pitfall 10)
- Timestamp/timezone chaos → UTC everywhere, `recorded_at` + `reported_at` on events, ISO 8601 with offset in API params (Pitfall 11)
- Cross-tenant selector resolution → selector always anchors to `userId` (Pitfall 12)

**Minor pitfalls:** Soft-delete from first device migration (Pitfall 13); assert topology on boot, fail-fast if missing (Pitfall 14); redact sensitive device state from logs (Pitfall 15).

---

## Implications for Roadmap

### Suggested Phase Structure: 7 phases

**Phase 1 — Schema, Entity CRUD, and Multi-Tenancy Foundation**

Rationale: Prisma-generated TypeScript types gate all downstream code. Multi-tenancy must be established before any data can be created — retrofitting it is the most dangerous technical debt in this codebase. The `@@map` snake_case convention applies to existing models too. Schema decisions (soft-delete `deleted_at`, typed state tables) are cheap now and expensive after data exists.

Delivers: Full Prisma schema (House, Room, Device + 4 typed state tables, Command, CommandDeviceTarget; `@@map` on all including User/RefreshToken); House/Room/Device CRUD routes + services with ownership-embedded queries; `resolveOwnedDeviceIds()` helper; multi-tenancy integration tests (second-user 404 per route).

Requirements covered: HOUSE-01–05, ROOM-01–04, DEV-01–05, DATA-01.

Pitfalls addressed: 2 (ownership foundation), 12 (selector scoping), 13 (soft-delete from first migration).

Research flag: **STANDARD PATTERNS — no additional research needed.**

---

**Phase 2 — Messaging Infrastructure**

Rationale: The MongoDB client singleton and RabbitMQ connection + topology must exist before any component tries to use them. Topology provisioning must fail-fast on boot. The `device_events` collection must be created as a time-series collection here — this cannot be changed after data is written.

Delivers: `src/lib/mongo.ts`; `src/lib/rabbitmq.ts` (AmqpConnectionManager + ChannelWrapper); `src/plugins/mongo.ts` + `src/plugins/rabbitmq.ts`; topology bootstrap (effects exchange, reports exchange, device_effects queue, device_reports queue, DLQ bindings, DLX exchange); env vars `MONGODB_URL`, `MONGODB_DB`, `RABBITMQ_URL`; MongoDB `device_events` time-series collection with `(device_id, recorded_at)` index + `event_id` unique index.

Requirements covered: MSG-01.

Pitfalls addressed: 5 (DLQ topology from the start), 9 (prefetch set in consumer channel init), 14 (assert topology on boot, fail-fast), 11 (timestamp contract established in event schema).

Research flag: **NEEDS RESEARCH** — RabbitMQ topology open decision (exchange types, routing-key patterns) must be resolved before planning. Validate `amqp-connection-manager` v4 channel setup pattern against Fastify `onReady`/`onClose` hooks.

---

**Phase 3 — Command Handler and Dispatcher**

Rationale: Command is the primary write path and the first-class entity at the heart of the event-driven model. The command handler is independently testable as a pure TypeScript module. It must be implemented before the device worker has anything meaningful to consume.

Delivers: `src/lib/device-actions.ts` (TypeBox discriminated-union action schemas per device type); `src/command-handler/translator.ts`; `src/command-handler/index.ts` (resolve selector, validate action, write Command + CommandDeviceTarget, publish effects with publisher confirms); `src/services/command.ts`; `POST /commands` (202 Accepted); `GET /commands/:id`.

Requirements covered: CMD-01–05, MSG-02, STATE-01.

Pitfalls addressed: 2 (ownership in selector resolution), 7 (publisher confirms), 12 (selector anchored to userId).

Research flag: **STANDARD PATTERNS — no additional research needed.**

---

**Phase 4 — Simulated Device Worker**

Rationale: The worker is the stand-in for real hardware and must speak the exact message contract that real devices will use in v2. Standalone worker process (not a Fastify plugin) is cleaner for independent restart.

Delivers: `src/workers/device-simulator.ts` — consumes `device_effects` queue (`prefetch=1`), applies effect to in-memory state map, builds `ReportMessage` with deterministic `report_id`, publishes to `device_reports` exchange; nack/DLQ on malformed effects.

Requirements covered: MSG-03.

Pitfalls addressed: 3 (simulated worker uses same credential contract as v2 hardware), 5 (nack strategy), 9 (`prefetch=1`).

Research flag: **STANDARD PATTERNS — no additional research needed.**

---

**Phase 5 — Report Consumer, State Projection, and Twin-State Reads**

Rationale: The report consumer is the most correctness-critical component. The write-order invariant, idempotency enforcement, and sequence guard must all be in place before the first real message is processed. Twin-state read endpoints depend on the projection being populated.

Delivers: `src/workers/report-consumer.ts` — consumes `device_reports` queue, validates + deduplicates (`event_id` check), appends event to MongoDB, upserts reported state in MariaDB typed table, computes `sync_status`, updates command target + command roll-up, `projection_updated_at` on each upsert; `src/services/twin-state.ts`; `GET /devices/:id/state`, `GET /rooms/:id/state`, `GET /houses/:id/state`.

Requirements covered: MSG-04, MSG-05, STATE-02–05, EVENT-01, EVENT-02, EVENT-06.

Pitfalls addressed: 1 (write-order invariant), 4 (idempotency key + unique index), 6 (`last_event_at` guard on projection upsert), 8 (`projection_updated_at` exposed in API).

Research flag: **NEEDS RESEARCH** — validate idempotency check pattern (unique index behavior) on MongoDB time-series collections before planning.

---

**Phase 6 — Event History Routes**

Rationale: Events are produced by Phase 5; nothing to query before that pipeline runs. The two-step ownership pattern must be the only MongoDB access path.

Delivers: `src/services/event-query.ts` (ownership-scoped two-step, cursor pagination); `GET /devices/:id/events` (with `?before=cursor&limit=N`, ISO 8601 time-range filters with required UTC offset).

Requirements covered: EVENT-03, EVENT-04, EVENT-05.

Pitfalls addressed: 2 (two-step MongoDB access), 11 (UTC offset required in time-range params).

Research flag: **STANDARD PATTERNS — no additional research needed.**

---

**Phase 7 — Integration Tests and End-to-End Verification**

Rationale: The async command-to-event round trip spans three stores and two worker processes. Unit tests cannot verify this path.

Delivers: Command-to-event round-trip tests; cross-tenant 404 tests for every ownership-sensitive endpoint; idempotency tests (redeliver report → exactly one event in Mongo); DLQ routing test (malformed message → lands in DLQ); projection rebuild test (EVENT-06).

Requirements covered: Integration verification of all 33 v1 requirements.

Pitfalls addressed: End-to-end validation of Pitfalls 1, 2, 4, 5.

Research flag: **STANDARD PATTERNS — no additional research needed.**

---

## Confidence Assessment

| Area | Confidence | Notes |
|---|---|---|
| Stack — MongoDB native driver v6 | HIGH | Official driver; time-series API stable since MongoDB 5.0; no Mongoose/Prisma alternatives viable |
| Stack — amqplib + amqp-connection-manager | HIGH | Industry-standard combination; well-maintained |
| Stack — TypeBox discriminated unions for device state | HIGH | Fastify consumes natively; documented and established |
| Stack — typed per-device-type Prisma tables | HIGH | Prescribed by PROJECT.md; standard Prisma pattern |
| Features — command as first-class entity with selector fan-out | HIGH | Fully specified in REQUIREMENTS.md CMD-01–05 |
| Features — twin state (desired + reported + sync_status) | HIGH | AWS IoT Device Shadow / Azure IoT Hub Device Twin confirm this as the standard model |
| Architecture — event-driven write path | HIGH | Well-established event-sourcing/CQRS projection pattern |
| Architecture — projection-without-transactions correctness | HIGH | Write-order + idempotency key + at-least-once + unique index is the documented approach |
| Architecture — MongoDB time-series cursor pagination | MEDIUM | Validate cursor field against actual time-series document structure before Phase 6 planning |
| Pitfalls — dual-store consistency | HIGH | Directly follow from design choices; prevention strategy well-established |
| Pitfalls — cross-tenant MongoDB leakage | HIGH | Confirmed by existing CONCERNS.md; two-step pattern is clear |
| Pitfalls — device identity / spoofing | MEDIUM | Open decision in PROJECT.md; minimum viable protection is clear |
| Open: RabbitMQ topology details | MEDIUM | Client choice is locked; topology details are an open decision for Phase 2 planning |

**Overall: HIGH**

---

## Gaps to Address During Planning

1. **RabbitMQ topology open decision** — Exchange types (topic vs. direct), routing-key patterns for effects and reports, DLQ policy (TTL, max retries). Must be resolved before Phase 2 planning.

2. **Device identity / credential on reports queue** — Broker-level only vs. per-device token validated in the report consumer. Must be resolved before Phase 5 planning. Minimum viable: MariaDB existence check. Recommended: per-device shared secret (same contract as v2 hardware).

3. **`cuid` vs. `uuid` for entity PKs** — Confirm one standard before Phase 1 planning. `cuid` is fine for v1.

4. **MongoDB cursor field on time-series collections** — Validate whether `recorded_at`-based or `_id`-based cursor is correct. `_id` on time-series documents is bucket-generated, not per-measurement.

5. **Event retention defaults** — Collection must be created at Phase 2 with a retention approach in mind. Confirm default (no TTL for v1?) before Phase 2 planning.

6. **Worker process topology** — Standalone Node.js processes (preferred) vs. `fastify.addHook('onReady')` spawned threads. Resolve before Phase 4/5 planning.

---

## Sources (Aggregated)

- Project ground truth: `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md` (HIGH confidence, authoritative)
- Project codebase: `CLAUDE.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md` (HIGH confidence, direct analysis)
- MongoDB Node.js Driver v6 documentation (official)
- `amqplib` and `amqp-connection-manager` npm/GitHub documentation
- `@sinclair/typebox` v0.34 + `@fastify/type-provider-typebox` official Fastify docs
- Domain references: AWS IoT Device Shadow, Azure IoT Hub Device Twin, Home Assistant, Apple HomeKit, Google Home API, Tuya Cloud API, SmartThings, OpenHAB
- Event-sourcing / CQRS community practice: projection-without-transactions, idempotent consumer, at-least-once delivery handling
- RabbitMQ documentation: topic exchange, DLQ, prefetch, publisher confirms, at-least-once semantics
