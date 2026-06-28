# Technology Stack — Smart-House Event-Driven Platform

**Project:** smart-house (event-driven milestone)
**Researched:** 2026-06-28
**Replaces:** STACK.md dated 2026-06-25 (pre-architecture-pivot)
**Overall Confidence:** HIGH for MongoDB driver and TypeBox; HIGH for amqplib core; MEDIUM for amqp-connection-manager integration patterns

> **⚠ 2026-06-28 UPDATE (b) — supersedes parts of this document.** The data model was refined after this doc was written. Where this document conflicts with the points below, the points below win (PROJECT.md / REQUIREMENTS.md are authoritative).
>
> - **No desired/reported twin.** Each device has a SINGLE current-state record (its real state), updated on report. "Desired"/pending lives on the `commands` table, not per device. All `desired_*` / `reported_*` columns and `sync_status` are removed.
> - **Current state via polymorphic morph.** Per-device-type state is referenced by (`state_type`, `state_id`) → per-type detail tables. No JSON. New device type = new detail table, no `Device` change. FK integrity is loose by design — acceptable because current state is a rebuildable projection of the event log.
> - **`user_id` denormalized on Room and Device.** Ownership checks use it directly (no joins through house→room); multi-device paths use batched `IN` queries (no N+1).
> - **Soft delete (`deleted_at`) on User, House, Room, Device.** Reads exclude soft-deleted rows; a soft-deleted user cannot authenticate.
> - **Atomic guarded updates.** Current-state and command-status writes are a single conditional `UPDATE … WHERE last_event_at < :incoming` (never read-then-write). Event idempotency via a MongoDB unique index on a deterministic event id.
> - **`commands` table.** API selector is a TypeBox discriminated union (`{kind:'devices'|'room'|'house', …}`). Stored normalized: `selector_kind` enum (DEVICES|ROOM|HOUSE) + `selector_scope_id` + `selector_device_type`; resolved devices in a `command_targets` table.
> - **Stack impact:** library choices in this doc are unchanged (mongodb v6, amqplib, amqp-connection-manager, TypeBox). Only the device-state storage shape changes (typed per-type tables → morph, single facet).

---

## What Must NOT Change (Locked Stack)

The following are established and must not be replaced:

| Technology | Version | Role |
|------------|---------|------|
| Fastify | 5.8.5 | HTTP framework |
| Prisma | 7.8.0 | ORM for MariaDB (driver-adapter pattern) |
| `@prisma/adapter-mariadb` | 7.8.0 | MariaDB wire-level adapter |
| MariaDB | 10.5+ | Relational store: auth, entities, twin state, commands |
| `@fastify/jwt` | 10.0.0 | JWT access tokens |
| `@fastify/cookie` | 11.0.2 | Refresh-token httpOnly cookie |
| TypeScript | 6.0.3 | Language (strict mode, CommonJS ES2020 output) |
| Zod | 4.4.3 | Env-var validation only (not route schemas) |
| `node:test` | built-in | Test runner |

This research covers ONLY what to ADD on top.

---

## Superseded Recommendations from STACK.md 2026-06-25

The following recommendations from the previous STACK.md are **explicitly reversed** by the architecture pivot:

| Old Recommendation | Status | Replacement |
|--------------------|--------|-------------|
| Event history in a MariaDB append-only `DeviceEvent` table | **REVERSED** | Event history in MongoDB (time-series collection) |
| `BigInt` PK on `DeviceEvent` with `@@index([deviceId, recordedAt])` | **REVERSED** | MongoDB `_id` (ObjectId) + `recordedAt` index on time-series collection |
| `$transaction` is mandatory for state + event dual-write | **REVERSED** | No DB transactions; event append is the single authoritative write; twin state is a projection |
| `Json` column for device state in Prisma | **REVERSED** | Dedicated typed state tables per device type in MariaDB |
| "Do NOT add a message broker" | **REVERSED** | RabbitMQ is a first-class requirement (MSG-01 through MSG-05) |
| Defer second store to Phase 2+ | **REVERSED** | MongoDB + RabbitMQ are v1 requirements |

---

## New Additions: Recommended Stack

### 1. MongoDB — Event History and Telemetry

