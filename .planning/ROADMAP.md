# Roadmap: Smart House

**Milestone:** 1 — Event-Driven Smart-Home Platform
**Generated:** 2026-06-30
**Granularity:** Fine
**Mode:** MVP
**Phase convention:** Sequential

---

## Phases

- [ ] **Phase 1: Schema & Data Conventions** - Complete Prisma schema including the append-only events table (with entity_type + nullable device_id for command-lifecycle rows); snake_case @@map; soft-delete; uuid v7 PKs (+ storage spike); user_id denormalization; polymorphic morph tables; last_event_id column for tuple guard
- [ ] **Phase 2: Entity CRUD & Multi-Tenancy** - House/Room/Device CRUD routes and services; ownership-embedded queries; multi-tenancy enforcement; soft-delete filters; auth boundary; eager state detail row at device creation
- [ ] **Phase 3: Messaging Infrastructure** - RabbitMQ singleton and Fastify plugin; topic exchange topology provisioned on boot — per consumer queue (device_effects, device_reports): main queue, `*.retry` wait queue (TTL backoff, dead-letters back to main), terminal `*.dlq`; background connect (no startup block); 503 degradation for POST /commands when broker down; auth/CRUD/state/event reads (all MariaDB) unaffected
- [ ] **Phase 4: Command Handler & Dispatcher** - Two-tier validation (acceptance sync → 400 including action↔type for explicit-device-id selectors; all device-type business logic → type validation async); TypeBox action schemas; selector resolution; persist-then-publish (one transaction, fan-out cap ~200); command status received/pending/done/partially_failed/failed; command-lifecycle events emitted (received/resolved/rejected); CMD-08 type validation async contract; background reaper
- [ ] **Phase 5: Simulated Device Worker** - Standalone worker process (npm run worker) that consumes effects, applies them, classifies failures by reason (determined domain outcome → explicit failure report published and acked; transient/offline → nack (no requeue) into the `*.retry` wait queue, `x-death`-bounded → terminal DLQ; poison → nack no-requeue → DLQ directly)
- [ ] **Phase 6: Report Consumer, State Projection & Current-State Reads** - Single-transaction consumer pipeline (event insert + guarded state UPDATE + CAS target + roll-up under FOR UPDATE lock); failure taxonomy enforced by reason via the retry wait-queue mechanism; first-terminal-wins; idempotency via unique-index; command.completed lifecycle event emitted; current-state read endpoints
- [ ] **Phase 7: Event History Routes** - Ownership-scoped device event queries from MariaDB events table; time-range filtering; cursor pagination on (recorded_at, event_id); soft-deleted device history readable
- [ ] **Phase 8: End-to-End Integration Tests** - Two-container testcontainers (MariaDB + RabbitMQ) full-pipeline verification: command-to-event round-trip, selector fan-out, partial failure roll-up, reaper, worker failure injection, retry wait-queue exhaustion to DLQ

---

## Phase Details

### Phase 1: Schema & Data Conventions

**Goal**: The complete Prisma schema — including the append-only MariaDB `events` table and all per-type state tables — is locked in before a single entity record is created; every data convention is applied uniformly.
**Depends on**: Nothing (foundation — extends existing auth schema)
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04

**Success Criteria** (what must be TRUE):
1. `prisma migrate dev` applies cleanly; rename migrations for the existing `User` and `RefreshToken` tables produce `users` and `refresh_tokens` in MariaDB; all new tables and columns are snake_case via `@map`/`@@map`. The generated migration SQL must be hand-verified to emit `RENAME TABLE`, not DROP+CREATE — no data loss.
2. House, Room, Device, Command, CommandTarget, and per-type state detail tables (`light_states`, `ac_states`, `heater_states`, `sensor_states`) are present with uuid v7 PKs; Room and Device carry a denormalized `user_id` column; `deleted_at` exists on User, House, Room, and Device.
3. The append-only `events` table is in the schema with: `event_id` (uuid v7, UNIQUE index), `entity_type` (enum: device | command), `source`, `event_kind`, `device_id` (nullable — null for command-lifecycle rows), `device_type`, `command_id` (nullable), `snapshot`, `recorded_at`; a compound index on `(device_id, recorded_at)`. The `entity_type` and nullable `device_id` columns are present from day one so command-lifecycle milestone rows (`command.received`, `command.resolved`, `command.rejected`, `command.completed`) can be written in the same table without schema changes.
4. Per-type state detail tables carry `last_event_at` and `last_event_id` (uuid v7) columns for the tuple guard; `state_type` and `state_id` morph columns are on Device; CommandTarget carries `deadline_at`; Command carries a `status` column that supports `received`, `rejected`, `pending`, `done`, `partially_failed`, `failed`, and `no_targets` values.
5. A brief spike (at most 10 minutes, documented as a schema comment or ADR note) confirms whether `event_id` and `last_event_id` should be stored as `BINARY(16)` or `CHAR(36)` given the Prisma MariaDB adapter — and verifies the adapter emits uuid v7 (not v4) when using `@default(uuid())`. The decision is recorded before migration is finalized.
6. `npm run build` compiles with zero type errors; `npm test` passes all existing auth tests; `prisma migrate dev` exits 0 (compile + migration smoke-check).

