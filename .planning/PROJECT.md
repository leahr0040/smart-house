# Smart House

## What This Is

A multi-tenant smart-home **state + telemetry platform**, built event-driven so it is ready for real hardware. Each user owns one or more houses, divided into rooms, each containing smart devices (lights, air conditioners, heaters, sensors). Users issue commands (including bulk commands like "turn off all the lights") that fan out to devices over a message broker; devices report back their actual state. The system keeps each device's **current state** and records an immutable **event history** of every command effect and device report for future AI analysis. Built on an existing Fastify 5 + Prisma + MariaDB backend with JWT auth already in place. v1 is a command/state platform; autonomous sensor telemetry (periodic command-less readings) is a v2 concern.

## Core Value

The system always reflects the true current state of the house AND preserves a complete, queryable history of every event — so nothing about the home's behavior is ever lost.

## Requirements

### Validated

<!-- Shipped and confirmed (existing auth API). -->

- ✓ User can register with email/password (bcrypt-hashed)
- ✓ User can log in and receive a short-lived JWT access token
- ✓ User can refresh tokens via rotating, single-use httpOnly refresh-token cookie
- ✓ User can fetch their own identity (`/auth/me`) and log out (revoke refresh token)
- ✓ Fastify 5 + Prisma + MariaDB backend with global error normalization and schema-validated routes

### Active

- [ ] User → House → Room → Device hierarchy, multi-tenant (scoped per user)
- [ ] CRUD for houses, rooms, and devices
- [ ] Typed per-device-type current state via polymorphic morph (`state_type` + `state_id`); no JSON; single current-state facet
- [ ] Per-device current-state projection, rebuildable from the event log
- [ ] First-class commands with selector-based targeting (device ids / room / house + optional type) and multi-device fan-out
- [ ] Layered validation: sync acceptance, async type validation
- [ ] Event-driven dispatch over RabbitMQ: effects out, reports in; simulated device worker stands in for hardware
- [ ] Append-only `events` table in MariaDB as the source of truth
- [ ] Query current state (device/room/house) and event history (by device, time range, cursor paginated)

### Out of Scope

- AI automation-suggestion engine — future milestone; v1 builds the event foundation it will consume
- Real hardware device drivers / physical protocol adapters — v1 uses a simulated device worker over RabbitMQ that speaks the same contract real hardware will; the messaging infrastructure is in scope, the physical drivers are not
- Web UI / dashboard — API-only for v1
- WebSocket / SSE push to clients — clients poll REST
- OAuth / social login — email/password auth is sufficient
- Autonomous sensor telemetry (periodic command-less readings) — v2
- Separate datastore for events (a dedicated time-series DB) — the MariaDB `events` table suffices for v1
- Redis / external cache — no measured need in v1
- Typed-SQL filtering on state values — not a v1 read pattern

## Context

- **Brownfield.** An authentication API already exists and is the foundation: Fastify 5 REST API, MariaDB via Prisma (driver-adapter pattern, `@prisma/adapter-mariadb`), `@fastify/jwt`, autoloaded plugins + routes. See `.planning/codebase/` for the full map.
- **Auth token strategy:** 15-min JWT access tokens + 7-day rotating opaque refresh tokens (SHA-256 hashed, single-use, httpOnly cookie scoped to `/auth`).
- **Validation standard is TypeBox** (per CLAUDE.md / PLAN.md rule 1.5), with `Static<typeof schema>` types. Per-device-type state and command actions are validated with TypeBox.
- **Service-layer pattern:** routes call pure service functions in `src/services/`; services call the Prisma singleton from `src/lib/prisma.ts`.
- **Two data stores:** MariaDB (relational hierarchy + the append-only `events` table (source of truth) + current-state projection + commands) and RabbitMQ (effect dispatch + report ingestion).
- **Event-driven flow:** the Command Handler does acceptance validation, resolves the selector to owned devices, persists the command + targets, and publishes per-device effects. A simulated device worker applies effects and publishes reports. A report consumer appends the event, updates current state, and updates command-target status in one MariaDB transaction. Device-type business rules ("type validation") run asynchronously in the worker/consumer path.
- **Future AI consumer** shapes the design: events are uniform rows linked to the command that caused them, so an AI component can later mine "intent → effects" causality without a schema rewrite.

## Constraints