**Decision: Native `mongodb` Node.js driver. NOT Mongoose. NOT the Prisma MongoDB connector.**

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `mongodb` | `^6.x` | MongoDB client — insert and query event documents, create time-series collections | Official MongoDB-maintained driver. Zero-overhead abstraction — returns plain JS objects. Time-series collection API is first-class in v6. No ODM layer needed for an append-only log. |

**Why NOT Mongoose:**
Mongoose adds an ODM layer (schemas, middleware, virtuals, populate) designed for document-centric CRUD applications. An append-only event log does not need any of that: you insert one event type, you query by `device_id` + time range, and you paginate. The Mongoose overhead (schema registration, model instantiation, middleware chains) adds complexity with zero benefit. The native driver is simpler, faster, and has a smaller surface area to reason about. Use `Collection<EventDocument>` with a TypeScript interface and you get full type safety without Mongoose.

**Why NOT the Prisma MongoDB connector:**
Prisma's MongoDB connector (`provider = "mongodb"`) uses a different connection mechanism than `@prisma/adapter-mariadb`. You cannot share a single Prisma instance across two providers in one schema. Adding a MongoDB provider would require either a second Prisma schema file (messy, unsupported) or forking the codebase. More importantly, Prisma's MongoDB support does not support time-series collections (a MongoDB-native concept), and cursor pagination on MongoDB requires working directly with the native `_id` ObjectId — Prisma abstracts this in a way that complicates the pattern. Use the native driver for MongoDB; keep Prisma exclusively for MariaDB.

**MongoDB time-series collection for events:**

Create the collection at app startup with `db.createCollection(name, { timeseries: { timeField: 'recorded_at', metaField: 'meta', granularity: 'seconds' } })`. Use `createIndexes` separately if you need compound secondary indexes beyond the automatic time + meta index. The `meta` field should carry `{ device_id, device_type, command_id }` — the fields you filter on. MongoDB automatically buckets documents by time, dramatically reducing storage and improving range-query performance.

For append-only requirements, time-series collections are the right primitive: they are write-optimized, do not support UPDATE or DELETE on individual documents (enforcing immutability at the engine level), and automatically produce efficient time-range scans.

**Cursor pagination on events:**

Use `_id`-based cursor pagination: after fetching a page, the last document's `_id` (an `ObjectId`) becomes the next-page cursor. On subsequent requests, query `{ _id: { $gt: ObjectId.createFromHexString(cursor) } }`. ObjectId encodes insertion time, so the cursor is monotonic and stable. Return cursor as a hex string in the API response (`nextCursor: lastDoc._id.toHexString()`). Do NOT use skip-based pagination on a time-series collection — skip is O(n) and degrades badly.

**Coexistence with Prisma:**

Maintain two separate connection singletons:
- `src/lib/prisma.ts` — existing Prisma client for MariaDB (unchanged)
- `src/lib/mongo.ts` — new `MongoClient` singleton for MongoDB

Register both as Fastify decorators in a plugin (`src/plugins/mongo.ts`). Manage lifecycle: call `mongoClient.connect()` on app startup and `mongoClient.close()` on `fastify.addHook('onClose', ...)`. The two clients are completely independent — no shared state, no shared connection pool, no interaction.

**Install:**
```bash
npm install mongodb
```

---

### 2. RabbitMQ — Effect Dispatch and Report Ingestion

**Decision: `amqplib` as the AMQP 0-9-1 client + `amqp-connection-manager` for connection resilience. NOT `rascal`.**

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `amqplib` | `^0.10.x` | AMQP 0-9-1 protocol client — channels, exchanges, queues, publish, consume | De facto standard for RabbitMQ in Node.js. Low-level enough to control topology precisely. Used directly by production codebases at scale. Stable API. |
| `amqp-connection-manager` | `^4.x` | Wraps `amqplib` with automatic reconnection, channel recovery, and message queuing during downtime | Without reconnection logic, a single broker restart will crash your app. `amqp-connection-manager` handles reconnection transparently and re-establishes channels and consumer registrations after a disconnect — essential for a production-ready event-driven app. |