**Notes (structure-first, test-first — schema/infra exception):**
- Scaffold: add all new models to `prisma/schema.prisma` (including the `events` model with `entity_type` + nullable `device_id`; Command model with the full status enum including `received`/`rejected`/`no_targets`); run `prisma generate`; stub any new service files with typed signatures but `// TODO:` bodies.
- Compile + migration smoke-check (NOT TDD-red): this phase has no runnable application logic to test red. The acceptance bar is `prisma migrate dev` exits 0, `npm run build` compiles clean, `npm test` passes existing auth tests. Do NOT dress a compile check up as a failing test.
- Implement: write migrations; rename existing tables (hand-verify RENAME TABLE in generated SQL); add new models and columns including the `events` table with `entity_type` and nullable `device_id`; conduct uuid-v7-storage spike; finalize storage decision; regenerate Prisma client; confirm build and existing tests still pass.

**Plans**: 3 plans
- [ ] 01-01-PLAN.md — Scaffold all 10 new models + User @@map/deleted_at in schema.prisma; regenerate client; compile clean (Wave 1)
- [ ] 01-02-PLAN.md — Hand-authored User→users rename migration (RENAME TABLE, human-verified) + apply + auth regression (Wave 2)
- [ ] 01-03-PLAN.md — Additive domain-schema migration apply + uuid-v7 storage spike + full acceptance gate (Wave 3)

---

### Phase 2: Entity CRUD & Multi-Tenancy

**Goal**: Users can fully manage their houses, rooms, and devices via REST; every ownership boundary is enforced; a per-type state detail row is created eagerly for every new device.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: HOUSE-01, HOUSE-02, HOUSE-03, HOUSE-04, HOUSE-05, ROOM-01, ROOM-02, ROOM-03, ROOM-04, DEV-01, DEV-02, DEV-03, DEV-04, DEV-05, STATE-01, TEST-01, TEST-05, TEST-08

**Success Criteria** (what must be TRUE):
1. Authenticated user can create, list, view, update, and soft-delete their own houses; `GET /houses/:id` for a house owned by a different user returns 404, not 403.
2. Authenticated user can create, list, update, and soft-delete rooms within a house they own; soft-deleted rooms and houses are excluded from all list responses.
3. Authenticated user can add a device of type light/AC/heater/sensor to a room they own, list and view devices by room and by house, update device metadata, and soft-delete a device.
4. When a device is created, a per-type state detail row is immediately inserted with default values; `state_type` and `state_id` are fixed at creation time; no state row is created anywhere else in v1.
5. TypeBox schema validates the device type on creation; an unknown device type returns 400; every new endpoint returns 401 without a valid JWT.
6. A second authenticated user receives 404 for all resources they do not own; soft-deleted rows are excluded from all reads; a soft-deleted user cannot log in.

**Notes (structure-first, test-first):**
- Scaffold: route files under `src/routes/houses/`, `src/routes/rooms/`, `src/routes/devices/`; service files `src/services/house.ts`, `src/services/room.ts`, `src/services/device.ts`; TypeBox schema files; all handler bodies are `// TODO:`.
- Tests (red): per-endpoint unit tests via `app.inject()`; second-user 404 fixture for every ownership-sensitive route; soft-delete exclusion tests; 401 boundary tests; eager-state-row creation test (device created → state detail row exists with defaults); `npm run build && npm test` must compile and run red.
- Implement: service functions with ownership-embedded Prisma queries (`where: { id, userId }`); device creation service creates state detail row in the same transaction; batched `IN` for multi-device list; soft-delete filters on all reads; route handlers calling services.

**Plans**: TBD

---

### Phase 3: Messaging Infrastructure

