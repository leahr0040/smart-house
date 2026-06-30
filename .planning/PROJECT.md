# Smart House

## What This Is

A multi-tenant smart-home **state + telemetry platform**, built event-driven so it is ready for real hardware. Each user owns one or more houses, divided into rooms, each containing smart devices (lights, air conditioners, heaters, sensors). Users issue commands (including bulk commands like "turn off all the lights") that fan out to devices over a message broker; devices report back their actual state. The system keeps each device's **current state** and records an immutable **event history** of every command effect and device report for future AI analysis. Built on an existing Fastify 5 + Prisma + MariaDB backend with JWT auth already in place. *(v1 is a command/state platform; autonomous sensor telemetry — periodic command-less readings — is deferred to v2.)*

## Core Value

The system always reflects the true current state of the house AND preserves a complete, queryable history of every event — so nothing about the home's behavior is ever lost.

## Requirements

### Validated

<!-- Inferred from existing code (auth API already shipped). -->

- ✓ User can register with email/password (bcrypt-hashed) — existing
- ✓ User can log in and receive a short-lived JWT access token — existing
- ✓ User can refresh tokens via rotating, single-use httpOnly refresh-token cookie — existing
- ✓ User can fetch their own identity (`/auth/me`) and log out (revoke refresh token) — existing
- ✓ Fastify 5 + Prisma + MariaDB backend with global error normalization and schema-validated routes — existing

### Active

<!-- v1 scope: the event-driven smart-home platform. Hypotheses until shipped. See REQUIREMENTS.md for full REQ list. -->