**Why NOT bare `amqplib` alone:**
`amqplib` has no reconnection logic. If the broker is unavailable at startup or restarts mid-run, the connection is gone and there is no built-in recovery. You would need to write your own reconnection loop, backoff logic, and channel re-registration. `amqp-connection-manager` provides exactly this, is actively maintained, and is the standard wrapper used in production Node.js + RabbitMQ setups.

**Why NOT `rascal`:**
Rascal is a high-level config-driven abstraction over `amqplib` with its own topology DSL, publication/subscription patterns, and error recovery. It is well-designed but opinionated in ways that diverge from the topology this project needs to own explicitly. For a learning project building a specific exchange topology (one effects exchange, one reports queue, one DLQ), direct `amqplib` + `amqp-connection-manager` gives full control without fighting Rascal's abstractions. Rascal is better suited to teams that want declarative config and don't care about the AMQP primitives.

**Why NOT `rhea` / `rhea-promise`:**
`rhea` speaks AMQP 1.0 (the Azure Service Bus protocol). RabbitMQ's default and most feature-complete protocol is AMQP 0-9-1. Unless you're using RabbitMQ's experimental AMQP 1.0 plugin, use `amqplib`.

**Why NOT `bullmq` / `bee-queue`:**
These are Redis-backed job queue libraries, not AMQP clients. They do not speak to RabbitMQ.

**Fastify integration pattern:**

Create `src/plugins/rabbitmq.ts` as a Fastify plugin. On boot:
1. Create an `AmqpConnectionManager` instance targeting the broker URL.
2. Create a `ChannelWrapper` for publishing (effects out).
3. Create a second `ChannelWrapper` for consuming (reports in).
4. In each `ChannelWrapper`'s `setup` callback, assert the topology (exchanges, queues, bindings, DLQ policy).
5. Decorate `fastify` with `{ effectsChannel, reportsChannel }` so route handlers and services can publish.
6. Register `fastify.addHook('onClose', ...)` to call `connection.close()` on shutdown.

**Topology (as specified in MSG-01):**

```
Exchange: effects (topic)
  └─ routing key: "effect.{deviceType}.{deviceId}"
  └─ bound to queue: effects.queue
        └─ DLQ: effects.dlq (dead-letter exchange: dlx, routing key unchanged)

Exchange: reports (direct or default)
  └─ queue: reports.queue
        └─ DLQ: reports.dlq

DLX exchange: dlx (fanout or direct — routes to dlq queues)
```

The concrete topology (exchange types, routing-key patterns) is listed as an open decision in PROJECT.md; the AMQP client choice is not. Lock the client now; resolve the topology at the messaging-infra phase.

**Dead-letter queue pattern:**
When asserting queues, pass `{ deadLetterExchange: 'dlx', messageTtl: 30000 }` in the queue arguments. On nack with `requeue: false`, the broker automatically routes to the DLX. The consumer on `effects.dlq` / `reports.dlq` logs and alerts. Do NOT requeue indefinitely — it loops forever on malformed messages.

**Install:**
```bash
npm install amqplib amqp-connection-manager
npm install -D @types/amqplib
```

---

### 3. TypeBox — Typed Per-Device-Type State and Command Actions

**Decision: `@sinclair/typebox` `^0.34.x` (already in use for env validation; extend to route schemas and device-state unions).**

TypeBox is already the project validation standard (PLAN.md rule 1.5, CLAUDE.md). This section specifies how to apply it to the new typed-state requirements.

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@sinclair/typebox` | `^0.34.x` | Discriminated union schemas for per-device-type state + command actions; route request/response schemas | Zero-dependency JSON Schema generator with TypeScript inference. Fastify consumes TypeBox schemas natively via `@fastify/type-provider-typebox`. `Static<typeof T>` derives TypeScript types, eliminating parallel type aliases. |
| `@fastify/type-provider-typebox` | `^4.x` | Wires TypeBox as Fastify's type provider so route generics infer from TypeBox schemas | Without this, route handler types must be hand-typed. With it, `fastify.get<{ Params: Static<typeof ParamsSchema> }>` is inferred automatically. |

**Discriminated unions for device state (the core pattern):**

Each device type has a dedicated Prisma model (per PROJECT.md requirement DEV-05) AND a TypeBox schema. The schema is the single source of truth for what values are valid — Fastify validates at the HTTP boundary, the service layer validates before writing to the DB.

```typescript
// src/schemas/device-state.ts
import { Type, Static } from '@sinclair/typebox'