- **Tech stack**: extend the existing Fastify 5 + Prisma + MariaDB app; add RabbitMQ. Events live in a MariaDB append-only table.
- **Validation**: TypeBox for all routes/schemas/actions.
- **Multi-tenancy**: all data scoped to the owning user; `user_id` denormalized onto Room, Device, and Command so ownership checks (incl. `GET /commands/:id`) never join through the hierarchy. Event-history reads are ownership-scoped; the history of a soft-deleted device the owner still owns remains readable.
- **No N+1**: multi-device paths use batched `IN` queries; ownership uses the denormalized `user_id`.
- **Consistency model** (single store):
  - The MariaDB `events` table is the source of truth; the current-state row is a projection rebuildable from it.
  - *Consumer atomicity*: per report, in one MariaDB transaction — insert the event, guarded-update the current-state row, CAS the `command_target` status, and recompute the command roll-up under a `SELECT … FOR UPDATE` lock on the parent command (the reaper takes the same lock). Commit, then ack.
  - *Idempotency*: `event_id` is deterministic — `uuidv5(command_target_id [+ outcome])` — with a MariaDB unique index, so effect redelivery re-produces the same id and is deduped. A transaction is never a substitute for the idempotency guard.
  - *Ordering*: the state-row update is guarded — apply only if `(last_event_at, last_event_id) < (:recorded_at, :event_id)` (tuple tiebreaker). The event row is still recorded even when a stale report doesn't move current state.
  - *Target transitions*: compare-and-set, `pending → done|failed` only, never overwriting a terminal state (first-terminal-wins).
  - *Intra-MariaDB transactions* are used wherever multiple rows change together (device + eager state row; command + targets; target-status + roll-up). Transactions never span stores (there is only one) and never substitute for idempotency.
- **Event time**: `recorded_at` is producer-minted event-time (the worker stamps when the effect happened). v1 has one worker → monotonic; multi-producer clock skew is a v2 concern.
- **State row lifecycle**: the per-device state detail row is created eagerly at device creation (defaults; `state_type`/`state_id` fixed then), so the consumer's hot path is only ever a guarded `UPDATE`.
- **Layered validation** (two tiers):
  - **Acceptance** (sync, pre-persist → 400): request shape/types/format/required, selector well-formed, valid action object, fan-out cap. Plus action↔type compatibility **only for explicit-device-id selectors**. Type-scoped selectors (scope + `deviceType`) need no such check; untyped scope selectors resolve action↔type per-target in async validation.
  - **Type validation** (async, event-driven → state transition / failure report, never a sync 400), split by who can know the rule:
    - **Device-knowable** (worker/device path): action↔type for non-homogeneous targets, value/range constraints, current-state preconditions, availability/reachability.
    - **Platform gates** (platform path, not the device): device deleted, house active, ownership/lifecycle — enforced at selector-resolution time and re-checked at report-consume time if state changed mid-flight.
- **Action vocabulary** lives in code (TypeBox registry in `src/lib/device-actions.ts`), keyed by device type; per-device limits/config live in the DB. Registry-seamed so a DB-backed vocabulary can be introduced in v2 if dynamic/admin/per-tenant device types become a requirement.
- **Failure taxonomy** (route by reason):
  - *Poison* (malformed/unparseable/unknown message) → DLQ, no retry.
  - *Transient / uncertain* (device offline/unreachable, timeout) → **nack (no requeue) → a `*.retry` wait queue** (`x-message-ttl` backoff, default ~30s, dead-lettering back to the main queue); the `x-death` count bounds retries (default ~5), then park in the terminal DLQ. Plain `requeue=true` is never used — it hot-spins and doesn't advance `x-death`.
  - *Determined domain outcome* (device deleted, action rejected, value out of range, type-incompatible, failed type validation) → failure report → target `failed`/`rejected`, message acked (not dead-lettered).
  - v1 does not drain or alert the DLQ — manual inspection only. `// ponytail: DLQ drain + alert when ops maturity needs it.`
