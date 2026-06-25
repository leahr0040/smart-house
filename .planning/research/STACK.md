# Technology Stack — Smart-Home Device State & Telemetry

**Project:** smart-house (v1 data platform milestone)
**Researched:** 2026-06-25
**Confidence:** HIGH for core choices (all fit within the already-installed ecosystem); MEDIUM for MariaDB time-series patterns (less commonly documented than Postgres equivalents)

---

## Context: What Must NOT Change

The existing stack is locked:

- **Fastify 5.8.5** + `@fastify/autoload`, `@fastify/jwt`, `@fastify/cookie`, `@fastify/sensible`
- **Prisma 7.8.0** with `@prisma/adapter-mariadb` (driver-adapter pattern, NOT the TCP connector)
- **MariaDB** (provider = `"mysql"` in schema, using MariaDB-compatible dialect)
- **TypeScript 6** strict mode, compiling to CommonJS ES2020
- **Node.js 18+** runtime
- **`node:test`** built-in test runner

This research ONLY covers what to add on top.

---

## Recommended Stack (New Additions)

### Validation Layer

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@sinclair/typebox` | `^0.34.x` | Request/response schema + TypeScript type inference | Project standard (PLAN.md rule 1.5). TypeBox schemas are plain JSON Schema objects at runtime — Fastify consumes them natively for validation and serialization — while `Static<typeof schema>` gives compile-time types. No separate `type` aliases needed. Use discriminated unions (`Type.Union([...])` with a `kind` discriminator field) for heterogeneous per-device-type state. |

**Why NOT Zod here:** Zod is already installed for env validation and can stay. But Zod schemas are NOT JSON Schema; Fastify cannot use them as route schemas directly (you'd need `fastify-type-provider-zod` and an adapter). TypeBox plugs directly into Fastify's type provider with zero adapter code. Mixing providers for routes invites confusion — TypeBox is the single source of truth for routes.

**Why NOT hand-written `as const` JSON Schema:** Already deprecated by PLAN.md rule 1.5. No inference, verbose, error-prone for complex union types.

**Install:**
```bash
npm install @sinclair/typebox
```

---

### Current-State Storage (Operational Entities)

**Decision: MariaDB via Prisma (existing DB), no new store for current state.**

Current device state (power on/off, target temperature, current reading, mode, etc.) is low-write, point-in-time, and must be consistent with the entity hierarchy (User → House → Room → Device). This is exactly what the relational layer is already built for.

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| MariaDB (existing) | — | Store House, Room, Device, DeviceState | Foreign-key integrity, transactions for state updates, already operational |
| Prisma `Json` field type | `@prisma/client` 7.8.0 (existing) | Flexible per-device state payload | MariaDB maps Prisma `Json` to a `JSON` column. Prisma types it as `Prisma.JsonValue`. Device-type-specific validation enforced in the service layer via TypeBox discriminated unions — NOT at the DB level. |

**Schema pattern for device state:**

```prisma
model Device {
  id         Int         @id @default(autoincrement())
  roomId     Int         @map("room_id")
  room       Room        @relation(fields: [roomId], references: [id])
  kind       String      // "LIGHT" | "AC" | "HEATER" | "SENSOR" — enum enforced in code
  name       String
  state      Json        // validated per `kind` in service layer
  createdAt  DateTime    @default(now()) @map("created_at")
  updatedAt  DateTime    @updatedAt @map("updated_at")

  events     DeviceEvent[]

  @@index([roomId])
  @@map("devices")
}
```

**Why `Json` over separate columns per device type:** Adding a device type (e.g., `DOORLOCK`) does not require a migration. State shape validated in code, stored opaquely in DB. The column remains queryable (MariaDB JSON functions) and AI-exportable without schema changes.

**Why NOT a separate `DeviceState` table with EAV (Entity-Attribute-Value):** EAV (one row per attribute name/value) is an anti-pattern here — it destroys type safety, makes queries complex, and gives no benefit over a JSON column when the full state is always read/written atomically.

**Why NOT a polymorphic table per device type** (e.g., `lights`, `ac_units`): Schema explosion. Adding a type requires a migration, a new model, and a new service. The AI consumer would need per-table joins.

---

### Event History / Telemetry Storage

**Decision: MariaDB append-only event table via Prisma. No external time-series database in v1.**

PLAN.md section 2 describes a future hybrid store. For v1 the volume is simulated/development-scale and the constraint is to stay within the existing stack. A well-indexed append-only table in MariaDB is the right v1 choice. The model is designed so it can be extracted to a separate store (InfluxDB, TimescaleDB) in v2 without API changes.

| Technology | Purpose | Why |
|------------|---------|-----|
| MariaDB `DeviceEvent` table | Immutable event log: state-change commands and sensor reports | Single store, no ops overhead, Prisma-managed migrations. Append-only enforced by never exposing UPDATE/DELETE on this table in services. |
| Prisma cursor-based pagination | Querying event history by time range and device | Prisma `findMany` with `where: { deviceId, recordedAt: { gte, lte } }` + `cursor`/`take` is the idiomatic pattern. Do NOT use `skip`-based offset pagination for large event tables (offset degrades with row count). |

**Schema pattern for the event log:**

```prisma
model DeviceEvent {
  id           BigInt    @id @default(autoincrement())   // BigInt — event tables grow large
  deviceId     Int       @map("device_id")
  device       Device    @relation(fields: [deviceId], references: [id])
  kind         String    // "COMMAND" | "REPORT" — who initiated the event
  stateSnapshot Json     // full state AT THE TIME of the event (not a diff)
  recordedAt   DateTime  @default(now()) @map("recorded_at")

  @@index([deviceId, recordedAt])   // covers all time-range queries
  @@map("device_events")
}
```

**Critical index:** The compound `(deviceId, recordedAt)` index is what makes time-range queries fast. Without it, every history query scans the full table. Include it from the first migration.

**Why `id` is `BigInt`:** Event tables easily exceed the `Int` (2^31 ≈ 2 billion) range at moderate IoT volumes. Use `BigInt` from the start to avoid an expensive migration later. Prisma maps `BigInt` to JS `bigint` — serialize to `string` in API responses (JSON does not support 64-bit integers safely).

**Why full `stateSnapshot` not a diff:** Diffs are complex to reconstruct (requires replaying from initial state). A snapshot per event is slightly larger but enables direct querying ("what was the state at time T?") without replay. AI consumption is also simpler. Storage overhead is negligible at v1 scale.

**Why NOT a separate time-series database (InfluxDB, TimescaleDB, QuestDB) in v1:**
- Adds ops complexity (a second database process, connection pool, migrations).
- No simulated-hardware load in v1 — the volume does not justify it.
- PLAN.md explicitly stages this as Phase 2+.
- The append-only table schema is forward-compatible: if you later extract to InfluxDB, the API surface stays identical.

**Why NOT MariaDB ColumnStore (columnar engine):** ColumnStore is a separate engine not available in standard MariaDB distributions and requires significant ops setup. Overkill for v1.

---

### Multi-Tenant Query Scoping

No new library needed. The pattern is:

1. All routes that touch House/Room/Device/Event require the JWT `preHandler`.
2. Services receive `userId` (from `request.user.id`) and include `where: { userId }` or join through the ownership chain.
3. Never expose a device/event by raw ID without verifying the calling user owns the parent house.

This is a code discipline pattern, not a library. Enforce it in service function signatures: every service that returns tenant-scoped data takes an explicit `userId` parameter.

---

### Pagination for Event History

| Technology | Purpose | Why |
|------------|---------|-----|
| Prisma cursor pagination (built-in) | Page through large event result sets | Cursor-based pagination via `cursor: { id: lastSeenId }` + `take: N` is O(1) per page regardless of table size. Offset (`skip`) degrades linearly. For an append-only event log this is the only acceptable approach at scale. |

**API contract:** Return `{ items: [...], nextCursor: string | null }` — `nextCursor` is the last `id` (as string, since `BigInt`). Client passes `?cursor=<id>` on subsequent requests.

---

### TypeBox Discriminated Union for Per-Device State

TypeBox's `Type.Union` with a literal discriminator field is the v1 pattern. No external library.

```typescript
import { Type, Static } from '@sinclair/typebox'

