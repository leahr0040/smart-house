# Requirements: Smart House

**Core Value:** The system always reflects the true current state of the house AND preserves a complete, queryable history of every event.

The event-driven smart-home platform milestone, built on the existing Fastify 5 + Prisma + MariaDB auth API; adds RabbitMQ (messaging) and an append-only MariaDB `events` table.

## v1 Requirements

### Houses

- [x] **HOUSE-01**: User can create a house
- [x] **HOUSE-02**: User can list and view their own houses
- [x] **HOUSE-03**: User can update a house they own
- [x] **HOUSE-04**: User can delete a house they own (soft delete)
- [x] **HOUSE-05**: A user can only access houses they own (cross-tenant access returns 404)

### Rooms

- [x] **ROOM-01**: User can create a room in a house they own
- [x] **ROOM-02**: User can list rooms in a house they own
- [x] **ROOM-03**: User can update a room they own
- [x] **ROOM-04**: User can delete a room they own (soft delete)

### Devices

- [x] **DEV-01**: User can add a device of a known type (light, AC, heater, sensor) to a room
- [x] **DEV-02**: User can list and view devices by room and by house
- [x] **DEV-03**: User can update device metadata (e.g. name)
- [x] **DEV-04**: User can remove a device (soft delete)
- [x] **DEV-05**: Per-device-type current state is typed via per-type detail tables selected by `device_type` (each detail row holds a unique `device_id`; no morph pointer column on the device), validated by TypeBox; no JSON, single current facet

### Device State (current-state projection)