export const LightStateSchema = Type.Object({
  kind: Type.Literal('LIGHT'),
  on: Type.Boolean(),
  brightness: Type.Integer({ minimum: 0, maximum: 100 }),
})

export const AcStateSchema = Type.Object({
  kind: Type.Literal('AC'),
  on: Type.Boolean(),
  target_temp: Type.Number({ minimum: 16, maximum: 30 }),
  mode: Type.Union([
    Type.Literal('COOL'),
    Type.Literal('HEAT'),
    Type.Literal('FAN'),
  ]),
})

export const HeaterStateSchema = Type.Object({
  kind: Type.Literal('HEATER'),
  on: Type.Boolean(),
  target_temp: Type.Number({ minimum: 5, maximum: 30 }),
})

export const SensorStateSchema = Type.Object({
  kind: Type.Literal('SENSOR'),
  temperature: Type.Number(),
  humidity: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
})

// The union used for route validation and service-layer checks
export const DeviceStateSchema = Type.Union([
  LightStateSchema,
  AcStateSchema,
  HeaterStateSchema,
  SensorStateSchema,
])

export type DeviceState = Static<typeof DeviceStateSchema>
export type LightState = Static<typeof LightStateSchema>
export type AcState = Static<typeof AcStateSchema>
// etc.
```

**Discriminated unions for command actions:**

Commands target devices by selector and carry an action payload. Actions must be validated against the device type before dispatch (CMD-03). Use the same pattern:

```typescript
// src/schemas/command-action.ts
export const LightActionSchema = Type.Object({
  kind: Type.Literal('LIGHT'),
  action: Type.Union([
    Type.Literal('TURN_ON'),
    Type.Literal('TURN_OFF'),
    Type.Object({
      action: Type.Literal('SET_BRIGHTNESS'),
      brightness: Type.Integer({ minimum: 0, maximum: 100 }),
    }),
  ]),
})
// ...similar for AC, HEATER (SENSOR has no writable actions)

export const CommandActionSchema = Type.Union([
  LightActionSchema,
  AcActionSchema,
  HeaterActionSchema,
])
export type CommandAction = Static<typeof CommandActionSchema>
```

**Why TypeBox `Type.Union` over `additionalProperties: false` per-type objects with a runtime switch:**
A discriminated union schema is validated atomically at the Fastify boundary. The `kind` field acts as the discriminator — Fastify's Ajv instance resolves which branch applies. Without a discriminated union, you'd need either a permissive schema + manual runtime validation, or separate route endpoints per device type. The union is the idiomatic and correct pattern.

**`@fastify/type-provider-typebox` is required for full type inference in route handlers.** Without it, TypeBox schemas validate but handler `request.body` types fall back to `unknown`. Install it.

**Install:**
```bash
npm install @sinclair/typebox @fastify/type-provider-typebox
```

---

## Typed Per-Device-Type State Tables in MariaDB (Prisma)

This is not a new library but a schema decision that supersedes the old `Json` column approach.

**Pattern:**

Each device type gets a dedicated Prisma model (separate table). The `Device` model has a `deviceType` enum and a nullable foreign key to each type-specific state table. Because only one type applies per device, use a 1-to-1 nullable relation per type:

```prisma
model Device {
  id         String      @id @default(cuid())
  room_id    String
  room       Room        @relation(fields: [room_id], references: [id])
  type       DeviceType
  name       String
  created_at DateTime    @default(now())
  updated_at DateTime    @updatedAt

  light_state   LightState?
  ac_state      AcState?
  heater_state  HeaterState?
  sensor_state  SensorState?

  @@map("devices")
}

enum DeviceType {
  LIGHT
  AC
  HEATER
  SENSOR
}