- [ ] Model the hierarchy: User → House → Room → Device (multi-tenant, scoped per user)
- [ ] User can CRUD houses, rooms, and devices they own
- [ ] Typed per-device-type current state via polymorphic morph (`state_type` + `state_id`); no JSON; single current-state facet (no desired/reported twin)
- [ ] Per-device current-state projection, rebuildable from the event log
- [ ] First-class commands with selector-based targeting (device ids / room / house + optional type) and multi-device fan-out; desired intent + status live on the command
- [ ] Illogical command (action invalid for a device type) is rejected with a validation error before dispatch
- [ ] Event-driven dispatch over RabbitMQ: effects out, reports in; simulated device worker stands in for hardware
- [ ] Immutable event history in a MariaDB append-only table as the source of truth (single store; the consumer's event-append + state-update + target-update are one local transaction)
- [ ] Query current state (device/room/house) and event history (by device, time range, cursor paginated)

### Out of Scope

<!-- Designed-for but not built in v1. Reasons prevent re-adding prematurely. -->

- AI automation-suggestion engine — future milestone; v1 builds the clean event foundation it will consume
- Real hardware device drivers / physical protocol adapters (Zigbee, Z-Wave, real MQTT devices) — v1 uses a **simulated device worker** over RabbitMQ that speaks the same contract real hardware will; the messaging *infrastructure* is in scope, the physical drivers are not
- Web UI / dashboard — API-only for v1; consumed by API clients and a future frontend
- WebSocket / SSE push to clients — clients poll REST for v1
- OAuth / social login — email/password auth is sufficient for v1
- Typed-SQL filtering on state values (e.g. "all ACs above 25°") — not a v1 read pattern; add a richer projection later if needed (rebuildable from events)
- Autonomous sensor telemetry (periodic command-less sensor readings) — deferred to v2; v1 sensors are modeled and report-only but emit no autonomous data, so all v1 reports are command-driven
- Separate datastore for events (MongoDB / dedicated time-series DB) — the MariaDB append-only event log suffices for v1; re-extract to a time-series store in a future phase only if write volume demands it (rebuilt from the log)
- Redis / external cache — no measured bottleneck in v1 (current state is single indexed rows; ownership is an indexed query; idempotency is a unique index). Add only when a profiled hot path, real-time fan-out, or distributed rate-limiting actually needs it

## Context

- **Brownfield.** An authentication API already exists and is the foundation: Fastify 5 REST API, MariaDB via Prisma (driver-adapter pattern, `@prisma/adapter-mariadb`), `@fastify/jwt`, autoloaded plugins + routes. See `.planning/codebase/` for the full map.
- **Auth token strategy is settled:** 15-min JWT access tokens + 7-day rotating opaque refresh tokens (SHA-256 hashed, single-use, httpOnly cookie scoped to `/auth`).
- **Validation standard is TypeBox** (per CLAUDE.md / PLAN.md rule 1.5). New schemas use TypeBox with `Static<typeof schema>`. Per-device-type state and command actions are validated with TypeBox at the command/report boundary.
- **Service-layer pattern:** routes call pure service functions in `src/services/`; services call the Prisma singleton from `src/lib/prisma.ts`.
- **Event-driven core:** A **Command Handler** does minimal **acceptance** validation (structural), resolves the selector to owned devices, and — **for explicit-device-id selectors only** — synchronously checks action↔type compatibility (→ 400 on mismatch). It persists the command (`received`) + `command_targets` (one transaction), then publishes per-device effects. **All other business rules ("type validation") run asynchronously** in the worker/consumer path; failures become state transitions + failure reports + (where needed) compensating actions, never a synchronous rejection of an already-accepted command. A **simulated device worker** applies effects and publishes reports. A **report consumer** appends the event, guarded-updates the current-state record, CAS-updates the command-target, and recomputes the roll-up — **all in one MariaDB transaction**.
- **Layered validation** (two tiers):
  - **Acceptance** (sync, pre-persist → 400): request shape/types/format/required, selector well-formed, valid action object, fan-out cap. Plus **action↔type compatibility only for explicit-device-id selectors** (the user named specific devices, so a type that can't accept the action is an immediate 400). Type-scoped selectors (scope + `deviceType`) need no such check — the selector guarantees the type; untyped scope selectors resolve action↔type per-target in async validation.
  - **Type validation** (async, event-driven → state transition / failure report, never a sync 400): all device-type business logic — action↔type for non-homogeneous (untyped-scope) targets, value/range constraints per type, device availability (online/reachable), device lifecycle (not deleted, house active), state-dependent rules, cross-entity/external/DB-lookup rules.
- **Two data stores:** MariaDB (relational + the append-only **event log** which is the source of truth + current-state projection + commands), RabbitMQ (effect dispatch + report ingestion). *(A dedicated time-series store for events is a future option, re-extractable from the MariaDB log — not v1.)*
- **Future AI consumer** shapes the design: events are uniform rows linked to the command intent that caused them, so an AI component can later mine "intent → effects" causality without a schema rewrite.

## Constraints

- **Tech stack**: Extend the existing Fastify 5 + Prisma + MariaDB app, not replace it. Add RabbitMQ (messaging); events live in a new MariaDB append-only table — no second datastore.
- **Validation**: New routes/schemas/actions must use TypeBox (project standard).
- **Multi-tenancy**: All house/room/device/command/event data scoped to the owning user; no cross-tenant access. `user_id` is **denormalized onto Room and Device** so ownership checks never join through the hierarchy. Event-history reads are ownership-scoped in MariaDB; the history of a **soft-deleted** device you own remains readable (deletion hides it from listings, not from history).
- **No N+1**: multi-device paths use batched `IN` queries; ownership uses the denormalized `user_id`, never per-row joins.
- **Consistency model** (single store — transactions do the heavy lifting):
  - The MariaDB **event log is the source of truth**; the current-state row is a projection rebuildable from it. Everything is in one database, so there is **no cross-store window** and no write-order invariant.
  - *Consumer atomicity*: per report, in **one MariaDB transaction** — insert the event, guarded-update the current-state row, CAS the `command_target` status, recompute the command roll-up. Commit, then ack. A crash before commit → redelivery → the same transaction re-runs idempotently.
  - *Idempotency*: the **`event_id` unique index** (MariaDB). A duplicate insert ⇒ the transaction is a no-op and the message is acked. A transaction is **never** a substitute for idempotency.
  - *Ordering*: the state-row update is **guarded "update when match"** — a tuple compare so same-millisecond and out-of-order reports are handled: apply only if `(last_event_at, last_event_id) < (:recorded_at, :event_id)` (the row stores `last_event_id`; `event_id` is uuid v7, so this is deterministic and order-independent). The event row is still recorded even when a stale report doesn't move current state.
  - *Target transitions*: **compare-and-set**, `pending → done|failed` only, never overwriting a terminal state. **First terminal wins** — a success report arriving after the reaper marked a target `failed` is still recorded as an event but does not flip the status.
- **State row lifecycle**: the per-device state detail row is created **eagerly at device creation** (defaults; `state_type`/`state_id` fixed then), so the consumer's hot path is only ever a guarded `UPDATE` — never a create.
- **Process model**: the simulated device worker runs as a separate process (`npm run worker`). The report consumer and the command-target reaper run as background tasks; their process placement (in-API vs separate) is decided at their phase. The **API process owns the RabbitMQ topology** (canonical declaration, single home for binding changes); other processes assert the same topology idempotently on boot but do not define new bindings.
- **Throughput ceiling**: `prefetch=1` on the report consumer is a deliberate v1 ceiling (strictly serial processing). `// ponytail: prefetch=1, raise + per-device ordering key when volume matters.`
- **Idempotency**: the producer (worker/device) mints a `report_id` (uuid v7) per published message; `event_id := report_id`, enforced by a MariaDB unique index. Dedup is **message-identity** based (not effect-keyed), so redeliveries are dropped while genuinely distinct reports (incl. multi-step settles and future command-less readings) are all stored.
- **Fan-out cap**: a selector resolving to more than a configurable max (default ~200) targets is rejected (400). `// ponytail: fan-out cap, page or raise when a real client needs bigger batches.`
- **Command create ordering**: persist Command + `command_targets` (one transaction, committed) **then** publish effects. Never publish first (avoids reports for an uncommitted command); a crash after commit before publish leaves targets `pending` → the reaper self-heals them to `failed`.
- **Failure taxonomy** (route by failure *reason*; DLQ is for unprocessable/uncertain, not settled outcomes):
  - *Poison* (malformed/unparseable/unknown message) → **DLQ**, no retry.
  - *Transient / uncertain* (device **offline**/unreachable, timeout) → bounded retry (`x-death` count); still failing → **DLQ** (may recover, needs attention).
  - *Determined domain outcome* (device **deleted**, action rejected, value out of range, type-incompatible, failed type validation) → **failure report → target `failed`/`rejected`, message acked — NOT dead-lettered** (it's a settled answer; retry/DLQ is pointless).
  - v1 does **not** drain or alert the DLQ — manual inspection only. `// ponytail: DLQ drain + alert when ops maturity needs it.`
- **Command-lifecycle events**: command milestones (`command.received`, `command.resolved`, `command.rejected`, `command.completed`) are written to the `events` table (`entity_type` = command, `device_id` null), alongside the per-device effect/report events — a complete intent→outcome timeline for audit and the future AI.
- **Boot resilience**: env-var validation fails fast (config error), but transient RabbitMQ unavailability does **not** block `app.ready()` — the connection retries in the background. Auth + CRUD + state/event reads (all MariaDB) stay available; only `POST /commands` degrades to **503** while the broker is down.
- **Event immutability**: event history is append-only; events are never edited or deleted.
- **DB naming**: snake_case columns/tables via Prisma `@map`/`@@map`, applied to new **and** existing (`User`, `RefreshToken`) models.
- **Device state**: typed per device type via polymorphic morph (`state_type` + `state_id`) → per-type detail tables — no JSON column, single current facet.
- **Soft delete**: `deleted_at` on User, House, Room, Device; all reads exclude soft-deleted rows; a soft-deleted user cannot authenticate.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Event-driven over RabbitMQ; assume hardware exists | Builds v2-ready infrastructure; real devices confirm state asynchronously | — Pending |
| **Single-store MariaDB** event log (dropped MongoDB) — event log is source of truth; current state is a projection rebuilt from it | Mongo created the dual-store consistency tax (the top runtime risk) and hit a hard contradiction (time-series collections can't carry the `event_id` unique index our idempotency needs); a MariaDB append-only table gives source-of-truth log + idempotency + replay + cursor pagination, and the consumer's writes become one local transaction. AI-corpus/time-series benefits were speculative v2 | — Pending |
| Consumer pipeline is one MariaDB transaction (event insert + guarded state update + CAS target + roll-up) | Single store → atomic, no write-order invariant, no cross-store window | — Pending |
| Target transitions are compare-and-set (`pending → done|failed`, terminal); first terminal wins | Closes the reaper-vs-consumer race; late success after a reaper-timeout is logged as an event but doesn't flip a terminal status | — Pending |
| Command create: persist command+targets (tx) then publish effects | Avoids reports for an uncommitted command; reaper self-heals unpublished targets | — Pending |
| Fan-out cap (default ~200 targets), reject over cap | Prevents one selector from spawning unbounded targets/effects/events | — Pending |
| DLQ not drained/alerted in v1 (manual inspection) | Deliberate v1 deferral, not silent loss | — Pending |
| Event history of a soft-deleted device (you own) stays readable | Deletion hides from listings, not from history/telemetry | — Pending |
| Single current-state projection per device (no desired/reported twin) | The event log holds history; the command holds intent; only the real current state needs a fast record | — Pending |
| Typed per-device-type state via polymorphic morph (`state_type` + `state_id`) | Flexible (new type = new detail table, no Device change); typed detail; loose FK integrity acceptable since state is a rebuildable projection | — Pending |
| `user_id` denormalized on Room and Device | Ownership checks without joins; eliminates N+1 | — Pending |
| Soft delete (`deleted_at`) on User/House/Room/Device | Retain records; filter everywhere; soft-deleted user can't authenticate | — Pending |
| Guarded "update when match" for ordering + `event_id` unique index for idempotency | Prevents out-of-order/duplicate corruption; transaction provides atomicity, guard+index provide ordering+dedupe | — Pending |
| First-class `command` entity + selector targeting + best-effort fan-out | Supports bulk commands ("all lights off"); links intent → effects for AI; carries desired/pending | — Pending |
| Layered validation (2 tiers): acceptance sync (structural + action↔type **only for explicit-id selectors** → 400) + **type validation** async (all device-type business logic → state transitions). No "sub-type" term/column | Minimal sync acceptance; deep rules async; explicit-id mismatches still fail fast; type-scoped selectors need no action↔type check | — Pending |
| Failure taxonomy routes by **reason**: poison → DLQ; transient/**offline** → retry → DLQ; **determined** (deleted/rejected/invalid/type-incompatible) → failure report (acked, not DLQ) | DLQ is for unprocessable/uncertain messages, not settled device "no" outcomes | — Pending |
| Command-lifecycle events (received/resolved/rejected/completed) in the events table (`entity_type=command`) | Complete intent→outcome timeline for audit + future AI; cheap | — Pending |
| No Redis in v1 | No measured bottleneck; avoids re-introducing the unjustified-second-store tax just removed with Mongo | — Pending |
| Action vocabulary in code (TypeBox registry in `device-actions.ts`), per-device limits/config in DB | Static types + free validation; behavior is code anyway so a DB vocabulary would decouple from handlers; registry-seamed so v2 can swap to a DB source when dynamic/admin/per-tenant device types are a real requirement | — Pending |
| Reports flow in via RabbitMQ only (no REST report endpoint) | Exercises the exact event-driven path real hardware uses in v2 | — Pending |
| snake_case via `@map`/`@@map`, including existing models | Consistent DB convention across the schema | — Pending |
| Multi-tenant from day one; API-only v1; AI deferred | Existing auth supports many users; ship the platform first | — Pending |
| Entity PKs: uuid v7 for new domain entities (House/Room/Device/Command); User/RefreshToken stay Int | Non-enumerable + time-sortable IDs for URL-exposed multi-tenant resources | — Pending |
| Device report trust: validate device_id exists/owned in v1; reserve a `device_token` envelope field for v2 per-device secrets | Only our worker publishes in v1; non-breaking path to real hardware auth | — Pending |
| RabbitMQ: topic exchanges (effects/reports) + dead-letter exchange/queue, `prefetch=1` | Future per-device/type/room routing at no extra cost; bounded redelivery | — Pending |
| Event retention: no TTL in v1, retain all events | Events are the source of truth + AI corpus + state-rebuild source; archival deferred to v2 | — Pending |
| Tests: testcontainers (MariaDB + RabbitMQ — 2 containers, shared suite-level fixture) for async integration; pure unit tests for infra-free logic | Faithful DLQ/idempotency/redelivery semantics; mocks give false confidence; suite-level reuse keeps it tolerable on Windows/Docker Desktop | — Pending |
| Align existing tables to snake_case via `@@map` (`users`, `refresh_tokens`) — rename migration | Consistency; columns are already mapped, tables are not | — Pending |
| Command target terminal state: success report → done; worker failure report → failed; timeout **reaper** (`deadline_at` + periodic sweep) ages silent targets → failed; command rolls up done/partially_failed/failed | Makes `partially_failed` reachable; without a reaper a lost effect leaves a target pending forever | — Pending |
| Idempotency keyed on producer-minted `report_id` (uuid v7) = `event_id` | Message-identity dedupe generalizes to command-less reads and allows legitimate multi-report-per-command | — Pending |
| Boot resilience: env validation fail-fast; broker/Mongo connect in background; auth/CRUD unaffected, dependent endpoints 503 | Don't regress shipped `/auth` availability for a messaging hiccup | — Pending |
| State detail row created eagerly at device creation; consumer does a single guarded UPDATE | Removes create-or-update-without-transaction race | — Pending |
| Autonomous sensor telemetry (periodic command-less readings) deferred to v2 | v1 is command/state; keeps scope bounded. Sensors are modeled but produce no autonomous data in v1 | — Pending |

### Open decisions

All resolved as of 2026-06-29. (See the rows above.)

## Development Process (per phase)

Every phase plan must open with a **structure-first, test-first** sequence before any implementation tasks. The planner bakes these as the first tasks of each PLAN.md:

1. **Scaffold** — create the phase's files with real signatures, types, and properties; bodies are `// TODO:` only, no logic.
2. **Tests** — write the phase's unit + integration tests (`node:test` + `build(t)` / `app.inject()`) covering its requirements; they compile and run red.
3. **Implement** — fill in logic task-by-task until the tests pass.

**Exception for schema/infra phases:** a phase with no runnable application logic (e.g. the schema phase) has nothing to run red. There, step 2 is honestly a **compile + migration smoke-check** (`prisma migrate dev` applies, `npm run build` compiles, existing tests still pass), not a failing test. Don't dress a compile check up as TDD-red.

This is a hard rule for planning and execution — see Working Style in CLAUDE.md.

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-30 — single-store MariaDB; one-transaction consumer; CAS first-terminal-wins; fan-out cap; persist-then-publish; two-tier validation (sync acceptance + action↔type for explicit-id selectors; async type validation = all business logic); failure taxonomy by reason; command-lifecycle timeline events; no Redis*
