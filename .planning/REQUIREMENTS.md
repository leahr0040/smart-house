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
- [ ] **MSG-04**: A report consumer ingests reports, appends an event (MongoDB), and updates the device's current-state record (MariaDB)
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

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### History & Devices

- **EVENT-07**: Event retention policy (e.g. configurable age-based purge / archival)
- **EVENT-08**: Filter event history by room and by event type
- **DEV-06**: Device presence tracking (`last_seen_at`)
- **HOUSE-06**: Per-house timezone for history rendering
- **STATE-05**: Typed-SQL filtering on state values (e.g. "all ACs above 25°") via a richer projection

## Open Decisions

Resolve before planning the relevant phase (not yet committed to a requirement).

| Decision | Affects |
|----------|---------|
| Device identity/auth: broker-level only vs per-device token validated in the report consumer | MSG-04, report consumer |
| `cuid` vs `uuid` for entity PKs | Houses phase (first entity) |
| Concrete RabbitMQ topology (exchange types, routing keys, DLQ policy) | MSG-01 |
| Event retention defaults | EVENT-07 (v2) |

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
- v1 requirements: 33 total (HOUSE 5, ROOM 4, DEV 5, STATE 4, CMD 5, MSG 5, EVENT 6 incl. EVENT-06 system invariant, DATA 4 minus overlap)
- Mapped to phases: 0 (pending roadmap regeneration)
- Unmapped: 33 ⚠️

---
*Requirements defined: 2026-06-25*
*Last updated: 2026-06-28 after architecture discussion*
