# Smart House

## What This Is

A multi-tenant smart-home **state + telemetry REST API**. Each user owns one or more houses, divided into rooms, each containing smart devices (lights, air conditioners, heaters, sensors). The system always knows the **current state** of every device and keeps an append-only **event history** of every change and reading. Built on an existing Fastify 5 + Prisma + MariaDB backend with JWT auth already in place.

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

<!-- v1 scope: the smart-home data platform. Hypotheses until shipped. -->

- [ ] Model the hierarchy: User → House → Room → Device (multi-tenant, scoped per user)
- [ ] User can CRUD houses, rooms, and devices they own
- [ ] Each device has a current state; the API can command a state change (e.g. turn AC on)
- [ ] The API can ingest device/sensor reports that update current state (e.g. sensor reports 22°C)
- [ ] Every state change / reading is recorded as an immutable event in a history log
- [ ] User can query the current state of a house/room/device
- [ ] User can query the historical event timeline (filterable by device/room/time range)
- [ ] Per-device-type validation of state values enforced in code (enums per type), stored flexibly in the DB

### Out of Scope

<!-- Designed-for but not built in v1. Reasons prevent re-adding prematurely. -->

- AI automation-suggestion engine — future milestone; v1 builds the clean data foundation it will consume
- Real hardware / protocol integration (MQTT, Zigbee, Home Assistant) — v1 uses simulated API clients; no physical outbound control
- Web UI / dashboard — API-only for v1; consumed by API clients and a future frontend
- OAuth / social login — email/password auth is sufficient for v1

## Context

- **Brownfield.** An authentication API already exists and is the foundation: Fastify 5 REST API, MariaDB via Prisma (driver-adapter pattern, `@prisma/adapter-mariadb`), `@fastify/jwt`, autoloaded plugins + routes. See `.planning/codebase/` for the full map.
- **Auth token strategy is settled:** 15-min JWT access tokens + 7-day rotating opaque refresh tokens (SHA-256 hashed, single-use, httpOnly cookie scoped to `/auth`).
- **Validation standard is TypeBox** (per CLAUDE.md / PLAN.md rule 1.5). New schemas use TypeBox with `Static<typeof schema>`; the device/state validation enums fit this directly.
- **Service-layer pattern:** routes call pure service functions in `src/services/`; services call the Prisma singleton from `src/lib/prisma.ts`.
- **Future AI consumer** shapes the design: the event-history model should be uniform and analyzable enough that an AI component can later mine it for automation rules without a schema rewrite.

## Constraints

- **Tech stack**: Fastify 5 + Prisma + MariaDB — must extend the existing app, not replace it.
- **Validation**: New routes/schemas must use TypeBox (project standard).
- **Multi-tenancy**: All house/room/device/event data must be scoped to the owning user; no cross-tenant access.
- **Data integrity**: Event history is append-only/immutable — events are never edited or deleted.
- **Device state storage**: stored as flexible (string/JSON) values in the DB; correctness enforced per-device-type in code via enums.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Command & record interaction model | Covers both user-issued commands (turn on AC) and device-reported telemetry (sensor reads 22°C) | — Pending |
| Multi-tenant from day one | Existing auth already supports many users; cheaper to scope correctly now than retrofit | — Pending |
| Flexible state storage + code-level enum validation per device type | Easy to add device types without migrations; keeps history uniform for future AI; still validated | — Pending |
| AI / hardware / UI deferred, but designed-for | Ship the data platform first; avoid speculative complexity while keeping the model extensible | — Pending |
| API-only v1 | Matches current codebase; frontend can consume the same API later | — Pending |

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
*Last updated: 2026-06-25 after initialization*
