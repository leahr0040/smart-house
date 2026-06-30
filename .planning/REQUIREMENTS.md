# Requirements: Smart House

**Defined:** 2026-06-25
**Updated:** 2026-06-29 (gap-review: CMD-06 and MSG-06 added; traceability fully repopulated for 47 v1 requirements)
**Core Value:** The system always reflects the true current state of the house AND preserves a complete, queryable history of every event.

## v1 Requirements

Requirements for the event-driven smart-home platform milestone. Built on the existing Fastify 5 + Prisma + MariaDB auth API; adds MongoDB (events) and RabbitMQ (messaging).

### Houses

- [ ] **HOUSE-01**: User can create a house
- [ ] **HOUSE-02**: User can list and view their own houses
- [ ] **HOUSE-03**: User can update a house they own
- [ ] **HOUSE-04**: User can delete a house they own (soft delete)
- [ ] **HOUSE-05**: A user can only access houses they own (cross-tenant access returns 404)

### Rooms

- [ ] **ROOM-01**: User can create a room in a house they own
- [ ] **ROOM-02**: User can list rooms in a house they own
- [ ] **ROOM-03**: User can update a room they own
- [ ] **ROOM-04**: User can delete a room they own (soft delete)

### Devices

- [ ] **DEV-01**: User can add a device of a known type (light, AC, heater, sensor) to a room
- [ ] **DEV-02**: User can list and view devices by room and by house
- [ ] **DEV-03**: User can update device metadata (e.g. name)
- [ ] **DEV-04**: User can remove a device (soft delete)
- [ ] **DEV-05**: Per-device-type current state is typed via polymorphic morph (`state_type` + `state_id` → per-type detail tables), validated by TypeBox; no JSON, single current facet (no desired/reported twin)

### Device State (current state projection)

- [ ] **STATE-01**: The per-device state detail row is created eagerly at device creation (defaults; `state_type`/`state_id` fixed then); a device report guarded-updates it (apply only if `(last_event_at, last_event_id) < (:recorded_at, :event_id)` — tuple tiebreaker, no create in the hot path) as part of the consumer's single MariaDB transaction (event insert + this update + target CAS + roll-up)
- [ ] **STATE-02**: User can read the current state of a single device they own
- [ ] **STATE-03**: User can read current state for all devices in a room
- [ ] **STATE-04**: User can read a full current-state snapshot of a house

### Commands

- [ ] **CMD-01**: User can issue a command targeting devices via a selector (explicit ids, a room, or a house — with optional device-type filter)
- [ ] **CMD-02**: The command handler resolves the selector to the user's owned device set (cross-tenant targets excluded)
- [ ] **CMD-03**: An action invalid for a targeted device type is rejected with a validation error (400) before any dispatch
- [ ] **CMD-04**: A command fans out to all resolved devices (best-effort); one command intent is recorded, linked to per-device effects; the command carries the desired intent + per-device status
- [ ] **CMD-05**: User can query a command's status (`GET /commands/:id`), including per-device completion (pending / done / failed)
- [ ] **CMD-06**: Command targets reach a terminal state via **compare-and-set** (`pending → done|failed` only, never overwriting a terminal state): a success report → `done`; a worker failure report or a timeout **reaper** (target still `pending` past its `deadline_at`) → `failed`. **First terminal wins** — a late success after a reaper-`failed` is recorded as an event but does not flip the status. The command rolls up: all done → `done`, all failed → `failed`, mixed → `partially_failed`.
- [ ] **CMD-07**: Command creation persists the command + `command_targets` (one transaction) **before** publishing effects (never publish-first). A selector resolving to more than a configurable max (default ~200) targets is rejected with 400.

### Messaging (RabbitMQ)