export const LightState = Type.Object({
  kind: Type.Literal('LIGHT'),
  on: Type.Boolean(),
  brightness: Type.Integer({ minimum: 0, maximum: 100 }),
})

export const AcState = Type.Object({
  kind: Type.Literal('AC'),
  on: Type.Boolean(),
  targetTemp: Type.Number({ minimum: 16, maximum: 30 }),
  mode: Type.Union([Type.Literal('COOL'), Type.Literal('HEAT'), Type.Literal('FAN')]),
})

export const DeviceStateSchema = Type.Union([LightState, AcState /*, ... */])
export type DeviceState = Static<typeof DeviceStateSchema>
```

At the service layer, validate the incoming `state` payload against `DeviceStateSchema` before writing to the DB. Fastify uses the union schema directly in the route's JSON Schema — it validates at the HTTP boundary too.

**Why NOT class-validator or Joi:** Already decided against (PLAN.md 1.5). TypeBox is the single schema standard.

---

## Alternatives Considered and Rejected

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Validation | `@sinclair/typebox` | `zod` (for routes) | Zod is not natively consumed by Fastify as JSON Schema; requires adapter. TypeBox is zero-friction with Fastify. |
| Validation | `@sinclair/typebox` | hand-written `as const` JSON Schema | Already deprecated by PLAN.md. No static type inference. |
| Current-state storage | Prisma `Json` column | EAV table | EAV destroys type safety, complex queries, anti-pattern. |
| Current-state storage | Prisma `Json` column | Per-type tables | Schema explosion, migration per new device type, complex AI export. |
| Event storage | MariaDB append-only table | InfluxDB / TimescaleDB | Ops overhead unjustified at v1 simulated scale; PLAN.md stages this as Phase 2. |
| Event storage | MariaDB append-only table | MariaDB ColumnStore | Requires non-standard MariaDB setup; overkill. |
| Pagination | Prisma cursor pagination | Offset (`skip`) pagination | Offset degrades linearly on large tables; unacceptable for event history at scale. |
| BigInt IDs for events | `BigInt` Prisma field | `Int` | Int overflows at ~2B rows; event tables grow large. Avoidable migration pain. |

---

## What NOT to Install (and Why)

| Library | Reason to Skip |
|---------|---------------|
| `influxdb-client` / `@influxdata/influxdb-client` | No second database in v1. Premature. Staged for Phase 2 (PLAN.md 2.2). |
| `ioredis` / `redis` | No caching or pub/sub in v1. Not needed for command-and-record model at simulated scale. |
| `fastify-type-provider-zod` | Would split route schemas between Zod and TypeBox. TypeBox is the project standard — use it exclusively for routes. |
| `mqtt` / `zigbee-herdsman` | Hardware protocol libraries. Explicitly out of scope for v1 (PROJECT.md). |
| `knex` | Raw query builder. Prisma already handles everything needed; Knex adds a second query layer. |
| `typeorm` | Competing ORM. Prisma is already established and stable. |
| `class-transformer` / `class-validator` | Class-based validation. TypeBox/functional approach is the project standard. |

---

## Installation

```bash
# New dependency for this milestone
npm install @sinclair/typebox