**Goal**: The application boots with RabbitMQ connecting in the background; the full topic-exchange topology — including per-queue retry wait-queues — is provisioned; dependent endpoints degrade gracefully to 503 when the broker is unavailable, while all MariaDB-backed routes (auth, CRUD, state reads, event reads) remain fully available.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: MSG-01

**Success Criteria** (what must be TRUE):
1. On startup, the RabbitMQ connection is initiated in the background; `app.ready()` completes without waiting for the broker — auth, CRUD, state, and event-read endpoints remain available even if the broker is down. A missing `RABBITMQ_URL` env var causes the process to exit immediately with a descriptive error (env fail-fast is preserved for configuration errors; transient broker unavailability is not a configuration error and does not block boot).
2. When the broker is unreachable, `POST /commands` returns 503; all other routes (auth, CRUD, state reads, event reads) continue to serve normally because they are MariaDB-only.
3. Once connected, RabbitMQ topology is fully provisioned: `device_effects` topic exchange, `device_reports` topic exchange, and for **each consumer queue** (`device_effects`, `device_reports`) a three-queue set — the **main queue**, a **`*.retry` wait queue** (`x-message-ttl` ~30s backoff, `x-dead-letter-exchange` bound back to the main exchange so expiry redelivers to the main queue), and the **terminal `*.dlq`** — all with correct bindings; consumer channels use `prefetch=1`.
4. Fastify graceful shutdown closes the RabbitMQ connection cleanly; no unclosed-handle warnings appear in tests.
5. Topology assertions are idempotent — re-running the bootstrap against an already-provisioned broker is safe and does not produce errors.

**Notes (structure-first, test-first):**
- Scaffold: `src/lib/rabbitmq.ts` (amqp-connection-manager wrapper); `src/plugins/rabbitmq.ts` (Fastify plugin lifecycle); a readiness flag (`isBrokerReady()`) used by route-level 503 guards; all connection and topology logic bodies are `// TODO:`.
- Tests (red): testcontainers integration test — boot the app against a real RabbitMQ container; assert the main queue, `*.retry` wait queue (with `x-message-ttl` and `x-dead-letter-exchange` args), and terminal `*.dlq` all exist per consumer queue with correct bindings; assert graceful shutdown; assert that stopping the broker after boot causes `POST /commands` to return 503 while auth routes still respond 200.
- Implement: amqp-connection-manager wrapper with background reconnect; Fastify plugin lifecycle hooks that do NOT await connection before `app.ready()`; readiness flag updated on connect/disconnect; topology bootstrap function declaring, per consumer queue, the main queue + `*.retry` wait queue (`x-message-ttl` ~30s, `x-dead-letter-exchange` back to the main exchange) + terminal `*.dlq`; 503 guard in `POST /commands`; env validation for `RABBITMQ_URL`.

**Plans**: TBD

---

### Phase 4: Command Handler & Dispatcher

**Goal**: A user can issue a command with a selector; validation is two-tier — acceptance (sync, pre-persist → 400) handles structure and, for explicit-device-id selectors only, action↔type compatibility; all other device-type business logic ("type validation") runs asynchronously in the worker/consumer path; the system persists command + targets atomically, publishes per-device effects, emits command-lifecycle events (received/resolved/rejected), and a background reaper ages timed-out pending targets to failed.
**Mode:** mvp
**Depends on**: Phase 2, Phase 3
**Requirements**: CMD-01, CMD-02, CMD-03, CMD-04, CMD-05, CMD-06, CMD-07, CMD-08, MSG-02, TEST-07