- [ ] **MSG-01**: On boot the app provisions the RabbitMQ topology (topic effects + reports exchanges, queues, dead-letter exchange/queue, `prefetch=1`). Env-var validation fails fast, but transient broker unavailability does NOT block startup (background reconnect); auth + CRUD + state/event reads (all MariaDB) stay available, while `POST /commands` returns 503 while the broker is down
- [ ] **MSG-02**: The command handler translates each command into per-device effects and publishes them to the broker
- [ ] **MSG-03**: A simulated device worker — run as a separate process via `npm run worker` — consumes effects, applies them, and publishes a report back (stand-in for hardware). The API process owns/declares the RabbitMQ topology; the worker asserts it idempotently on boot.
- [ ] **MSG-04**: A report consumer ingests reports (validating the `device_id` exists and is owned; `device_token` envelope field reserved, unenforced in v1), and in **one MariaDB transaction** appends the event row, guarded-updates the current-state row, CAS-updates the command target, and recomputes the command roll-up
- [ ] **MSG-05**: Undeliverable effects and malformed/unparseable/unknown-`device_id` reports are dead-lettered (DLQ). v1 does **not** drain or alert the DLQ — manual inspection only (`// ponytail: DLQ drain + alert later`)
- [ ] **MSG-06**: The simulated worker publishes an explicit **failure report** when it receives a valid effect it cannot apply (distinct from malformed effects, which are nacked to the DLQ); the report consumer marks the target `failed`

### Event History (MongoDB)

- [ ] **EVENT-01**: Every effect (command-originated) and report (device-originated) is recorded as an immutable row in a MariaDB append-only `events` table (`event_id` = producer-minted `report_id` uuid v7 with a **unique index**, `source`, `event_kind`, `device_id`, `device_type`, `command_id` nullable, snapshot, `recorded_at`; index on `(device_id, recorded_at)`)
- [ ] **EVENT-02**: A multi-device command produces one linked event per involved device (shared `command_id`)
- [ ] **EVENT-03**: User can query a device's event history (ownership-scoped; the history of a soft-deleted device the user owns remains readable)
- [ ] **EVENT-04**: User can filter event history by time range
- [ ] **EVENT-05**: Event history queries use cursor pagination
- [ ] **EVENT-06**: The MariaDB `events` table is the source of truth; the current-state projection can be rebuilt by replaying events

### Data Conventions

- [ ] **DATA-01**: All DB tables/columns use snake_case via Prisma `@map`/`@@map`, including existing `User` and `RefreshToken` models. (When renaming the existing tables, hand-verify the generated migration SQL emits `RENAME TABLE`, not drop+recreate — no data loss.)
- [ ] **DATA-02**: `user_id` is denormalized onto Room and Device; ownership checks use it directly (no joins through the hierarchy)
- [ ] **DATA-03**: Soft delete (`deleted_at`) on User, House, Room, Device; all reads exclude soft-deleted rows; a soft-deleted user cannot authenticate
- [ ] **DATA-04**: Multi-device operations use batched `IN` queries (no N+1); current-state writes use a tuple-guarded `UPDATE … WHERE (last_event_at, last_event_id) < (:recorded_at, :event_id)` (stores `last_event_id`; uuid v7 makes this deterministic); event idempotency via a **MariaDB unique index on `event_id`** (= producer-minted `report_id`), message-identity dedupe; target transitions are compare-and-set. The report consumer runs these as **one MariaDB transaction** (single store); a transaction is **never** a substitute for the idempotency guard.

### Testing

Tests use the existing convention: Node's built-in runner (`node:test` + `node:assert`), the `build(t)` helper that spins up a full Fastify instance, and `app.inject()` (no real HTTP). Tests run against compiled `dist/`. Async integration tests use **testcontainers** to spin up real MariaDB + RabbitMQ (2 containers, started once via a **shared suite-level fixture** — not per-file — to stay tolerable on Windows/Docker Desktop); infra-free logic (validators, selector resolution, translator) uses pure unit tests. Each phase ships its own tests; the items below are the cross-cutting guarantees.

