# Requirements: Smart House

**Defined:** 2026-06-25
**Updated:** 2026-06-28 (single current-state projection via morph; user_id denorm; soft-delete everywhere)
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

- [ ] **STATE-01**: A device report updates that device's single current-state record (atomic guarded upsert; applied only if newer than the last event)
- [ ] **STATE-02**: User can read the current state of a single device they own
- [ ] **STATE-03**: User can read current state for all devices in a room
- [ ] **STATE-04**: User can read a full current-state snapshot of a house

### Commands

- [ ] **CMD-01**: User can issue a command targeting devices via a selector (explicit ids, a room, or a house — with optional device-type filter)
- [ ] **CMD-02**: The command handler resolves the selector to the user's owned device set (cross-tenant targets excluded)
- [ ] **CMD-03**: An action invalid for a targeted device type is rejected with a validation error (400) before any dispatch
- [ ] **CMD-04**: A command fans out to all resolved devices (best-effort); one command intent is recorded, linked to per-device effects; the command carries the desired intent + per-device status
- [ ] **CMD-05**: User can query a command's status (`GET /commands/:id`), including per-device completion (pending / done / partially_failed)

### Messaging (RabbitMQ)

- [ ] **MSG-01**: On boot the app provisions the RabbitMQ topology — effects exchange (outbound) and reports queue (inbound), with a dead-letter queue
- [ ] **MSG-02**: The command handler translates each command into per-device effects and publishes them to the broker
- [ ] **MSG-03**: A simulated device worker consumes effects, applies them, and publishes a report back (stand-in for hardware)
- [ ] **MSG-04**: A report consumer ingests reports (validating the `device_id` exists and is owned; `device_token` envelope field reserved, unenforced in v1), appends an event (MongoDB), and updates the device's current-state record (MariaDB)
- [ ] **MSG-05**: Undeliverable effects and malformed/failed reports are retried and dead-lettered (DLQ)

### Event History (MongoDB)

- [ ] **EVENT-01**: Every effect (command-originated) and report (device-originated) is recorded as an immutable event document in MongoDB (`source`, `event_kind`, `device_id`, `device_type`, `command_id`, snapshot, `recorded_at`)
- [ ] **EVENT-02**: A multi-device command produces one linked event per involved device (shared `command_id`)
- [ ] **EVENT-03**: User can query a device's event history (ownership-scoped: owned device ids resolved in MariaDB first)
- [ ] **EVENT-04**: User can filter event history by time range
- [ ] **EVENT-05**: Event history queries use cursor pagination
- [ ] **EVENT-06**: The event log is the source of truth; the current-state projection can be rebuilt by replay (no DB transactions)

### Data Conventions

- [ ] **DATA-01**: All DB tables/columns use snake_case via Prisma `@map`/`@@map`, including existing `User` and `RefreshToken` models
- [ ] **DATA-02**: `user_id` is denormalized onto Room and Device; ownership checks use it directly (no joins through the hierarchy)
- [ ] **DATA-03**: Soft delete (`deleted_at`) on User, House, Room, Device; all reads exclude soft-deleted rows; a soft-deleted user cannot authenticate
- [ ] **DATA-04**: Multi-device operations use batched `IN` queries (no N+1); current-state and command-status writes use atomic guarded statements (not read-then-write); event idempotency via a MongoDB unique index on a deterministic event id

### Testing

Tests use the existing convention: Node's built-in runner (`node:test` + `node:assert`), the `build(t)` helper that spins up a full Fastify instance, and `app.inject()` (no real HTTP). Tests run against compiled `dist/`. Async integration tests use **testcontainers** to spin up real MariaDB + MongoDB + RabbitMQ; infra-free logic (validators, selector resolution, translator) uses pure unit tests. Each phase ships its own tests; the items below are the cross-cutting guarantees.

- [ ] **TEST-01**: Every ownership-scoped endpoint has a multi-tenancy test — a second user gets 404 for resources they don't own
- [ ] **TEST-02**: Command→event round-trip test — issuing a command produces effects, the simulated worker reports, an event is appended (MongoDB), and the device's current state is updated
- [ ] **TEST-03**: Idempotency test — a redelivered report yields exactly one event (unique-index dedupe) and does not corrupt current state
- [ ] **TEST-04**: DLQ test — a malformed/poison message is dead-lettered rather than retried forever
- [ ] **TEST-05**: Soft-delete tests — soft-deleted rows are excluded from all reads; a soft-deleted user cannot authenticate
- [ ] **TEST-06**: Projection rebuild test — current state can be rebuilt from the event log (validates EVENT-06)
- [ ] **TEST-07**: Validation tests — an illogical command action for a device type is rejected with 400 before dispatch (CMD-03)
- [ ] **TEST-08**: Auth-boundary tests — every new endpoint returns 401 when called without a valid token
- [ ] **TEST-09**: Per-device-type state validation — for each device type, valid state values are accepted and out-of-range/invalid values rejected (brightness 0–100, AC temp bounds, sensor is report-only, etc.)
- [ ] **TEST-10**: Out-of-order guard test — an older (stale) report does not overwrite newer current state (validates the `last_event_at` guard; distinct from idempotency)
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

## Resolved Decisions (2026-06-29)

| Decision | Resolution | Affects |
|----------|-----------|---------|
| Device report trust | Validate `device_id` exists/owned in v1; reserve a `device_token` envelope field (unenforced) for v2 per-device secrets | MSG-04, report consumer |
| Entity PK type | **uuid v7** for new entities (House/Room/Device/Command); User/RefreshToken stay Int | Houses phase (first entity) |
| RabbitMQ topology | **Topic** exchanges (effects/reports) + dead-letter exchange/queue; `prefetch=1` on consumers | MSG-01 |
| Event retention | **No TTL in v1** — retain all events; archival deferred | EVENT-07 (v2) |
| Test infrastructure | **Testcontainers** (MariaDB + MongoDB + RabbitMQ) for async integration tests; pure unit tests for infra-free logic | TEST-02..06 |
| Existing table names | Align `User`/`RefreshToken` to `users`/`refresh_tokens` via `@@map` (rename migration); columns already mapped | DATA-01 |

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

## Traceability

Which phases cover which requirements. **Stale — to be repopulated when the roadmap is regenerated after architecture changes.**

| Requirement | Phase | Status |
|-------------|-------|--------|
| (pending roadmap regeneration) | — | Pending |

**Coverage:**
- v1 requirements: 45 total (HOUSE 5, ROOM 4, DEV 5, STATE 4, CMD 5, MSG 5, EVENT 6, DATA 4, TEST 12)
- Mapped to phases: 0 (pending roadmap regeneration)
- Unmapped: 45 ⚠️

---
*Requirements defined: 2026-06-25*
*Last updated: 2026-06-28 after architecture discussion*