**Success Criteria** (what must be TRUE):
1. **Acceptance layer** (sync, pre-persist → 400): a request with a malformed body, missing required fields, invalid types, a malformed selector, or a selector resolving to more than the configured max (~200) targets returns 400 before any database write or message publication. For **explicit-device-id selectors only**, the acceptance layer also checks action↔type compatibility synchronously — naming specific devices whose type cannot accept the action returns 400 before persist. Nothing is persisted for any 400 response.
2. **No sync rejection after persist**: once a command has been accepted and persisted, it is never synchronously rejected. Type-scoped selectors (scope + `deviceType`) require no action↔type check at acceptance because the selector already guarantees the type. Untyped scope selectors (room/house without a `deviceType` filter) do not perform action↔type checks at acceptance — those are deferred per-target to the async type validation layer.
3. **CMD-08 contract — type validation (async, event-driven)**: all device-type business logic — action↔type for non-homogeneous (untyped-scope) targets, value/range constraints per type, device availability (online/reachable), device lifecycle (not deleted, house active), state-dependent rules, cross-entity/DB/external lookups — is performed asynchronously in the worker/consumer path. The accepted command is dispatched with status `received`; failures in this layer transition the target/command to `failed` via emitted reports and lifecycle events, never a synchronous rejection of the already-accepted command.
4. For commands that pass acceptance, command + `command_target` rows are persisted in one transaction (before any publish); per-device effect messages are then published to the `device_effects` exchange using publisher confirms. Command status after successful dispatch is `pending`. The TypeBox action schemas and the `EffectMessage` envelope include all fields the worker needs to perform type validation asynchronously.
5. Each `CommandTarget` row carries a `deadline_at` timestamp; a background reaper periodically sweeps targets still `pending` past their `deadline_at`, marks them `failed` (CAS: only if still `pending`), and recomputes the command roll-up (all done → `done`; all failed → `failed`; mixed → `partially_failed`). `GET /commands/:id` returns current statuses after a reaper sweep.
6. Command-lifecycle events are written to the `events` table for every command milestone: `command.received` (written when the command row is first persisted, `entity_type=command`, `device_id=null`) and `command.resolved` (written when effects are published). `command.rejected` is reserved for async type validation rejections surfaced in Phases 5 and 6; a pre-persist 400 does not write any lifecycle event (no row was persisted). A scope selector matching 0 owned devices persists the command with terminal status `no_targets`; explicit-device-id resolving to 0 owned devices returns 400.

**Notes (structure-first, test-first):**
- Scaffold: `src/lib/device-actions.ts` (TypeBox discriminated-union action schemas per device type); `src/command-handler/translator.ts`; `src/command-handler/index.ts` (acceptance check, selector resolution, fan-out cap, action↔type check for explicit-id selectors only, persist-then-publish, lifecycle-event writes); `src/services/command.ts`; `src/workers/reaper.ts` (background sweep stub); route files; all logic bodies `// TODO:`.
- Tests (red): unit tests for acceptance-layer 400 (missing fields, bad types, malformed selector, fan-out over cap); unit tests for explicit-id selector action↔type 400 (action incompatible with named device type → 400, nothing persisted); unit test confirming type-scoped and untyped-scope selectors do NOT perform action↔type checks at acceptance; `resolveOwnedDeviceIds()` cross-tenant fixtures; persist-before-publish test; testcontainers test asserting effect messages appear in queue after valid command; testcontainers test asserting `command.received` and `command.resolved` lifecycle events written to `events` table; reaper unit test (target past `deadline_at` → marked `failed`, command rolls up). TEST-07 must cover explicit-device-id path only — that is the acceptance-layer sync check.
- Implement: acceptance-layer TypeBox validation (pre-handler); selector resolution service anchored to `userId`; fan-out cap check (configurable, default ~200); for explicit-device-id selectors: synchronous action↔type check → 400 on mismatch; for all other selectors: no action↔type check at this layer; command row write with status `received` + lifecycle event `command.received` in one transaction; persist `command_target` rows with `deadline_at`; write `command.resolved` event; publish effects with publisher confirms; command status query service + route; reaper background loop.

**Plans**: TBD

---

### Phase 5: Simulated Device Worker

**Goal**: A standalone simulated device worker process (`npm run worker`) consumes effect messages, applies them, and classifies the outcome by failure reason — a determined domain outcome (type-incompatible action, value out of range, device deleted, or other failed type validation) produces an explicit failure report published to the reports exchange and acked; a transient/uncertain condition (device offline, timeout) causes the worker to nack (requeue=false) so the message dead-letters into the `*.retry` wait queue for bounded, delayed retry; a poison message (malformed/unparseable) is dead-lettered to the terminal DLQ immediately. The worker mints the `event_id` deterministically as `uuidv5(command_target_id)` and stamps `recorded_at` as event-time so a redelivered effect re-produces the same id.
**Mode:** mvp
**Depends on**: Phase 3, Phase 4
**Requirements**: MSG-03, MSG-06