- [ ] **TEST-01**: Every ownership-scoped endpoint has a multi-tenancy test — a second user gets 404 for resources they don't own
- [ ] **TEST-02**: Command→event round-trip test — issuing a command produces effects, the simulated worker reports, an event is appended (MongoDB), and the device's current state is updated
- [ ] **TEST-03**: Idempotency test — a redelivered report yields exactly one event (unique-index dedupe) and does not corrupt current state
- [ ] **TEST-04**: DLQ test — a malformed/poison message is dead-lettered rather than retried forever
- [ ] **TEST-05**: Soft-delete tests — soft-deleted rows are excluded from all reads; a soft-deleted user cannot authenticate
- [ ] **TEST-06**: Projection rebuild test — current state can be rebuilt from the event log (validates EVENT-06)
- [ ] **TEST-07**: Validation tests — an illogical command action for a device type is rejected with 400 before dispatch (CMD-03)
- [ ] **TEST-08**: Auth-boundary tests — every new endpoint returns 401 when called without a valid token
- [ ] **TEST-09**: Per-device-type state validation — for each device type, valid state values are accepted and out-of-range/invalid values rejected (brightness 0–100, AC temp bounds, sensor is report-only, etc.)
- [ ] **TEST-10**: Out-of-order guard test — an older (stale) report does not overwrite newer current state (validates the `(last_event_at, last_event_id)` tuple guard; distinct from idempotency)
- [ ] **TEST-11**: Selector + fan-out tests — a room/house selector (with optional type filter) resolves to exactly the owned matching devices; a multi-device command emits one event per device sharing `command_id`; a partial failure rolls up to `partially_failed`
- [ ] **TEST-12**: History query tests — time-range filtering returns only in-range events; cursor pagination is stable under concurrent appends (no duplicates or gaps across pages); a user cannot read another user's device events

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### History & Devices

- **EVENT-07**: Event retention policy (e.g. configurable age-based purge / archival)
- **EVENT-08**: Filter event history by room and by event type
- **DEV-06**: Device presence tracking (`last_seen_at`)
- **HOUSE-06**: Per-house timezone for history rendering
- **STATE-05**: Typed-SQL filtering on state values (e.g. "all ACs above 25°") via a richer projection
- **TELEM-01**: Autonomous sensor telemetry — a sensor simulator publishes periodic command-less readings (`command_id` null, `source` REPORT, `event_kind` READING) at a configurable cadence; the report consumer ingests command-less reports. (Deferred from v1.)

## Resolved Decisions (2026-06-29)

| Decision | Resolution | Affects |
|----------|-----------|---------|
| Device report trust | Validate `device_id` exists/owned in v1; reserve a `device_token` envelope field (unenforced) for v2 per-device secrets | MSG-04, report consumer |
| Entity PK type | **uuid v7** for new entities (House/Room/Device/Command); User/RefreshToken stay Int | Houses phase (first entity) |
| RabbitMQ topology | **Topic** exchanges (effects/reports) + dead-letter exchange/queue; `prefetch=1` on consumers | MSG-01 |
| Event retention | **No TTL in v1** — retain all events; archival deferred | EVENT-07 (v2) |
| **Event store** | **Single-store MariaDB** append-only `events` table (dropped MongoDB) — resolves the dual-store consistency tax and the time-series/unique-index contradiction; consumer writes become one local transaction | EVENT-*, MSG-04, STATE-01, DATA-04, Phase 1/3/6 |
| Test infrastructure | **Testcontainers** (MariaDB + RabbitMQ, shared suite-level fixture) for async integration tests; pure unit tests for infra-free logic | TEST-02..06 |
| Existing table names | Align `User`/`RefreshToken` to `users`/`refresh_tokens` via `@@map` (rename migration); columns already mapped | DATA-01 |
| Idempotency key | Producer-minted `report_id` (uuid v7) = `event_id`; message-identity dedupe | DATA-04, EVENT-01 |
| Tuple guard columns | State detail rows store `last_event_at` AND `last_event_id`; guard is tuple compare, not strictly-less-than timestamp | DATA-04, STATE-01 |
| Eager state row | Created at device creation with defaults; consumer ONLY does a guarded UPDATE, never a create | STATE-01 |
| Boot resilience | Env fail-fast; broker/Mongo connect in background; auth/CRUD unaffected; dependent endpoints 503 | MSG-01 |
| Worker process | Separate process (`npm run worker`); API owns topology; worker asserts idempotently | MSG-03 |
| Terminal state / reaper | `deadline_at` on CommandTarget; reaper sweeps pending-past-deadline → failed; roll-up: done/partially_failed/failed | CMD-06 |
| Autonomous telemetry | Deferred to v2; all v1 reports are command-driven | TELEM-01 (v2) |

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| AI automation-suggestion engine | Future milestone; v1 builds the event foundation it will consume |
| Real hardware device drivers / physical protocol adapters | v1 uses a simulated device worker over RabbitMQ; messaging infra is in scope, physical drivers are not |
| Web UI / dashboard | API-only for v1; consumed by clients and a future frontend |
| WebSocket / SSE live push to clients | Clients poll REST for v1 |
| OAuth / social login | Email/password auth already shipped and sufficient |
| Desired/reported twin state per device | Desired intent lives on the command; only the real current state is projected |
| Separate datastore for events (MongoDB / time-series DB) | MariaDB append-only `events` table suffices for v1; re-extract to a time-series store in a future phase if write volume demands it (rebuilt from the log) |