model LightState {
  id           String   @id @default(cuid())
  device_id    String   @unique @map("device_id")
  device       Device   @relation(fields: [device_id], references: [id])
  // desired
  desired_on         Boolean  @map("desired_on")
  desired_brightness Int      @map("desired_brightness")
  // reported
  reported_on         Boolean? @map("reported_on")
  reported_brightness Int?     @map("reported_brightness")
  sync_status  SyncStatus @default(PENDING) @map("sync_status")
  updated_at   DateTime   @updatedAt @map("updated_at")

  @@map("light_states")
}

enum SyncStatus {
  PENDING
  SYNCED
  FAILED
}
```

**Why dedicated tables, not a JSON column (reversal of old recommendation):**
- Real typed columns get real DB constraints (e.g., `brightness` is an integer 0–100, not a free-form string).
- Prisma generates per-type TypeScript types automatically — no manual type casting needed.
- Queries on state fields (e.g., "find all lights where `reported_on = false`") use indexes, not JSON function scans.
- Twin-state semantics (`desired_*` vs `reported_*`) map naturally to columns, not to a JSON diff object.
- Adding a device type requires one migration (a new model + table) — explicit and versioned, not implicit.

**Why NOT EAV (Entity-Attribute-Value) tables:**
EAV is an anti-pattern here. It destroys Prisma's type inference, makes queries verbose (one join per attribute), and offers no benefit when the entire state object is always read and written together.

**Why nullable 1-to-1 relations per type instead of polymorphic single `DeviceState` table:**
A polymorphic table with device-type columns would have many NULL columns per row (an AC row has NULL light columns, etc.). Dedicated tables are clean, indexed independently, and Prisma's `include: { light_state: true }` is the idiomatic read pattern.

---

## Coexistence Architecture: Three Stores

```
src/lib/
  prisma.ts       ← singleton PrismaClient (MariaDB) — unchanged
  mongo.ts        ← singleton MongoClient (MongoDB) — NEW
  rabbitmq.ts     ← AmqpConnectionManager + ChannelWrapper refs — NEW

src/plugins/
  auth.ts         ← unchanged
  mongo.ts        ← connect MongoClient, decorate fastify.mongo, onClose ← NEW
  rabbitmq.ts     ← connect AMQP, decorate fastify.amqp, register consumers ← NEW
  error-handler.ts ← unchanged
  sensible.ts     ← unchanged
```

Each store has its own plugin, its own lifecycle, and its own singleton. They never interact at the connection layer. Services that need to write both a MariaDB row and a MongoDB event document do so in two separate calls — there is no distributed transaction and none is needed (the event append is the single authoritative write; the twin-state update in MariaDB is idempotent and can be rebuilt by replay if it fails).

---

## Alternatives Considered and Rejected

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| MongoDB client | Native `mongodb` v6 | Mongoose | ODM overhead not needed for append-only log; time-series collection support requires native driver |
| MongoDB client | Native `mongodb` v6 | Prisma MongoDB connector | Cannot coexist with `@prisma/adapter-mariadb` in one schema; no time-series support |
| RabbitMQ client | `amqplib` + `amqp-connection-manager` | Bare `amqplib` | No reconnection — broker restart kills the app |
| RabbitMQ client | `amqplib` + `amqp-connection-manager` | `rascal` | Opinionated DSL abstracts away topology control we want to own; overkill for a defined topology |
| RabbitMQ client | `amqplib` + `amqp-connection-manager` | `rhea` / `rhea-promise` | AMQP 1.0 only; RabbitMQ default protocol is AMQP 0-9-1 |
| RabbitMQ client | `amqplib` + `amqp-connection-manager` | `bullmq` / `bee-queue` | Redis-backed job queues; not AMQP clients |
| Device state storage | Dedicated typed tables per device type | Prisma `Json` column | Reversed — no type safety at DB level, no column indexes, twin-state fields don't map cleanly |
| Device state storage | Dedicated typed tables per device type | EAV table | Anti-pattern: destroys Prisma types, complex queries, no benefit |
| Validation | TypeBox `Type.Union` discriminated union | Zod (for routes) | Zod is not natively consumed by Fastify as JSON Schema; requires adapter; TypeBox is zero-friction |
| Event pagination | `_id`-based cursor pagination | Skip offset | Skip is O(n) on MongoDB; unacceptable for large event collections |

---

## What NOT to Install (and Why)

| Library | Reason to Skip |
|---------|---------------|
| `mongoose` | ODM overhead; no time-series support; not needed for append-only log |
| `rascal` | Opinionated RabbitMQ abstraction; we want direct topology control |
| `rhea` / `rhea-promise` | AMQP 1.0 — wrong protocol version for standard RabbitMQ |
| `bullmq` / `bee-queue` / `kue` | Redis-backed job queues; not AMQP clients |
| `ioredis` / `redis` | No caching or Redis pub/sub in v1 |
| `influxdb-client` | No third time-series DB; MongoDB time-series collections cover telemetry |
| `fastify-type-provider-zod` | Splits route schema standard; TypeBox is the sole route validation layer |
| `class-validator` / `class-transformer` | Class-based validation; project standard is TypeBox |
| `knex` | Second query layer; Prisma handles MariaDB, native driver handles MongoDB |
| `mqtt` / `zigbee-herdsman` | Hardware protocol libs; explicitly out of scope for v1 |
| `@prisma/adapter-mongodb` | Does not exist; Prisma MongoDB uses a provider string, not a driver adapter — and it cannot coexist with the MariaDB adapter in one schema |

---

## Installation Summary

```bash
# MongoDB native driver
npm install mongodb