**Success Criteria** (what must be TRUE):
1. `npm run worker` starts a standalone process that connects to RabbitMQ, subscribes to the `device_effects` queue with `prefetch=1`, and logs each consumed effect. The API process owns/declares the topology; the worker asserts it idempotently on boot.
2. For each consumed effect the worker can successfully apply, it publishes a **success report** to the `device_reports` exchange. The report carries a deterministic `event_id = uuidv5(command_target_id)` and a producer-minted `recorded_at` (event-time), so a redelivered effect re-produces the same `event_id` and the consumer's unique index deduplicates it.
3. When the worker receives a valid, parseable effect but cannot apply it due to a **determined domain outcome** — type-incompatible action for this device's type, value out of range, device deleted, or any other type validation business-rule failure — it publishes an explicit **failure report** (`success: false`, `error` field, same deterministic `event_id`) to the `device_reports` exchange. The consumer acks this failure report (target transitions to `failed`/`rejected`). The worker does NOT nack or dead-letter the effect message; the DLQ/retry mechanism is for unprocessable/uncertain messages, not settled device rejections.
4. A **transient or uncertain** condition (device offline, unreachable, or timeout) causes the worker to **nack the effect message with `requeue=false`**, so it dead-letters into the `*.retry` wait queue; on TTL expiry (~30s) it dead-letters back to the main `device_effects` queue and is redelivered, incrementing the message's `x-death` count. Once `x-death` reaches the configured max (default ~5), the message is routed to the terminal `*.dlq` for manual inspection instead of retrying again. Plain `requeue=true` is never used — it would hot-spin redelivery without ever advancing `x-death`. The worker does not loop or crash on this path.
5. A **poison** effect message (malformed/unparseable or unknown schema) is nacked with `requeue=false` and dead-letters directly to the terminal `*.dlq` — it never enters the `*.retry` wait queue and is not subject to the `x-death` retry count. If the RabbitMQ connection drops, the worker reconnects automatically and resumes consuming.

**Notes (structure-first, test-first):**
- Scaffold: `src/workers/device-simulator.ts` with typed `EffectMessage`, `ReportMessage` (success), and `FailureReportMessage` interfaces; an `applyEffect()` dispatcher that returns a discriminated result (success | determinedFailure | transient | poison); per-type apply functions that include type validation business-rule checks; a failure-report builder; all logic bodies `// TODO:`.
- Tests (red): unit tests for `applyEffect()` for each device type (success path, determined-failure path including type validation rule violations, transient path); testcontainers integration test that publishes a synthetic effect and asserts a success report appears in the reports queue; testcontainers test that publishes a valid-but-unappliable effect (determined domain rejection) and asserts a **failure report** (NOT a nack, NOT DLQ) appears in the reports queue; testcontainers test that publishes a transient-failure effect and asserts it lands in the `*.retry` wait queue (not the terminal DLQ) on first failure; testcontainers test that publishes a malformed effect and asserts it lands directly in the terminal `*.dlq` (poison path, no retry hop).
- Implement: AMQP channel setup with `prefetch=1`; effect consumer loop; per-type apply functions including type validation business-rule checks; failure classification by reason (determined → publish failure report + ack effect; transient → nack with `requeue=false` so it dead-letters into the `*.retry` wait queue; poison → nack with `requeue=false` so it dead-letters directly to the terminal `*.dlq`); success report builder; failure report builder; deterministic `event_id` generation (`uuidv5(command_target_id)`); `recorded_at` stamped as event-time by the worker; reconnect via amqp-connection-manager; `npm run worker` script in `package.json`.

**Plans**: TBD

---

### Phase 6: Report Consumer, State Projection & Current-State Reads

**Goal**: The system ingests device reports from RabbitMQ and routes them strictly by failure reason — poison (malformed/unparseable or device not found) → terminal DLQ directly; transient/uncertain (offline, timeout) → nack (no requeue) into the `*.retry` wait queue, bounded by `x-death` count, then terminal DLQ; determined domain outcome (arrived as a well-formed failure report from the worker) → processed normally, acked. Success and failure reports are both processed in a single MariaDB transaction that appends an immutable event row, guarded-updates the device's typed current-state record, CAS-updates the command target (first-terminal-wins) under a `SELECT … FOR UPDATE` lock on the command, rolls up the command aggregate, and emits a `command.completed` lifecycle event; current state is exposed via REST endpoints.
**Mode:** mvp
**Depends on**: Phase 4, Phase 5
**Requirements**: MSG-04, MSG-05, STATE-02, STATE-03, STATE-04, EVENT-01, EVENT-02, EVENT-06, TEST-03, TEST-04, TEST-06, TEST-09, TEST-10