- [x] **STATE-01**: The per-device state detail row is created eagerly at device creation (defaults; the row's `device_type`-selected table is fixed then); a device report guarded-updates it (apply only if `(last_event_at, last_event_id) < (:recorded_at, :event_id)`, no create in the hot path) as part of the consumer's single MariaDB transaction
- [ ] **STATE-02**: User can read the current state of a single device they own
- [ ] **STATE-03**: User can read current state for all devices in a room
- [ ] **STATE-04**: User can read a full current-state snapshot of a house

### Commands

- [ ] **CMD-01**: User can issue a command targeting devices via a selector (explicit ids, a room, or a house — with optional device-type filter)
- [ ] **CMD-02**: The command handler resolves the selector to the user's owned device set (cross-tenant targets excluded)
- [ ] **CMD-03**: Validation is layered. **Acceptance** (sync, pre-persist → 400): shape/types/format/required, selector well-formed, valid action object, fan-out cap. **Action↔type compatibility** is checked synchronously (→ 400) **only for explicit-device-id selectors**; type-scoped selectors need no check, and untyped scope selectors defer per-target action↔type to async (CMD-08)
- [ ] **CMD-04**: A command fans out to all resolved devices (best-effort); one command intent is recorded, linked to per-device effects
- [ ] **CMD-05**: User can query a command's status (`GET /commands/:id`, ownership via denormalized `user_id` on Command) — command status (received / rejected / pending / done / partially_failed / failed / no_targets) and per-device target completion (pending / done / failed)
- [ ] **CMD-06**: Command targets reach a terminal state via **compare-and-set** (`pending → done|failed` only, never overwriting a terminal state): a success report → `done`; a worker failure report or a timeout **reaper** (target still `pending` past its `deadline_at`) → `failed`. **First terminal wins** — a late success after a reaper-`failed` is recorded as an event but does not flip the status. The command rolls up: all done → `done`, all failed → `failed`, mixed → `partially_failed`
- [ ] **CMD-07**: Command creation persists the command (`received`) + `command_targets` (one transaction) **before** publishing effects (never publish-first). Resolution edges: `> ~200` targets → 400; explicit-device-id selector resolving to 0 owned → 400; scope selector matching 0 → terminal status `no_targets`
- [ ] **CMD-08**: Async type validation splits by who can know the rule. **Device-knowable** (worker/device path): action↔type for non-homogeneous targets, value/range constraints, current-state preconditions, availability/reachability. **Platform gates** (platform, not the device): device deleted, house active, ownership/lifecycle — enforced at selector-resolution time and re-checked at report-consume time. Failures become state transitions + failure reports + lifecycle events, never a synchronous rejection of the already-accepted command

### Messaging (RabbitMQ)

- [ ] **MSG-01**: On boot the app provisions the RabbitMQ topology — topic effects + reports exchanges; for **each consumer queue**: the main queue, a `*.retry` wait queue (`x-message-ttl` backoff ~30s, dead-lettering back to the main exchange), and a terminal `*.dlq`; `prefetch=1`. Env-var validation fails fast, but transient broker unavailability does NOT block startup (background reconnect); auth + CRUD + state/event reads stay available, while `POST /commands` returns 503 while the broker is down
- [ ] **MSG-02**: The command handler translates each command into per-device effects and publishes them to the broker
- [ ] **MSG-03**: A simulated device worker — run as a separate process via `npm run worker` — consumes effects, applies them, and publishes a report back. It mints the report's `event_id` deterministically (`uuidv5(command_target_id)`) and stamps `recorded_at` as event-time, so an effect redelivery re-produces the same `event_id`. The API process owns/declares the topology; the worker asserts it idempotently
- [ ] **MSG-04**: A report consumer ingests reports (validating the `device_id` exists and is owned; `device_token` reserved, unenforced in v1), and in **one MariaDB transaction** appends the event row, guarded-updates the current-state row, CAS-updates the command target, and recomputes the command roll-up under a `SELECT … FOR UPDATE` lock on the command
- [ ] **MSG-05**: Failures route by **reason**: **poison** (malformed/unparseable/unknown message) → DLQ, no retry; **transient/uncertain** (device offline/unreachable, timeout) → **nack (no requeue) → `*.retry` wait queue (TTL backoff) → dead-letters back to the main queue; `x-death` count bounds retries (default ~5), then park in the terminal DLQ** (plain `requeue=true` is never used — it hot-spins and never advances `x-death`); **determined domain outcome** (device deleted, action rejected, value out of range, type-incompatible, failed type validation) → **failure report → target `failed`/`rejected`, acked** (NOT dead-lettered). v1 does not drain/alert the DLQ — manual inspection only
- [ ] **MSG-06**: The worker classifies a failed effect by reason — a **determined** rejection → explicit **failure report** (consumer marks target `failed`/`rejected`, never DLQ); a **transient** condition (offline/timeout) → **nack (no requeue) → `*.retry` wait queue (delayed redelivery); after ~5 attempts (`x-death`) → terminal DLQ**

### Event History

- [ ] **EVENT-01**: Every effect and report is recorded as an immutable row in the MariaDB append-only `events` table (`event_id` = deterministic `uuidv5(command_target_id [+ outcome])` with a **unique index**; `entity_type` (device | command), `source`, `event_kind`, `device_id` nullable, `device_type`, `command_id` nullable, snapshot, `recorded_at` = producer event-time; index on `(device_id, recorded_at)`). Command-lifecycle milestones (`command.received` / `resolved` / `rejected` / `completed`) are `entity_type=command` rows (`device_id` null)
- [ ] **EVENT-02**: A multi-device command produces one linked event row per involved device (shared `command_id`)
- [ ] **EVENT-03**: User can query a device's event history (ownership-scoped; the history of a soft-deleted device the user owns remains readable)
- [ ] **EVENT-04**: User can filter event history by time range
- [ ] **EVENT-05**: Event history queries use cursor pagination on `(recorded_at, event_id)`
- [ ] **EVENT-06**: The `events` table is the source of truth; the current-state projection can be rebuilt by replaying events

### Data Conventions

- [x] **DATA-01**: All DB tables/columns use snake_case via Prisma `@map`/`@@map`, including existing `User` and `RefreshToken` models. The existing-table rename uses a **hand-authored `ALTER TABLE … RENAME` migration** (not a generated diff)
- [x] **DATA-02**: `user_id` is denormalized onto Room, Device, and Command; ownership checks use it directly (no joins through the hierarchy), including `GET /commands/:id`
- [x] **DATA-03**: Soft delete (`deleted_at`) on User, House, Room, Device; all reads exclude soft-deleted rows; a soft-deleted user cannot authenticate
- [x] **DATA-04**: Multi-device operations use batched `IN` queries (no N+1); current-state writes use a tuple-guarded `UPDATE`; event idempotency via a **MariaDB unique index on the deterministic `event_id`**; target transitions are compare-and-set; the roll-up runs under a `SELECT … FOR UPDATE` on the command. The report consumer runs these as **one MariaDB transaction**

### Testing

Tests use the existing convention: `node:test` + `node:assert`, the `build(t)` helper, and `app.inject()`, against compiled `dist/`. Async integration tests use **testcontainers** (MariaDB + RabbitMQ, 2 containers via a shared suite-level fixture with a between-test reset: truncate tables + purge queues); infra-free logic (validators, selector resolution, translator) uses pure unit tests. Each phase ships its own tests; the below are cross-cutting.

- [x] **TEST-01**: Every ownership-scoped endpoint has a multi-tenancy test — a second user gets 404 for resources they don't own
- [ ] **TEST-02**: Command→event round-trip — a command produces effects, the worker reports, an event is appended, and current state updates
- [ ] **TEST-03**: Idempotency — a redelivered effect/report yields exactly one event (deterministic `event_id`) and does not corrupt current state
- [ ] **TEST-04**: DLQ — a poison message is dead-lettered rather than retried forever
- [x] **TEST-05**: Soft-delete — soft-deleted rows excluded from all reads; a soft-deleted user cannot authenticate
- [ ] **TEST-06**: Projection rebuild — current state can be rebuilt from the event log (validates EVENT-06)
- [ ] **TEST-07**: Acceptance/type validation — a malformed request → 400; an explicit-id action↔type mismatch → 400
- [x] **TEST-08**: Auth boundary — every new endpoint returns 401 without a valid token
- [ ] **TEST-09**: Device-type value validation — valid state values accepted, out-of-range rejected (via async type validation)
- [ ] **TEST-10**: Out-of-order guard — a stale report does not overwrite newer current state
- [ ] **TEST-11**: Selector + fan-out — a room/house selector resolves exactly the owned matching devices; a multi-device command emits one event per device sharing `command_id`; a partial failure rolls up to `partially_failed`
- [ ] **TEST-12**: History query — time-range filtering returns only in-range events; cursor pagination is stable under concurrent appends; a user cannot read another user's device events

## Design Decisions

| Decision | Choice |
|----------|--------|
| Event store | Single-store MariaDB append-only `events` table (source of truth) |
| Consistency | One MariaDB transaction per report; guarded state update; CAS target; roll-up under command row lock |
| Idempotency | Deterministic `event_id = uuidv5(command_target_id)`; MariaDB unique index |
| Event time | Producer-minted `recorded_at` (event-time) |
| Current state | Single facet per device via polymorphic morph; per-device limits/config in DB |
| Action vocabulary | Code (TypeBox registry in `device-actions.ts`); registry-seamed for a v2 DB source |
| Validation | Two tiers: sync acceptance (structural + action↔type for explicit-id) / async type validation (device-knowable in worker, platform gates on platform) |
| Failure routing | poison → DLQ; transient/offline → nack (no requeue) → `*.retry` wait queue (fixed ~30s TTL) → main, `x-death`-bounded (~5) → DLQ; determined → failure report (acked); DLQ not drained in v1 |
| Command | First-class entity + `command_targets`; selector union; `user_id` denormalized; CAS terminal (first-terminal-wins); `deadline_at` + reaper |
| Empty selector | Explicit-id 0-owned → 400; scope 0-match → `no_targets` |
| Fan-out cap | ~200 targets, else 400 |
| PKs | uuid v7 for new entities; User/RefreshToken Int |
| Existing tables | `@@map` rename via hand-authored `ALTER TABLE … RENAME` |
| RabbitMQ | Topic exchanges; per consumer queue: main + `*.retry` wait queue (fixed ~30s TTL, DLX→main) + terminal DLQ; `prefetch=1`; API owns topology; worker a separate process |
| Boot | Env fail-fast; broker background connect; `POST /commands` → 503 when broker down |
| Device report trust | Existence/ownership check; `device_token` reserved for v2 |
| Event retention | No TTL in v1 |
| Tests | Testcontainers (MariaDB + RabbitMQ, shared fixture + between-test reset) |
| Client idempotency | None in v1 (absolute actions) |
| Not in v1 | Redis; separate event datastore; autonomous sensor telemetry; Web UI; real hardware drivers |

## v2 Requirements

- **TELEM-01**: Autonomous sensor telemetry — a sensor simulator publishes periodic command-less readings at a configurable cadence; the consumer ingests them
- **EVENT-07**: Event retention / archival policy
- **EVENT-08**: Filter event history by room and by event type
- **DEV-06**: Device presence tracking (`last_seen_at`)
- **HOUSE-06**: Per-house timezone for history rendering
- **STATE-05**: Typed-SQL filtering on state values via a richer projection

## Out of Scope

| Feature | Reason |
|---------|--------|
| AI automation-suggestion engine | Future milestone; v1 builds the event foundation |
| Real hardware device drivers / protocol adapters | v1 uses a simulated worker over RabbitMQ |
| Web UI / dashboard | API-only for v1 |
| WebSocket / SSE live push | Clients poll REST |
| OAuth / social login | Email/password auth is sufficient |
| Separate event datastore (MongoDB / time-series DB) | MariaDB `events` table suffices for v1 |
| Redis / external cache | No measured need |
| Desired/reported twin state | Desired intent lives on the command; only real current state is projected |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DATA-01 | Phase 1 | Complete |
| DATA-02 | Phase 1 | Complete |
| DATA-03 | Phase 1 | Complete |
| DATA-04 | Phase 1 | Complete |
| HOUSE-01 | Phase 2 | Complete |
| HOUSE-02 | Phase 2 | Complete |
| HOUSE-03 | Phase 2 | Complete |
| HOUSE-04 | Phase 2 | Complete |
| HOUSE-05 | Phase 2 | Complete |
| ROOM-01 | Phase 2 | Complete |
| ROOM-02 | Phase 2 | Complete |
| ROOM-03 | Phase 2 | Complete |
| ROOM-04 | Phase 2 | Complete |
| DEV-01 | Phase 2 | Complete |
| DEV-02 | Phase 2 | Complete |
| DEV-03 | Phase 2 | Complete |
| DEV-04 | Phase 2 | Complete |
| DEV-05 | Phase 2 | Complete |
| STATE-01 | Phase 2 | Complete |
| TEST-01 | Phase 2 | Complete |
| TEST-05 | Phase 2 | Complete |
| TEST-08 | Phase 2 | Complete |
| MSG-01 | Phase 3 | Pending |
| CMD-01 | Phase 4 | Pending |
| CMD-02 | Phase 4 | Pending |
| CMD-03 | Phase 4 | Pending |
| CMD-04 | Phase 4 | Pending |
| CMD-05 | Phase 4 | Pending |
| CMD-06 | Phase 4 | Pending |
| CMD-07 | Phase 4 | Pending |
| CMD-08 | Phase 4 | Pending |
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