# RabbitMQ client + reconnection wrapper
npm install amqplib amqp-connection-manager

# TypeBox type provider for Fastify (wires TypeBox into route handler types)
npm install @fastify/type-provider-typebox

# TypeScript types for amqplib
npm install -D @types/amqplib

# @sinclair/typebox — check if already present; install if not
# (was listed as a new dep in previous STACK.md; confirm with `npm ls @sinclair/typebox`)
npm install @sinclair/typebox
```

**Note on `@sinclair/typebox`:** The previous STACK.md recommended installing it. If it has already been installed as part of an earlier phase, skip this line. The version to target is `^0.34.x`.

---

## Required Environment Variables (New)

Add to `.env` and the Zod env schema in `src/lib/env.ts`:

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URL` | Yes | MongoDB connection string (e.g., `mongodb://localhost:27017`) |
| `MONGODB_DB` | Yes | Database name (e.g., `smart_house`) |
| `RABBITMQ_URL` | Yes | AMQP broker URL (e.g., `amqp://guest:guest@localhost:5672`) |

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| MongoDB native driver v6 | HIGH | Official driver; stable API; time-series collection support is documented and production-ready since MongoDB 5.0 |
| Native driver vs Mongoose | HIGH | Clear-cut for append-only log; Mongoose adds zero value here |
| Native driver vs Prisma MongoDB connector | HIGH | Technical incompatibility with `@prisma/adapter-mariadb` in same schema; no time-series support |
| `amqplib` + `amqp-connection-manager` | HIGH | Industry-standard combination; well-maintained; `amqp-connection-manager` is the canonical reconnection solution |
| TypeBox discriminated unions for device state | HIGH | Pattern is well-established; Fastify consumes TypeBox natively; `Type.Union` with literal discriminator is the documented approach |
| Typed per-device-type Prisma tables | HIGH | Prescribed by PROJECT.md; standard Prisma pattern; no ambiguity |
| `@fastify/type-provider-typebox` | HIGH | Official Fastify plugin; zero-friction with Fastify 5 |
| MongoDB time-series cursor pagination | MEDIUM | `_id`-based cursor on time-series collections works but requires care: `_id` on time-series documents is generated by the bucket, not the individual measurement — verify cursor field against actual document structure when implementing |
| DLQ topology | MEDIUM | Concrete routing-key patterns are an open decision (PROJECT.md); the client libraries support it fully, the exact config needs phase-specific resolution |

---

## Sources

- MongoDB Node.js Driver v6 documentation (official; knowledge current to August 2025)
- `amqplib` and `amqp-connection-manager` npm and GitHub documentation (knowledge current to August 2025)
- `@sinclair/typebox` v0.34 documentation + `@fastify/type-provider-typebox` (official Fastify docs)
- Fastify v5 type provider documentation
- PROJECT.md and REQUIREMENTS.md (this repo) — authoritative for architecture decisions
- CLAUDE.md (this repo) — authoritative for current implementation state