**Success Criteria** (what must be TRUE):
1. A **success report** consumed from the queue triggers a single MariaDB transaction that: (a) inserts the event row into the `events` table (`entity_type=device`), (b) guarded-updates the per-type state detail row `WHERE (last_event_at, last_event_id) < (:recorded_at, :event_id)` — never a create in the hot path (row was created eagerly at device creation), (c) CAS-updates the `command_target` from `pending` to `done` (never overwrites a terminal status — first-terminal-wins) under a `SELECT … FOR UPDATE` lock on the parent command row (the reaper takes the same lock), and (d) recomputes the command roll-up. The transaction commits, then the message is acked.
2. A **failure report** from the worker (a determined domain outcome) is processed by the consumer as a normal report: it is **acked** (never dead-lettered), the event row is inserted, the `command_target` is CAS-transitioned to `failed` (`pending → failed`, first-terminal-wins), and the command rolls up. When all targets for a command reach a terminal state, the consumer writes a `command.completed` lifecycle event row (`entity_type=command`, `device_id=null`) to the `events` table.
3. **Failure taxonomy enforced strictly by reason** in the consumer: **poison** messages (malformed/unparseable or `device_id` not found in MariaDB — unprocessable, uncertain provenance) → nacked with `requeue=false`, dead-lettering directly into the terminal `*.dlq`, no retry hop. **Transient/uncertain** failures (offline, timeout — condition may resolve) → nacked with `requeue=false` so they dead-letter into the `*.retry` wait queue; on TTL expiry (~30s) they dead-letter back to the main queue and redeliver, incrementing `x-death`; once `x-death` reaches the configured max (~5) the message routes to the terminal `*.dlq` instead of retrying again. Plain `requeue=true` is never used. **Determined domain outcomes** (arrived as well-formed failure reports from the worker — settled answer, retrying is pointless) → processed normally as in criterion 2, acked. Device offline → retry via wait queue → DLQ after max attempts (uncertain). Device deleted → failure report → acked (settled).
4. A redelivered report with the same `event_id` causes the event-row INSERT to hit the unique index, making the entire transaction a no-op; the consumer acks normally and the current-state record is unchanged — one and only one event row per `event_id`.
5. A stale report whose `(recorded_at, event_id)` tuple is not strictly greater than the stored `(last_event_at, last_event_id)` does not overwrite current state; the guarded UPDATE matches zero rows; the event row is still recorded (events are append-only); the message is acked.
6. `GET /devices/:id/state` returns the current typed state for a device the user owns; `GET /rooms/:id/state` returns state for all non-deleted devices in the room; `GET /houses/:id/state` returns a full snapshot — all return 404 for unowned resources. The current-state projection can be rebuilt by replaying a device's events from the `events` table (EVENT-06 validated by a test that replays rows and asserts matching current state).

**Notes (structure-first, test-first):**
- Scaffold: `src/workers/report-consumer.ts`; `src/services/state.ts` (morph-aware read helpers); state route files under `src/routes/devices/:id/state`, `src/routes/rooms/:id/state`, `src/routes/houses/:id/state`; all logic bodies `// TODO:`.
- Tests (red): idempotency test (redeliver identical report → unique-index no-op, exactly one event row, no state change); tuple-guard test (stale `(recorded_at, event_id)` → current state unchanged, event row still inserted); poison/DLQ routing test (malformed → nacked direct to terminal `*.dlq`, no retry hop); device-not-found routing test (`device_id` missing in DB → terminal `*.dlq`, treated as poison); failure-report processing test (determined domain rejection failure report from worker → acked, target `failed`, not dead-lettered, event row inserted); offline-device retry test (transient nack → dead-letters into `*.retry` wait queue, not the terminal DLQ, on first failure); retry-exhaustion test (simulate `x-death` reaching the configured max → message routes to terminal `*.dlq` rather than retrying again); first-terminal-wins test (late success after reaper-failed → event recorded but status not flipped); `command.completed` event test (all targets terminal → lifecycle event row written with `entity_type=command`, `device_id=null`); per-type state validation test; projection-rebuild test (replay events table → same state as DB record).
- Implement: consumer loop; `device_id` existence check (dead-letter directly to terminal `*.dlq` on miss — poison path); failure-taxonomy routing by reason — determined domain outcome failure reports follow the normal report path (ack); transient failures nack with `requeue=false` to dead-letter into the `*.retry` wait queue, bounded by `x-death` before falling through to the terminal `*.dlq`; poison nacked with `requeue=false` directly to the terminal `*.dlq`; one MariaDB transaction per report (event INSERT + guarded UPDATE + CAS target under `SELECT … FOR UPDATE` + roll-up recompute + `command.completed` lifecycle event when all targets terminal); commit then ack; state read services; route handlers.

**Plans**: TBD

---

### Phase 7: Event History Routes