## Traceability

⚠️ **Stale** — dropped MongoDB (single-store MariaDB) and added CMD-07; pending roadmap regeneration.

| Requirement | Phase | Status |
|-------------|-------|--------|
| DATA-01 | Phase 1 | Pending |
| DATA-02 | Phase 1 | Pending |
| DATA-03 | Phase 1 | Pending |
| DATA-04 | Phase 1 | Pending |
| HOUSE-01 | Phase 2 | Pending |
| HOUSE-02 | Phase 2 | Pending |
| HOUSE-03 | Phase 2 | Pending |
| HOUSE-04 | Phase 2 | Pending |
| HOUSE-05 | Phase 2 | Pending |
| ROOM-01 | Phase 2 | Pending |
| ROOM-02 | Phase 2 | Pending |
| ROOM-03 | Phase 2 | Pending |
| ROOM-04 | Phase 2 | Pending |
| DEV-01 | Phase 2 | Pending |
| DEV-02 | Phase 2 | Pending |
| DEV-03 | Phase 2 | Pending |
| DEV-04 | Phase 2 | Pending |
| DEV-05 | Phase 2 | Pending |
| STATE-01 | Phase 2 | Pending |
| TEST-01 | Phase 2 | Pending |
| TEST-05 | Phase 2 | Pending |
| TEST-08 | Phase 2 | Pending |
| MSG-01 | Phase 3 | Pending |
| CMD-01 | Phase 4 | Pending |
| CMD-02 | Phase 4 | Pending |
| CMD-03 | Phase 4 | Pending |
| CMD-04 | Phase 4 | Pending |
| CMD-05 | Phase 4 | Pending |
| CMD-06 | Phase 4 | Pending |
| MSG-02 | Phase 4 | Pending |
| TEST-07 | Phase 4 | Pending |
| MSG-03 | Phase 5 | Pending |
| MSG-06 | Phase 5 | Pending |
| MSG-04 | Phase 6 | Pending |
| MSG-05 | Phase 6 | Pending |
| STATE-02 | Phase 6 | Pending |
| STATE-03 | Phase 6 | Pending |
| STATE-04 | Phase 6 | Pending |
| EVENT-01 | Phase 6 | Pending |
| EVENT-02 | Phase 6 | Pending |
| EVENT-06 | Phase 6 | Pending |
| TEST-03 | Phase 6 | Pending |
| TEST-04 | Phase 6 | Pending |
| TEST-06 | Phase 6 | Pending |
| TEST-09 | Phase 6 | Pending |
| TEST-10 | Phase 6 | Pending |
| EVENT-03 | Phase 7 | Pending |
| EVENT-04 | Phase 7 | Pending |
| EVENT-05 | Phase 7 | Pending |
| TEST-12 | Phase 7 | Pending |
| TEST-02 | Phase 8 | Pending |
| TEST-11 | Phase 8 | Pending |

**Coverage:** 47/47 v1 requirements mapped ✓
- HOUSE: 5/5 (Phase 2)
- ROOM: 4/4 (Phase 2)
- DEV: 5/5 (Phase 2)
- STATE: 4/4 (STATE-01 → Phase 2; STATE-02/03/04 → Phase 6)
- CMD: 6/6 (all Phase 4)
- MSG: 6/6 (MSG-01 → Phase 3; MSG-02 → Phase 4; MSG-03/MSG-06 → Phase 5; MSG-04/05 → Phase 6)
- EVENT: 6/6 (EVENT-01/02/06 → Phase 6; EVENT-03/04/05 → Phase 7)
- DATA: 4/4 (Phase 1)
- TEST: 12/12 (Phases 2, 4, 6, 7, 8)

---
*Requirements defined: 2026-06-25*
*Last updated: 2026-06-29 — gap-review round: CMD-06 and MSG-06 added and mapped; traceability fully repopulated for all 47 v1 requirements; STATE-01 moved to Phase 2 (eager row at device creation); DATA-04 guard language updated to tuple (last_event_at, last_event_id)*
