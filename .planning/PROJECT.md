# Smart House

## What This Is

A multi-tenant smart-home **state + telemetry platform**, built event-driven so it is ready for real hardware. Each user owns one or more houses, divided into rooms, each containing smart devices (lights, air conditioners, heaters, sensors). Users issue commands (including bulk commands like "turn off all the lights") that fan out to devices over a message broker; devices report back their actual state. The system tracks each device's **twin state** (desired vs reported) and records an immutable **event history** of every effect and report for future AI analysis. Built on an existing Fastify 5 + Prisma + MariaDB backend with JWT auth already in place.

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
- [ ] Typed per-device-type state (dedicated state tables per type; no JSON state column)
- [ ] Twin state per device: desired + reported + sync status
- [ ] First-class commands with selector-based targeting (device ids / room / house + optional type) and multi-device fan-out
- [ ] Illogical command (action invalid for a device type) is rejected with a validation error before dispatch
- [ ] Command status is queryable (per-device completion roll-up)
- [ ] Event-driven dispatch over RabbitMQ: effects out, reports in; simulated device worker stands in for hardware
- [ ] Immutable event history in MongoDB; current state is a projection of the event log (no DB transactions)
- [ ] Query current state (device/room/house) and event history (by device, time range, cursor paginated)

### Out of Scope

<!-- Designed-for but not built in v1. Reasons prevent re-adding prematurely. -->

- AI automation-suggestion engine — future milestone; v1 builds the clean event foundation it will consume
- Real hardware device drivers / physical protocol adapters (Zigbee, Z-Wave, real MQTT devices) — v1 uses a **simulated device worker** over RabbitMQ that speaks the same contract real hardware will; the messaging *infrastructure* is in scope, the physical drivers are not
- Web UI / dashboard — API-only for v1; consumed by API clients and a future frontend
- WebSocket / SSE push to clients — clients poll REST for v1
- OAuth / social login — email/password auth is sufficient for v1

## Context

- **Brownfield.** An authentication API already exists and is the foundation: Fastify 5 REST API, MariaDB via Prisma (driver-adapter pattern, `@prisma/adapter-mariadb`), `@fastify/jwt`, autoloaded plugins + routes. See `.planning/codebase/` for the full map.
- **Auth token strategy is settled:** 15-min JWT access tokens + 7-day rotating opaque refresh tokens (SHA-256 hashed, single-use, httpOnly cookie scoped to `/auth`).
- **Validation standard is TypeBox** (per CLAUDE.md / PLAN.md rule 1.5). New schemas use TypeBox with `Static<typeof schema>`. Per-device-type state and command actions are validated with TypeBox.
- **Service-layer pattern:** routes call pure service functions in `src/services/`; services call the Prisma singleton from `src/lib/prisma.ts`.
- **Event-driven core:** A **Command Handler** translates a high-level command into per-device effects, publishes them to RabbitMQ, and a **report consumer** ingests device reports to project state and append events. This models real hardware (assumed present) where state changes are confirmed asynchronously.
- **Three data stores:** MariaDB (relational: auth, houses, rooms, devices, twin state, commands), MongoDB (append-only event history / time-series), RabbitMQ (effect dispatch + report ingestion).
- **Future AI consumer** shapes the design: events are uniform documents linked to the command intent that caused them, so an AI component can later mine "intent → effects" causality without a schema rewrite.

## Constraints

- **Tech stack**: Extend the existing Fastify 5 + Prisma + MariaDB app, not replace it. Add MongoDB (events) and RabbitMQ (messaging).
- **Validation**: New routes/schemas/actions must use TypeBox (project standard).
- **Multi-tenancy**: All house/room/device/command/event data must be scoped to the owning user; no cross-tenant access. History queries resolve owned device ids in MariaDB before querying Mongo.
- **No DB transactions for state**: the event log is the source of truth; current (twin) state is a projection that can be rebuilt by replay. Single authoritative write = the event append.
- **Event immutability**: event history is append-only; events are never edited or deleted.
- **DB naming**: snake_case columns/tables via Prisma `@map`/`@@map`, applied to new **and** existing (`User`, `RefreshToken`) models.
- **Device state**: typed per device type in dedicated state tables — no generic JSON state column.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Event-driven over RabbitMQ; assume hardware exists | Builds v2-ready infrastructure; real devices confirm state asynchronously | — Pending |
| Event log is source of truth; current state is a projection; no DB transactions | Avoids dual-write atomicity problem; supports replay/self-heal; fits async hardware | — Pending |
| Event history in MongoDB (time-series collections) | Append-only telemetry; flexible documents; objection (atomicity) removed once transactions dropped | — Pending |
| Typed per-device-type state tables (no JSON) | Real columns/constraints, indexed typed queries, Prisma types per type | — Pending |
| First-class `command` entity + selector targeting + best-effort fan-out | Supports bulk commands ("all lights off"); links intent → effects for AI | — Pending |
| Illogical action ⇒ 400 (validate at handler before dispatch) | Fail fast; don't dispatch nonsense to devices | — Pending |
| Twin state: desired + reported + sync_status | Honest model for async hardware confirmation | — Pending |
| Reports flow in via RabbitMQ only (no REST report endpoint) | Exercises the exact event-driven path real hardware uses in v2 | — Pending |
| snake_case via `@map`/`@@map`, including existing models | Consistent DB convention across the schema | — Pending |
| Multi-tenant from day one | Existing auth supports many users; cheaper to scope correctly now | — Pending |
| API-only v1 (no UI), AI deferred | Ship the platform first; keep model extensible | — Pending |

### Open decisions (to resolve before the relevant phase)

| Question | Needed by |
|----------|-----------|
| Device identity/auth: broker-level only vs per-device token validated in the report consumer | Messaging / report-consumer phase |
| `cuid` vs `uuid` for entity PKs | First entity phase |
| Concrete RabbitMQ topology (exchange types, routing keys, DLQ policy) | Messaging-infra phase |
| Event retention defaults (product decision) | Event-history phase |

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
*Last updated: 2026-06-28 after architecture discussion (event-driven / RabbitMQ / MongoDB / twin state / commands)*