**Goal**: Users can query the immutable event history for their owned devices from the MariaDB `events` table by time range, navigated with a stable cursor, including the history of soft-deleted devices they own.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: EVENT-03, EVENT-04, EVENT-05, TEST-12

**Success Criteria** (what must be TRUE):
1. `GET /devices/:id/events` returns the event history for a device the user owns, ordered by `recorded_at` descending (with `event_id` as tiebreaker); the response includes a `nextCursor` value for pagination. All reads come from the MariaDB `events` table — no cross-store access.
2. `?from=<ISO8601>&to=<ISO8601>` query params filter results to only events within the time window; timestamps must include a UTC offset — bare dates return 400.
3. Cursor pagination on `(recorded_at, event_id)` is stable: fetching page 1 then page 2 using the returned cursor produces no duplicate or missing events even if new events are appended concurrently between requests.
4. `GET /devices/:id/events` for a device owned by a different user returns 404; the ownership check is a direct MariaDB ownership query (using the denormalized `user_id` on Device) — cross-tenant access is rejected before any events are queried.
5. A soft-deleted device the user owns has its event history readable via this endpoint; deletion hides it from device listings but not from event history.

**Notes (structure-first, test-first):**
- Scaffold: `src/services/event-query.ts` with typed query-param interface and cursor encode/decode; route file under `src/routes/devices/:id/events`; all logic `// TODO:`.
- Tests (red): time-range filter test (events outside range excluded); cursor-stability test (concurrent appends do not corrupt pages); cross-tenant 404 test; bare-date 400 test; soft-deleted device history readable test (device soft-deleted → events still returned for owner).
- Implement: ownership check against MariaDB `devices` table (including soft-deleted, using `user_id` denorm — do NOT filter `deleted_at` for the ownership read; the device may be soft-deleted but still owned); MariaDB cursor query on `(recorded_at, event_id)` with `BINARY(16)` or `CHAR(36)` UUID comparison matching the Phase 1 storage decision; cursor encoding; time-range filter with UTC-offset validation; TypeBox params schema.

**Plans**: TBD

---

### Phase 8: End-to-End Integration Tests

**Goal**: The full async pipeline is verified end-to-end using testcontainers (MariaDB + RabbitMQ, two containers, shared suite-level fixture with a between-test reset: truncate tables + purge queues): a command issued via REST travels through RabbitMQ, the simulated worker, and the report consumer, and the resulting event and current state are observable via REST.
**Mode:** mvp
**Depends on**: Phase 7
**Requirements**: TEST-02, TEST-11

**Success Criteria** (what must be TRUE):
1. A `POST /commands` call against a testcontainers environment (real MariaDB + RabbitMQ; two containers only, no third container) triggers the full pipeline end-to-end: effects published, worker consumes and reports, consumer appends event row to the `events` table, current state updated in MariaDB — all verifiable within a test timeout.
2. A command with a room/house selector (with optional type filter) resolves to exactly the owned matching devices; a multi-device command produces one event row per device in the `events` table, all sharing the same `command_id`; a second user's devices are excluded from the selector result.
3. Worker failure injection: when the worker emits an explicit failure report (determined domain outcome — type validation rejected the action) for one target, the consumer acks it (not dead-letters it), the target transitions to `failed`, and the command status rolls up to `partially_failed`; when a target's `deadline_at` expires without a report (simulated silent loss), the reaper ages it to `failed` and the command rolls up accordingly. A simulated transient failure is confirmed to retry via the `*.retry` wait queue and park in the terminal `*.dlq` only after the configured `x-death` max is reached — not a hot-spin loop.
4. The testcontainers fixture (2 containers: MariaDB + RabbitMQ) is started once at the suite level and shared across all integration tests; a between-test reset (truncate tables + purge queues) runs between each test to prevent cross-test pollution. All tests run as part of `npm test` using the existing `node:test` runner convention with teardown hooks.

**Notes (structure-first, test-first):**
- Scaffold: `src/test/integration/` directory with testcontainers fixture helpers (shared container startup/teardown for MariaDB + RabbitMQ — 2 containers only; between-test reset helpers); test file stubs with `// TODO:` test bodies.
- Tests (red): all round-trip, fan-out, partial-failure (failure report path — acked, not DLQ), reaper (silent-loss path), and retry wait-queue exhaustion (transient failure → `*.retry` wait queue → bounded `x-death` retries → terminal `*.dlq`, not a hot-spin) tests written and compiled before any pipeline fixes; they fail due to timing or assertion gaps.
- Implement: any pipeline gaps revealed by the tests (nack error handling, roll-up edge cases, reaper timing, worker failure injection, retry wait-queue timing); wire testcontainers teardown hooks; ensure `npm test` runs all suites.

