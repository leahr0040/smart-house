---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 09
current_phase_name: ci-cd-pipeline-with-testcontainers
status: executing
stopped_at: Phase 3 context gathered
last_updated: "2026-08-03T18:22:26.927Z"
progress:
  total_phases: 9
  completed_phases: 2
  total_plans: 7
  completed_plans: 6
  percent: 22
---

# Project State — Smart House

**Generated:** 2026-06-30

---

## Project Reference

**Core Value:** The system always reflects the true current state of the house AND preserves a complete, queryable history of every event — so nothing about the home's behavior is ever lost.

**Current Focus:** Phase 09 — ci-cd-pipeline-with-testcontainers

---

## Current Position

**Milestone:** 1 — Event-Driven Smart-Home Platform
**Phase:** 09 (ci-cd-pipeline-with-testcontainers) — EXECUTING
**Plan:** 1 of 1
**Status:** Executing Phase 09

```
Phase 1 [x] Complete
Phase 2 [ ] Ready to plan
Phase 3 [ ] Not started
Phase 4 [ ] Not started
Phase 5 [ ] Not started
Phase 6 [ ] Not started
Phase 7 [ ] Not started
Phase 8 [ ] Not started
```

**Overall:** 1 / 8 phases complete

---

## Performance Metrics

| Metric | Value |
|--------|-------|
| Phases total | 8 |
| Phases complete | 1 |
| Requirements total | 49 |
| Requirements delivered | 4 (DATA-01..04) |
| Plans complete | 2 |
| Blockers | None |

---
| Phase 01 P02 | 25min | 3 tasks | 3 files |
| Phase 02 P01 | 2h | 4 tasks | 6 files |

## Accumulated Context

### Key Decisions (active — see PROJECT.md Key Decisions for full rationale)

| Decision | Constraint |
|----------|------------|
| Single-store MariaDB | `events` table is the source of truth; current-state row is a rebuildable projection; consumer writes are one local transaction |
| Consumer pipeline: one MariaDB transaction | event INSERT + guarded state UPDATE + CAS target + roll-up under `SELECT … FOR UPDATE`; commit, then ack |
| Deterministic `event_id = uuidv5(command_target_id)` + unique index | Effect redelivery re-produces the same id; duplicate INSERT is a no-op |
| `recorded_at` is producer-minted event-time | The ordering guard (tuple tiebreaker) is only sound on event-time |
| Two-tier validation | Tier 1 — acceptance (sync, pre-persist → 400): shape/types/format/required, selector well-formed, valid action, fan-out cap, action↔type only for explicit-device-id selectors. Tier 2 — type validation (async, worker/consumer path): all device-type business logic |
| Failure taxonomy by reason, retry via wait queue | Poison → nack (no requeue) straight to terminal DLQ; transient/offline → nack (no requeue) → `*.retry` wait queue (`x-message-ttl` ~30s, dead-letters back to main) → `x-death`-bounded (~5) → terminal DLQ; determined domain outcome → failure report, acked (not DLQ). Plain `requeue=true` is never used — it hot-spins and never advances `x-death` |
| Persist-then-publish | Command + targets in one transaction before effects are published; reaper self-heals unpublished targets |
| Fan-out cap ~200; explicit-id 0-owned → 400; scope 0-match → `no_targets` | Bounds fan-out; distinguishes client error from empty scope |
| Command-lifecycle events in `events` table (`entity_type=command`, `device_id=null`) | `command.received` on persist, `command.resolved` on dispatch, `command.rejected` via async type validation, `command.completed` when all targets terminal |
| RabbitMQ background connect; `POST /commands` → 503 when broker down | Auth/CRUD/state/event reads (all MariaDB) always available; broker unavailability does not block boot |
| Testcontainers: MariaDB + RabbitMQ (2 containers, shared fixture + between-test reset) | Faithful DLQ/idempotency/redelivery semantics without cross-test pollution |
| uuid v7 PKs for new entities; User/RefreshToken stay Int | Non-enumerable IDs; no migration needed for existing tables |
| `user_id` denormalized on Room, Device, Command | Ownership checks without joining through the hierarchy |
| Action vocabulary in TypeBox registry (`device-actions.ts`), registry-seamed | Static types + free validation; DB-backed vocabulary only if dynamic device types become a requirement |
| Eager state detail row at device creation | Consumer hot path is only ever a guarded UPDATE — never a create |
| Typed state via per-type detail tables selected by `device_type` (detail row keyed on unique `device_id`; no morph pointer) | No JSON column; single current facet per device |

### Architecture Constraints

- **Two data stores:** MariaDB (relational hierarchy + current-state projection + commands + append-only events table), RabbitMQ (effect dispatch + report ingestion). No MongoDB, no Redis.
- **`events` table schema:** `event_id` (uuid v7, UNIQUE), `entity_type` (device|command), `source`, `event_kind`, `device_id` (nullable — null for command-lifecycle rows), `device_type`, `command_id` (nullable), `snapshot`, `recorded_at`. Index on `(device_id, recorded_at)`.
- **Tuple guard on state UPDATE:** `WHERE (last_event_at, last_event_id) < (:recorded_at, :event_id)`; stale reports skip the UPDATE but the event row is still appended.
- **CAS target transitions:** `pending → done|failed` only; first-terminal-wins; a late report after a terminal state is recorded as an event but does not flip the status.
- **Reaper:** background sweep; ages `pending` targets past `deadline_at` to `failed` (CAS); recomputes command roll-up.
- **Command roll-up:** all done → `done`; all failed → `failed`; mixed → `partially_failed`.
- **RabbitMQ topology:** topic exchanges (`device_effects`, `device_reports`); per consumer queue a three-queue set — main queue, `*.retry` wait queue (`x-message-ttl` ~30s, `x-dead-letter-exchange` back to the main exchange), terminal `*.dlq`. Transient failures nack (no requeue) into the wait queue; TTL expiry redelivers to the main queue and increments `x-death`; at the configured max (~5) the message routes to the terminal DLQ instead. Poison messages nack (no requeue) straight to the terminal DLQ, bypassing the wait queue.
- **Worker is a separate process** (`npm run worker`); API process owns/declares RabbitMQ topology; worker asserts it idempotently on boot.
- **Validation standard:** TypeBox everywhere; `Static<typeof schema>` for handler types.
- **Service-layer pattern:** routes call pure services in `src/services/`; services call the `prisma` singleton from `src/lib/prisma.ts`.
- **Multi-tenancy:** all data scoped to owning user; second-user requests return 404 (not 403) for all ownership-sensitive endpoints.
- **Soft delete** on User/House/Room/Device; all reads exclude soft-deleted rows; soft-deleted device event history remains readable for the owner.
- **No event TTL in v1;** DLQ not drained or alerted in v1 — manual inspection only.