- **Command creation**: persist Command (`received`) + `command_targets` in one transaction, then publish effects (never publish-first; a crash after commit leaves targets `pending` → the reaper self-heals to `failed`).
- **Fan-out cap & empty resolution**: `> ~200` targets → 400; an explicit-device-id selector resolving to 0 owned devices → 400; a scope selector matching 0 devices → command persisted with terminal status `no_targets`. `// ponytail: fan-out cap, page or raise when a real client needs bigger batches.`
- **Client idempotency**: v1 actions are absolute (`set_brightness 50`, `turn_on`), so a retried `POST /commands` is harmless — no `Idempotency-Key` in v1. `// ponytail: add it if relative/toggle actions enter scope.`
- **Command-lifecycle events**: `command.received` / `resolved` / `rejected` / `completed` are written to the `events` table (`entity_type = command`, `device_id` null), alongside per-device effect/report events.
- **Throughput ceiling**: `prefetch=1` on the report consumer (strictly serial). `// ponytail: prefetch=1, raise + per-device ordering key when volume matters.`
- **Process model**: the simulated device worker runs as a separate process (`npm run worker`); the report consumer and reaper run as background tasks (process placement decided at their phase). The API process owns the RabbitMQ topology; other processes assert it idempotently.
- **Boot resilience**: env-var validation fails fast; transient RabbitMQ unavailability does not block `app.ready()` (background reconnect). Auth + CRUD + state/event reads (all MariaDB) stay available; `POST /commands` returns 503 while the broker is down.
- **Event immutability**: the `events` table is append-only; no TTL in v1 (retain all events).
- **DB naming**: snake_case columns/tables via Prisma `@map`/`@@map`, including existing `User`/`RefreshToken` models. The existing-table rename uses a hand-authored `ALTER TABLE … RENAME` migration (not a generated diff, which may emit DROP+CREATE).
- **PKs**: uuid v7 for new domain entities (House/Room/Device/Command); User/RefreshToken stay Int.
- **Device state**: typed per device type via polymorphic morph (`state_type` + `state_id`) → per-type detail tables; no JSON column; single current facet.
- **Device report trust**: the consumer validates the `device_id` exists and is owned; a `device_token` envelope field is reserved (unenforced in v1) for v2 per-device secrets.
- **Soft delete**: `deleted_at` on User/House/Room/Device; reads exclude soft-deleted rows; a soft-deleted user cannot authenticate.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Event-driven over RabbitMQ; assume hardware exists | v2-ready infrastructure; real devices confirm state asynchronously |
| Single-store MariaDB `events` table is the source of truth; current state is a rebuildable projection | Consumer writes are one local transaction; no cross-store consistency problem |
| Consumer pipeline is one MariaDB transaction (event insert + guarded state update + target CAS + roll-up under command row lock) | Atomic; consumer and reaper serialize on the roll-up |
| Idempotency: `event_id = uuidv5(command_target_id)` (deterministic) + MariaDB unique index | Survives effect redelivery — a re-applied effect re-produces the same id and is deduped |
| `recorded_at` is producer-minted event-time | The ordering guard is only sound on event-time |
| Single current-state per device (no desired/reported twin) | The event log holds history; the command holds intent; only the real current state needs a fast record |
| Typed per-device-type state via polymorphic morph; per-device limits/config in DB | Flexible (new type = new detail table); typed detail; loose FK integrity is fine for a rebuildable projection |
| Action vocabulary in code (TypeBox registry), registry-seamed | Static types + free validation; DB-backed vocabulary only when dynamic device types are a real requirement |
| Two-tier validation: sync acceptance (structural + action↔type for explicit-id selectors) / async type validation split into device-knowable (worker) vs platform gates (platform) | Fast acceptance; deep rules async; worker contract stays shippable to real hardware |
| Failure taxonomy by reason: poison → DLQ; transient/offline → retry → DLQ; determined → failure report (acked) | DLQ is for unprocessable/uncertain messages, not settled device outcomes |
| First-class `command` entity + selector targeting + best-effort fan-out; `user_id` denormalized on Command | Supports bulk commands; links intent → effects; ownership without a join |
| Command targets: CAS terminal (first-terminal-wins), `deadline_at` + reaper, roll-up done/partially_failed/failed | Makes every target reach a terminal state; deterministic status |
| Fan-out cap (~200); explicit-id 0-owned → 400; scope 0-match → `no_targets` | Bounds fan-out; distinguishes client error from an empty scope |
| Command-lifecycle events in the `events` table (`entity_type=command`) | Complete intent→outcome timeline for audit + future AI |
| Reports flow in via RabbitMQ only (no REST report endpoint) | Exercises the exact path real hardware uses in v2 |
| uuid v7 PKs (new entities); snake_case via `@map`/`@@map`; existing-table rename via hand-authored `ALTER TABLE … RENAME` | Non-enumerable IDs; consistent naming; no data-loss on rename |
| RabbitMQ topic exchanges; per consumer queue: main + `*.retry` wait queue (fixed ~30s TTL, dead-letters back to main) + terminal `*.dlq`; `x-death`-bounded retry (~5); `prefetch=1`; API owns topology; worker is a separate process (`npm run worker`) | Wait-queue gives delayed bounded retry that plain requeue cannot; future routing flexibility; clean process boundaries |
| Boot resilience: env fail-fast; broker background connect; `POST /commands` → 503 when broker down | Don't couple `/auth` availability to the broker |
| Multi-tenant; soft-delete on User/House/Room/Device; soft-deleted device history stays readable | Correct isolation; deletion hides from listings, not from history |
| Tests: testcontainers (MariaDB + RabbitMQ, shared suite fixture + between-test reset); pure unit tests for infra-free logic | Faithful DLQ/idempotency/redelivery semantics without cross-test pollution |
| No Redis; no separate event datastore; no client `Idempotency-Key` (absolute actions) | No measured need; avoids unjustified infrastructure |

## Development Process (per phase)

Every phase plan opens with a **structure-first, test-first** sequence before implementation:

1. **Scaffold** — files with real signatures, types, and properties; bodies `// TODO:` only.
2. **Tests** — unit + integration tests (`node:test` + `build(t)` / `app.inject()`); compile and run red.
3. **Implement** — fill in logic until the tests pass.

**Schema/infra phases** substitute a compile + migration smoke-check (`prisma migrate dev` applies, `npm run build` compiles, existing tests pass) for the red-test step. This is a hard rule — see Working Style in CLAUDE.md.

## Evolution

**After each phase transition:** move invalidated requirements to Out of Scope; move validated ones to Validated with a phase reference; add emerged requirements to Active; log new decisions; update "What This Is" if it drifted.

**After each milestone:** full review of all sections; re-check Core Value and Out of Scope; update Context with current state.

---
*Last updated: 2026-06-30*
