---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 01
current_phase_name: schema-data-conventions
status: executing
stopped_at: Phase 1 context gathered
last_updated: "2026-07-07T08:33:36.254Z"
progress:
  total_phases: 8
  completed_phases: 0
  total_plans: 2
  completed_plans: 0
  percent: 0
---

# Project State — Smart House

**Generated:** 2026-06-30

---

## Project Reference

**Core Value:** The system always reflects the true current state of the house AND preserves a complete, queryable history of every event — so nothing about the home's behavior is ever lost.

**Current Focus:** Phase 01 — schema-data-conventions

---

## Current Position

**Milestone:** 1 — Event-Driven Smart-Home Platform
**Phase:** 01 (schema-data-conventions) — EXECUTING
**Plan:** 1 of 2
**Status:** Executing Phase 01

```
Phase 1 [        ] Not started
Phase 2 [        ] Not started
Phase 3 [        ] Not started
Phase 4 [        ] Not started
Phase 5 [        ] Not started
Phase 6 [        ] Not started
Phase 7 [        ] Not started
Phase 8 [        ] Not started
```

**Overall:** 0 / 8 phases complete

---

## Performance Metrics

| Metric | Value |
|--------|-------|
| Phases total | 8 |
| Phases complete | 0 |
| Requirements total | 49 |
| Requirements delivered | 0 |
| Plans complete | 0 |
| Blockers | None |

---

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
| Polymorphic morph for typed state (`state_type` + `state_id` → per-type detail tables) | No JSON column; single current facet per device |

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

Plan and execute **Phase 1: Schema & Data Conventions.**

Start with:

1. Conduct the uuid-v7 storage spike (`BINARY(16)` vs `CHAR(36)`) and document the decision as a schema comment or ADR note.
2. Add all new Prisma models to `prisma/schema.prisma` (House, Room, Device, Command, CommandTarget, per-type state detail tables, Event). The `events` model must include `entity_type` + nullable `device_id` from day one.
3. Hand-author the rename migration for `users` and `refresh_tokens`; verify the generated SQL emits `RENAME TABLE`, not DROP+CREATE.
4. Run `prisma migrate dev`, `npm run build`, `npm test` — all must exit 0.

### Todos

- [ ] Plan Phase 1: Schema & Data Conventions
- [ ] Conduct uuid-v7-storage spike (BINARY(16) vs CHAR(36); confirm Prisma MariaDB adapter emits v7 not v4); record decision before migrations are finalized
- [ ] Hand-verify rename migration SQL emits `RENAME TABLE` (not DROP+CREATE) for existing User/RefreshToken tables
- [ ] Add `RABBITMQ_URL` to `.env.example` during Phase 3

### Blockers

None.

---

## Session Continuity

**Last session:** 2026-07-01T10:58:52.931Z
**Stopped at:** Phase 1 context gathered
**Resume file:** .planning/phases/01-schema-data-conventions/01-CONTEXT.md

**To resume:** Read `.planning/ROADMAP.md` Phase 1 detail section and `.planning/PROJECT.md` Constraints to re-establish context, then check which plans under Phase 1 are marked complete in the Progress table.

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