### Next Step

Discuss and plan **Phase 2: Entity CRUD & Multi-Tenancy** (no CONTEXT.md yet).

Start with `/gsd-discuss-phase 2` to gather context, then `/gsd-plan-phase 2`. Carried forward from Phase 1:

1. Routes must expose `public_id`, never the internal BigInt `id` (T-01-04 residual control; RESEARCH Open Question 4).
2. Decide the global BigInt-serialization strategy when domain models are first returned in HTTP responses (toJSON shim vs Prisma result extension vs public_id-only).
3. Implement the NanoID `public_id` generation seam (Prisma `$extends` on create for House/Room/Device/Command) — Phase 1 only shaped the column.

### Todos

- [x] Plan & execute Phase 1: Schema & Data Conventions
- [ ] Phase 2: expose `public_id` not internal `id`; wire NanoID generation seam; settle BigInt-serialization strategy
- [ ] Add `RABBITMQ_URL` to `.env.example` during Phase 3

### Roadmap Evolution

- Phase 9 added: CI/CD Pipeline with Testcontainers — GitHub Actions runs the suite on push/PR against an ephemeral Testcontainers MariaDB; CD deferred until a deploy target exists.

### Blockers

None.

---

## Session Continuity

**Last session:** 2026-08-02T10:18:43.561Z
**Stopped at:** Phase 3 context gathered
**Resume file:** .planning/phases/03-messaging-infrastructure/03-CONTEXT.md

**To resume:** Read `.planning/ROADMAP.md` Phase 2 detail section and `.planning/PROJECT.md` Constraints to re-establish context. Phase 2 has no CONTEXT.md yet — start with `/gsd-discuss-phase 2`.

**Key orientation points for the next session:**

- Existing codebase: Fastify 5 + Prisma + MariaDB auth API (register, login, refresh, me, logout). No house/room/device/event/command functionality exists yet.
- Phase 1 is schema-only. The acceptance bar is compile + migration smoke-check (not TDD-red) — see PROJECT.md Development Process exception for schema/infra phases.
- Phase 2 introduces eager state row creation at device creation (STATE-01 delivered here, not in the consumer).
- Phase 3 is RabbitMQ-only (no MongoDB, no Redis). Topology provisions, per consumer queue, a main queue + `*.retry` wait queue (`x-message-ttl` ~30s, dead-letters back to main) + terminal `*.dlq`. Boot resilience: background connect, 503 for POST /commands, all MariaDB routes always available.
- Phase 4 two-tier validation: acceptance checks action↔type only for explicit-device-id selectors; type-scoped and untyped-scope selectors defer all device-type business logic to async type validation (CMD-08 contract).
- Phase 5 worker classifies by reason: determined domain outcome → explicit failure report to device_reports (acked, NOT DLQ); transient → nack (requeue=false) → dead-letters into `*.retry` wait queue → bounded by `x-death` (~5) → terminal DLQ; poison → nack (requeue=false) straight to terminal DLQ, no retry hop.
- Phase 6 consumer: one MariaDB transaction per report; failure taxonomy enforced by reason via the same retry wait-queue mechanism as Phase 5; idempotency via unique index; tuple guard; first-terminal-wins.
- Phase 7 event history: MariaDB query on events table only; soft-deleted device history readable; cursor on (recorded_at, event_id).
- Phase 8 testcontainers: 2 containers (MariaDB + RabbitMQ), shared suite-level fixture, between-test reset; retry wait-queue exhaustion (not hot-spin) is asserted alongside the DLQ/reaper tests.

## Decisions

- [Phase 01]: Ten new domain models added with BigInt autoincrement PKs; public_id (NanoID-shaped VarChar(21)) shaped on House/Room/Device/Command only, generator deferred to Phase 2
- [Phase 01]: Events table carries a separate ordering BigInt id and idempotency Char(36) event_id (D-12) — never interchanged for ordering or dedup
- [Phase 01]: No native DB enums/CHECK/min-max anywhere in the new schema; all value/range/vocabulary rules deferred to TypeBox in later phases (D-06)
- [Phase 02-01]: public_id typing resolved with @default(nanoid(21)) as a TYPE-LEVEL AFFORDANCE only — column stays NOT NULL, app-side CSPRNG hook supplies every value (T-2-01), emits no SQL DEFAULT so the DB is untouched
- [Phase 02-01]: DB-touching tests must call after(closeDb) — Prisma's pool keeps the event loop alive and hangs npm test forever
- [Phase 02-01]: test data via @faker-js/faker factories, uuid suffix on emails (users.email is @unique; faker's pool repeats and would throw P2002)