**Plans**: TBD

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Schema & Data Conventions | 0/3 | Not started | - |
| 2. Entity CRUD & Multi-Tenancy | 0/0 | Not started | - |
| 3. Messaging Infrastructure | 0/0 | Not started | - |
| 4. Command Handler & Dispatcher | 0/0 | Not started | - |
| 5. Simulated Device Worker | 0/0 | Not started | - |
| 6. Report Consumer, State Projection & Current-State Reads | 0/0 | Not started | - |
| 7. Event History Routes | 0/0 | Not started | - |
| 8. End-to-End Integration Tests | 0/0 | Not started | - |

---

## Coverage

| Requirement | Phase | Category |
|-------------|-------|----------|
| DATA-01 | Phase 1 | Data Conventions |
| DATA-02 | Phase 1 | Data Conventions |
| DATA-03 | Phase 1 | Data Conventions |
| DATA-04 | Phase 1 | Data Conventions |
| HOUSE-01 | Phase 2 | Houses |
| HOUSE-02 | Phase 2 | Houses |
| HOUSE-03 | Phase 2 | Houses |
| HOUSE-04 | Phase 2 | Houses |
| HOUSE-05 | Phase 2 | Houses |
| ROOM-01 | Phase 2 | Rooms |
| ROOM-02 | Phase 2 | Rooms |
| ROOM-03 | Phase 2 | Rooms |
| ROOM-04 | Phase 2 | Rooms |
| DEV-01 | Phase 2 | Devices |
| DEV-02 | Phase 2 | Devices |
| DEV-03 | Phase 2 | Devices |
| DEV-04 | Phase 2 | Devices |
| DEV-05 | Phase 2 | Devices |
| STATE-01 | Phase 2 | State |
| TEST-01 | Phase 2 | Testing |
| TEST-05 | Phase 2 | Testing |
| TEST-08 | Phase 2 | Testing |
| MSG-01 | Phase 3 | Messaging |
| CMD-01 | Phase 4 | Commands |
| CMD-02 | Phase 4 | Commands |
| CMD-03 | Phase 4 | Commands |
| CMD-04 | Phase 4 | Commands |
| CMD-05 | Phase 4 | Commands |
| CMD-06 | Phase 4 | Commands |
| CMD-07 | Phase 4 | Commands |
| CMD-08 | Phase 4 | Commands |
| MSG-02 | Phase 4 | Messaging |
| TEST-07 | Phase 4 | Testing |
| MSG-03 | Phase 5 | Messaging |
| MSG-06 | Phase 5 | Messaging |
| MSG-04 | Phase 6 | Messaging |
| MSG-05 | Phase 6 | Messaging |
| STATE-02 | Phase 6 | State |
| STATE-03 | Phase 6 | State |
| STATE-04 | Phase 6 | State |
| EVENT-01 | Phase 6 | Events |
| EVENT-02 | Phase 6 | Events |
| EVENT-06 | Phase 6 | Events |
| TEST-03 | Phase 6 | Testing |
| TEST-04 | Phase 6 | Testing |
| TEST-06 | Phase 6 | Testing |
| TEST-09 | Phase 6 | Testing |
| TEST-10 | Phase 6 | Testing |
| EVENT-03 | Phase 7 | Events |
| EVENT-04 | Phase 7 | Events |
| EVENT-05 | Phase 7 | Events |
| TEST-12 | Phase 7 | Testing |
| TEST-02 | Phase 8 | Testing |
| TEST-11 | Phase 8 | Testing |

**Unique v1 requirements mapped: 49/49**
- HOUSE: 5/5 (Phase 2)
- ROOM: 4/4 (Phase 2)
- DEV: 5/5 (Phase 2)
- STATE: 4/4 (STATE-01 Phase 2; STATE-02/03/04 Phase 6)
- CMD: 8/8 (all Phase 4)
- MSG: 6/6 (MSG-01 Phase 3; MSG-02 Phase 4; MSG-03/MSG-06 Phase 5; MSG-04/05 Phase 6)
- EVENT: 6/6 (EVENT-01/02/06 Phase 6; EVENT-03/04/05 Phase 7)
- DATA: 4/4 (Phase 1)
- TEST: 12/12 (Phases 2, 4, 6, 7, 8)