# No other new production dependencies required for Phase 1
# (MariaDB, Prisma, Fastify already installed)
```

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| TypeBox for validation | HIGH | Official Fastify recommendation; zero-friction with existing Fastify 5 setup; well-documented |
| `Json` column for device state | HIGH | Prisma 5+ `Json` type is well-supported on MariaDB/MySQL; standard pattern |
| Append-only event table in MariaDB | HIGH | Widely used pattern; Prisma handles migrations cleanly |
| Cursor pagination via Prisma | HIGH | Prisma docs explicitly recommend cursor over offset for large tables |
| `BigInt` for event IDs | HIGH | Prisma `BigInt` support is stable; minor serialization note (stringify in API) |
| Deferring second time-series DB | MEDIUM | Right call for v1 scope; future migration effort is non-trivial but bounded |
| MariaDB JSON column query performance | MEDIUM | MariaDB JSON functions are available but less mature than Postgres JSONB; avoid deep JSON querying — use for storage and full-document reads only |

---

## Sources

- Prisma documentation: `Json` field type, cursor-based pagination, BigInt support (knowledge current to August 2025)
- Fastify TypeBox integration: `@fastify/type-provider-typebox` pattern, `@sinclair/typebox` `Type.Union` discriminated unions
- PLAN.md (this repo): rules 1.3, 1.5; architecture sections 2.1–2.3
- PROJECT.md (this repo): constraints, out-of-scope items, key decisions
- MariaDB JSON column support: available since MariaDB 10.2, stable in 10.5+
