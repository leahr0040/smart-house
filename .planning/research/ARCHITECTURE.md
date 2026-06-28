# Architecture Patterns

**Domain:** Multi-tenant smart-home event-driven device-state + telemetry REST API
**Researched:** 2026-06-28
**Confidence:** HIGH — derived from authoritative PROJECT.md and REQUIREMENTS.md decisions, direct codebase analysis, and established event-sourcing/CQRS/IoT backend patterns.

> **SUPERSEDES:** The 2026-06-25 ARCHITECTURE.md. The earlier document recommended (a) denormalized `currentState` JSON column on the Device row, (b) DB transactions to atomically update state + insert event, (c) REST endpoints for device reports, and (d) no message broker. All four are superseded by the event-driven pivot. See "Superseded Guidance" section at the end of this file.

---

## Recommended Architecture

The system is an event-driven smart-home backend with three data stores and two async runtimes layered over the existing Fastify 5 auth app.

```
HTTP Client
     │  (JWT access token on all routes except auth)
     ▼
Fastify Route Layer  (src/routes/)
  /houses/*  /rooms/*  /devices/*  /commands/*  /events/*
     │   preHandler: fastify.authenticate
     │
     ▼
Command Handler  (src/command-handler/)
  ┌──────────────────────────────────────────────────────┐
  │  1. Resolve selector → owned device ids (MariaDB)    │
  │  2. Validate action per device type (TypeBox)        │
  │  3. Write command row to MariaDB                     │
  │  4. Translate action → per-device effect objects     │
  │  5. Publish effects to RabbitMQ effects exchange     │
  └──────────────────────────────────────────────────────┘
     │ publishes N effect messages (one per device)
     ▼
RabbitMQ
  effects exchange (topic)  ──►  device.effects queue
                                        │
                            ┌───────────┘
                            ▼
                   Simulated Device Worker  (src/workers/device-simulator.ts)
                     (consumes effect, applies, publishes report)
                            │ publishes report message
                            ▼
                   reports exchange (topic)  ──►  reports queue
                            │
                            └──────────────────┐
                                               ▼
                                    Report Consumer / Projector
                                    (src/workers/report-consumer.ts)
                                      1. Validate + deduplicate
                                      2. Write event to MongoDB
                                      3. Update twin state in MariaDB
                                         (desired/reported/sync_status)
                                      4. Update command row status
```

**Read paths** (no broker involvement):

```
GET /devices/:id/state          → twin state from MariaDB (typed state table)
GET /rooms/:id/state            → all device twins in room
GET /houses/:id/state           → full house snapshot
GET /commands/:id               → command row + per-device roll-up
GET /devices/:id/events         → resolve ownership in MariaDB → query MongoDB
```

---

## Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `src/routes/houses/` | CRUD /houses — ownership anchor | House service, authenticate |
| `src/routes/rooms/` | CRUD /houses/:houseId/rooms | Room service |
| `src/routes/devices/` | CRUD /rooms/:roomId/devices; GET twin state | Device service |
| `src/routes/commands/` | POST /commands (issue command); GET /commands/:id (status) | Command handler, command service |
| `src/routes/events/` | GET /devices/:id/events (history, cursor paged) | Event query service |
| `src/command-handler/index.ts` | Selector resolution, per-type validation, command row write, translation, publish | House/Room/Device services, MariaDB (via Prisma), RabbitMQ publisher |
| `src/command-handler/translator.ts` | Maps (deviceType, action, params) → EffectPayload | TypeBox device-action schemas |
| `src/workers/device-simulator.ts` | Consumes effect from RabbitMQ, applies state change, publishes report | RabbitMQ |
| `src/workers/report-consumer.ts` | Consumes report, deduplicates, appends event (MongoDB), projects twin (MariaDB), updates command status | MongoDB, Prisma (MariaDB) |
| `src/services/house.ts` | createHouse, getHousesByUser, getHouseById, updateHouse, deleteHouse | Prisma |
| `src/services/room.ts` | createRoom, getRoomsByHouse, getRoomById, updateRoom, deleteRoom | Prisma |
| `src/services/device.ts` | createDevice, getDeviceById, getDevicesByRoom, updateDevice, softDelete | Prisma |
| `src/services/command.ts` | createCommand, getCommandById, updateDeviceCommandStatus, rollUpCommandStatus | Prisma |
| `src/services/twin-state.ts` | upsertDesiredState, upsertReportedState, getDeviceTwinState | Prisma (typed state tables) |
| `src/services/event-query.ts` | queryEvents (ownership-scoped, cursor paged) | MongoDB client |
| `src/lib/rabbitmq.ts` | RabbitMQ connection + channel singleton; topology bootstrap (exchange/queue/DLQ declarations) | amqplib |
| `src/lib/mongodb.ts` | MongoDB client singleton | mongodb driver |
| `src/lib/device-actions.ts` | TypeBox schemas for valid actions per device type; action→effect translation registry | TypeBox |
| `src/lib/prisma.ts` | Prisma singleton (existing) | Prisma/MariaDB |
| `prisma/schema.prisma` | All MariaDB models (existing + new) | MariaDB |

**Hard rules (preserve existing conventions):**
- Services never import Fastify types; they take and return plain JS objects.
- Routes own the translation between HTTP shape and service arguments.
- Workers are not routes; they import services directly.
- The command handler is a pure TypeScript module, not a Fastify plugin — it is called by the `/commands` route and independently testable.

---

## Data Model

### MariaDB (Prisma) — Relational + Twin State + Commands

```
users
  └─< houses
        └─< rooms
              └─< devices
                    ├─── light_states         (1:1 per light device)
                    ├─── ac_states             (1:1 per AC device)
                    ├─── heater_states         (1:1 per heater device)
                    └─── sensor_states         (1:1 per sensor device)

commands
  └─< command_device_targets  (join: one row per device targeted by command)
```

**Key model shapes (conceptual Prisma):**

```prisma
model House {
  id        String   @id @default(cuid())
  name      String
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  rooms     Room[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([userId])
  @@map("houses")
}

model Room {
  id        String   @id @default(cuid())
  name      String
  houseId   String
  house     House    @relation(fields: [houseId], references: [id], onDelete: Cascade)
  devices   Device[]
  @@index([houseId])
  @@map("rooms")
}

model Device {
  id           String    @id @default(cuid())
  name         String
  type         String    // "light" | "ac" | "heater" | "sensor"
  roomId       String
  room         Room      @relation(fields: [roomId], references: [id], onDelete: Cascade)
  deletedAt    DateTime? // soft-delete
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  lightState   LightState?
  acState      AcState?
  heaterState  HeaterState?
  sensorState  SensorState?
  targets      CommandDeviceTarget[]
  @@index([roomId])
  @@map("devices")
}

// One typed state table per device type — all columns real, indexed, typed.
// desired_* = last commanded value; reported_* = last confirmed by device.
// sync_status: "in_sync" | "pending" | "failed"

model LightState {
  deviceId          String   @id
  device            Device   @relation(fields: [deviceId], references: [id])
  desiredPower      String   // "on" | "off"
  desiredBrightness Int?     // 0-100
  reportedPower     String?
  reportedBrightness Int?
  syncStatus        String   @default("pending")
  updatedAt         DateTime @updatedAt
  @@map("light_states")
}

model AcState {
  deviceId       String   @id
  device         Device   @relation(fields: [deviceId], references: [id])
  desiredPower   String
  desiredTemp    Float
  desiredMode    String   // "cool" | "heat" | "fan"
  reportedPower  String?
  reportedTemp   Float?
  reportedMode   String?
  syncStatus     String   @default("pending")
  updatedAt      DateTime @updatedAt
  @@map("ac_states")
}

// heater_states, sensor_states follow the same pattern.

model Command {
  id          String   @id @default(cuid())
  userId      String
  selector    Json     // { kind: "room"|"house"|"devices", id?, deviceType? }
  action      String   // e.g. "set_power", "set_temperature"
  params      Json     // action parameters
  status      String   @default("pending") // "pending"|"done"|"partially_failed"|"failed"
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  targets     CommandDeviceTarget[]
  @@index([userId])
  @@map("commands")
}

model CommandDeviceTarget {
  id          String   @id @default(cuid())
  commandId   String
  command     Command  @relation(fields: [commandId], references: [id])
  deviceId    String
  device      Device   @relation(fields: [deviceId], references: [id])
  status      String   @default("pending") // "pending"|"done"|"failed"
  updatedAt   DateTime @updatedAt
  @@unique([commandId, deviceId])
  @@index([commandId])
  @@map("command_device_targets")
}
```

**Why typed state tables instead of a JSON column:**
- Real columns are indexed, type-checked at the DB level, and Prisma generates accurate TypeScript types per device type — no `unknown` casting.
- A JSON column would require code-level validation on every read, cannot be indexed per field, and makes adding a new constraint a no-op at the DB level.
- New device type = new model in schema.prisma + new migration. This is intentional friction that prevents silent type drift.

### MongoDB — Event History (Source of Truth)

Collection: `device_events` (one document per effect or report per device)

```typescript
interface DeviceEvent {
  _id: ObjectId
  event_id: string           // idempotency key — sha256(commandId + deviceId + eventKind) for effects;
                              //                   sha256(reportId) for reports
  source: "command" | "report"
  event_kind: string         // e.g. "light.power_set", "ac.temperature_set", "sensor.reading"
  device_id: string          // MariaDB device PK
  device_type: string        // "light" | "ac" | "heater" | "sensor"
  command_id: string | null  // links to MariaDB commands row; null for spontaneous sensor reports
  state_snapshot: object     // full state at the moment of this event (desired for command-originated; reported for report-originated)
  recorded_at: Date          // indexed; use for time-range queries and cursor pagination
}
```

**Index strategy:**
- `{ device_id: 1, recorded_at: -1 }` — primary query pattern (device history, newest-first)
- `{ command_id: 1 }` — find all events caused by a specific command
- `{ event_id: 1 }` unique — idempotency enforcement

**Why MongoDB for events:**
- Append-only documents with flexible per-device-type `state_snapshot` shapes fit the document model.
- MariaDB could store events in a relational table, but per the key decisions in PROJECT.md MongoDB is chosen (accepted). The Prisma adapter pattern for MariaDB means adding a second DB is additive, not disruptive.
- The `state_snapshot` field is intentionally schemaless at the DB level; validation happens in the report consumer before insert.

### RabbitMQ Topology

```
effects exchange (type: topic, durable: true)
  routing key: "effect.{deviceType}.{deviceId}"
  └─► device_effects queue (durable, prefetch=1)
        └─► DLQ: device_effects_dlq (dead-letter exchange + queue)

reports exchange (type: topic, durable: true)
  routing key: "report.{deviceType}.{deviceId}"
  └─► device_reports queue (durable, prefetch=1)
        └─► DLQ: device_reports_dlq
```

**Effect message schema:**
```typescript
interface EffectMessage {
  effect_id: string      // UUID, idempotency key
  command_id: string
  device_id: string
  device_type: string
  action: string
  params: object         // validated TypeBox shape per action
  issued_at: string      // ISO timestamp
}
```

**Report message schema:**
```typescript
interface ReportMessage {
  report_id: string      // UUID, idempotency key
  device_id: string
  device_type: string
  command_id: string | null
  state: object          // full reported state snapshot
  reported_at: string    // ISO timestamp
}
```

---

## Data Flow

### Command Flow (write path — happy path)

```
POST /commands  { selector, action, params }
  │
  ├─ preHandler: fastify.authenticate
  ├─ Route: validate body via TypeBox schema
  │
  ├─ Command Handler:
  │   ├─ 1. Resolve selector to device ids
  │   │      SELECT devices WHERE (room_id = ? OR house.id = ?) AND type = ? (optional)
  │   │      AND room.house.userId = request.user.id    ← ownership enforced
  │   │      → resolvedDeviceIds[]
  │   │
  │   ├─ 2. Validate action per device type
  │   │      For each deviceType in resolvedDevices:
  │   │        TypeBox.check(actionSchema[deviceType][action], params)
  │   │        → 400 if action not valid for ANY targeted device type
  │   │
  │   ├─ 3. Write Command row + CommandDeviceTarget rows (one per device)
  │   │      status = "pending"
  │   │
  │   ├─ 4. Translate: for each device, build EffectMessage
  │   │      { effect_id: uuid(), command_id, device_id, device_type, action, params, issued_at }
  │   │
  │   └─ 5. Publish each EffectMessage to effects exchange
  │          routing key: "effect.{deviceType}.{deviceId}"
  │          — publish is best-effort; command row written regardless
  │
  └─ Route: 202 Accepted { commandId, targetCount }
```

### Effect Processing + Report Flow (async path)

```
RabbitMQ device_effects queue
  │
  ├─ Simulated Device Worker (prefetch=1, ack after success)
  │   ├─ Parse + validate EffectMessage
  │   ├─ Apply effect to in-memory device state (worker-local map)
  │   ├─ Build ReportMessage { report_id, device_id, command_id, state, reported_at }
  │   ├─ Publish to reports exchange
  │   └─ ack() the effect message
  │       (nack() on error → retry → DLQ after max-retries)
  │
RabbitMQ device_reports queue
  │
  └─ Report Consumer / Projector (prefetch=1, ack after all writes succeed)
      ├─ Parse + validate ReportMessage
      ├─ Deduplicate: check MongoDB for existing event_id
      │     (idempotent: if already recorded, ack and skip)
      ├─ Append event to MongoDB device_events
      │     { event_id: sha256(report_id), source: "report", state_snapshot: report.state, ... }
      ├─ Upsert reported_* columns in typed state table (MariaDB)
      ├─ Compute sync_status: desired == reported → "in_sync", else "pending"
      ├─ Update CommandDeviceTarget.status = "done" (or "failed" on error)
      ├─ Roll up Command.status (all done → "done"; any failed → "partially_failed")
      └─ ack() the report message
```

### Read Paths (no broker)

```
GET /devices/:id/state
  → twin-state service → SELECT from typed state table WHERE device_id = ? (ownership: JOIN devices → rooms → houses WHERE userId = ?)
  → { desired, reported, syncStatus }

GET /commands/:id
  → command service → SELECT command + JOIN command_device_targets WHERE command.userId = ?
  → { id, status, targetCount, perDeviceStatus[] }

GET /devices/:id/events?before=cursor&limit=50
  → event-query service:
    1. Resolve ownership: getDeviceById(id, userId) → 404 if null
    2. MongoDB: db.device_events.find({ device_id: id, recorded_at: { $lt: decodedCursor } })
                                  .sort({ recorded_at: -1 }).limit(51)
    3. If 51 results, next cursor = encode(results[50].recorded_at)
  → { events[], nextCursor }
```

---

## Projection-Without-Transactions Correctness

The event log (MongoDB) is the source of truth. The twin state in MariaDB is a projection — it can be rebuilt from the event log if it ever drifts.

### Why no DB transactions

A cross-store atomic write (MongoDB event append + MariaDB state update) requires a distributed transaction (XA/2PC), which adds coordinator complexity and failure modes that outweigh the benefit. The chosen strategy is:

**Single authoritative write = the MongoDB event append.** The MariaDB state update is a "best-effort projection" that can be replayed.

### Idempotency enforcement

Every write into MongoDB uses a deterministic `event_id`:
- For command-originated effects: `sha256(commandId + deviceId + eventKind)`
- For reports: `sha256(reportId)`

The report consumer checks for an existing document with this `event_id` before inserting (unique index enforces this at the DB level). On duplicate, the consumer acks and skips — no side effects are applied twice.

### Projection consistency rule

The report consumer applies this sequence:
1. Append event to MongoDB (if not duplicate)
2. Upsert MariaDB twin state
3. Update command target status

If the consumer crashes after step 1 but before step 2, the event is in MongoDB but MariaDB state is stale. On restart, RabbitMQ redelivers the message (at-least-once). The idempotency check in step 1 sees the existing event_id and skips the insert, then re-runs steps 2 and 3. This is safe because the state write is idempotent (upsert with the same values).

**Replay / rebuild procedure:** If MariaDB twin state becomes corrupt or is wiped, it can be rebuilt by replaying the `device_events` collection in `recorded_at` order, applying each event's `state_snapshot` to the appropriate typed state table. No state is lost because MongoDB holds the complete history.

### Ordering guarantee

RabbitMQ with `prefetch=1` per consumer ensures the report consumer processes one message at a time. Combined with the `recorded_at` field (set by the worker at report generation, not at consumer processing time), event ordering in MongoDB faithfully reflects the order events occurred at the device. Out-of-order delivery is possible in theory under failure scenarios; the `event_id` unique index prevents double-inserts, and the idempotency check handles redeliveries. For v1 (single consumer, simulated devices), strict ordering is not a concern.

---

## Multi-Tenant Ownership Scoping

**Ownership chain:** `User → House → Room → Device → twin state / command targets / events`

**Principle:** Every data access must anchor to `userId`. Services embed the ownership filter in the query. Routes never receive data that doesn't belong to the requesting user.

**MariaDB access pattern:**

```typescript
// Device lookup with ownership: returns null if device not found OR not owned
async function getDeviceById(id: string, userId: string) {
  return prisma.device.findFirst({
    where: { id, deletedAt: null, room: { house: { userId } } }
  })
}

// Selector resolution respects ownership at query time
async function resolveSelector(selector: Selector, userId: string): Promise<string[]> {
  if (selector.kind === 'devices') {
    const devices = await prisma.device.findMany({
      where: {
        id: { in: selector.ids },
        deletedAt: null,
        room: { house: { userId } }   // cross-tenant targets silently excluded
      }
    })
    return devices.map(d => d.id)
  }
  if (selector.kind === 'room') {
    const devices = await prisma.device.findMany({
      where: {
        roomId: selector.roomId,
        type: selector.deviceType ?? undefined,
        deletedAt: null,
        room: { house: { userId } }
      }
    })
    return devices.map(d => d.id)
  }
  // house selector: similar, filtering room.house.id = selector.houseId AND house.userId = userId
}
```

**MongoDB access pattern:**

MongoDB documents contain `device_id` (a MariaDB PK). MongoDB has no awareness of ownership. Multi-tenancy is enforced by:
1. Resolving `device_id` through MariaDB (ownership check) before querying MongoDB.
2. Never issuing a MongoDB query with a raw `device_id` without first confirming the requesting user owns it.

```typescript
// event-query service
async function queryEvents(deviceId: string, userId: string, cursor?: string, limit = 50) {
  // Step 1: ownership check in MariaDB
  const device = await getDeviceById(deviceId, userId)
  if (!device) throw new NotFoundError()

  // Step 2: query MongoDB — safe because ownership is confirmed
  const filter: Filter<DeviceEvent> = { device_id: deviceId }
  if (cursor) filter.recorded_at = { $lt: decodeCursor(cursor) }

  const events = await db.collection('device_events')
    .find(filter)
    .sort({ recorded_at: -1 })
    .limit(limit + 1)
    .toArray()

  const hasMore = events.length > limit
  return {
    events: events.slice(0, limit),
    nextCursor: hasMore ? encodeCursor(events[limit - 1].recorded_at) : null
  }
}
```

---

## RabbitMQ At-Least-Once and Idempotency

**Delivery guarantee:** RabbitMQ provides at-least-once delivery. Messages may be redelivered on consumer restart or nack.

**Consumer prefetch:** Both consumers set `prefetch=1` (channel.prefetch(1)). This means the consumer processes one message at a time, acking only after all downstream writes succeed. This prevents message loss and limits re-processing scope to one message on failure.

**Nack and retry strategy:**
- On processing failure (DB error, validation error): `nack(requeue: true)` up to N times (tracked via a `x-death` header counter or an in-memory map).
- After max retries: `nack(requeue: false)` → message routes to DLQ via dead-letter exchange.
- DLQ is monitored (alerting / manual intervention) — not auto-reprocessed in v1.

**Effect message idempotency:** The simulated device worker may receive the same effect twice (redelivery). The worker must check whether it already published a report for this `effect_id`. Simplest approach: the worker tracks `effect_id` in its in-memory state; on duplicate, it publishes a report again (the report consumer's idempotency check handles the rest).

**Report consumer idempotency (detailed above):** MongoDB unique index on `event_id` is the authoritative guard. The in-code pre-check is a performance optimization to avoid a duplicate-key error on every redelivery.

---

## Suggested Build Order

Dependencies run shallow-to-deep. Each phase depends on the one above it.

```
Phase 1: Schema + Entity CRUD
  ├─ Prisma schema: House, Room, Device, typed state tables, Command, CommandDeviceTarget
  │   (snake_case @@map on all models including existing User/RefreshToken)
  ├─ House service + House routes
  ├─ Room service + Room routes
  └─ Device service + Device CRUD routes (no state writes yet)

Phase 2: Messaging Infrastructure
  ├─ src/lib/rabbitmq.ts — connection singleton + topology bootstrap
  ├─ src/lib/mongodb.ts — client singleton
  └─ Environment variables: RABBITMQ_URL, MONGODB_URL, MONGODB_DB_NAME
      (extend src/lib/env.ts validation)

Phase 3: Command Handler + Dispatcher
  ├─ src/lib/device-actions.ts — TypeBox action schemas per device type
  ├─ src/command-handler/translator.ts — action → EffectMessage translation
  ├─ src/command-handler/index.ts — selector resolution, validation, write, publish
  ├─ src/services/command.ts — createCommand, updateTargetStatus, rollUpStatus
  └─ src/routes/commands/ — POST /commands, GET /commands/:id

Phase 4: Simulated Device Worker
  └─ src/workers/device-simulator.ts
       (consumes device_effects queue, publishes to device_reports)

Phase 5: Report Consumer + Projector
  ├─ src/services/twin-state.ts — upsertDesiredState, upsertReportedState, getDeviceTwinState
  ├─ src/workers/report-consumer.ts — consume, deduplicate, append event (MongoDB),
  │                                    upsert twin (MariaDB), update command status
  └─ src/routes/devices/state — GET twin state per device / room / house

Phase 6: Event History Routes
  ├─ src/services/event-query.ts — queryEvents (ownership-scoped, cursor paged)
  └─ src/routes/events/ — GET /devices/:id/events

Phase 7: Integration Tests
  ├─ Command-to-event round-trip tests (issue command → worker processes → event recorded)
  ├─ Ownership scoping tests (cross-tenant device returns 404)
  └─ Idempotency tests (redelivered report produces one event document)
```

**Rationale for this order:**
- Phase 1 first: Prisma generates TypeScript types that all downstream code depends on. Entity CRUD is the ownership foundation — you cannot resolve a selector without device ownership queries.
- Phase 2 before 3/4/5: The message broker and MongoDB clients must be initialized before any component tries to use them.
- Phase 3 (command handler) before Phase 4 (worker): The command handler publishes effects; the worker is the consumer. They can be developed against the same message schemas but the handler must exist first.
- Phase 5 (report consumer) after Phase 4: The report consumer is triggered by the worker's output.
- Phase 6 (event history) last: Events are produced by Phase 5; nothing to query before that pipeline runs.

---

## Integration with Existing App

The pivot extends — not replaces — the existing Fastify boot path:

- **No changes to `app.ts` boot sequence** — AutoLoad discovers new `src/routes/` subdirectories automatically.
- **No changes to existing auth plugins or routes** — `fastify.authenticate` is reused on all new protected routes unchanged.
- **`src/lib/prisma.ts` unchanged** — existing singleton; new models are added to the schema only.
- **New plugins** for broker + MongoDB connection: `src/plugins/rabbitmq.ts` and `src/plugins/mongodb.ts` (or bootstrap in `src/lib/`). Workers are spawned at server startup, not as Fastify plugins.
- **Workers as standalone processes** (preferred) or spawned via `fastify.addHook('onReady', ...)`. Standalone is cleaner for separation and independent restart.
- **Backward-compatible schema addition:** existing `User` and `RefreshToken` models gain `@@map` annotations and `User` gains `houses House[]` relation — no data change, one migration.

---

## Superseded Guidance from 2026-06-25 ARCHITECTURE.md

| Earlier recommendation | Status | New approach |
|-----------------------|--------|--------------|
| Denormalized `currentState` JSON column on Device | **Superseded** | Typed per-device-type state tables (LightState, AcState, etc.) with real columns |
| DB transactions to atomically update state + insert event | **Superseded** | No transactions; MongoDB event append is authoritative; MariaDB projection is idempotent upsert |
| `DeviceEvent` model in MariaDB / Prisma | **Superseded** | Events live in MongoDB `device_events` collection |
| POST /devices/:id/report REST endpoint for device reports | **Superseded** | Reports arrive via RabbitMQ only (MSG requirement) |
| No message broker in v1 | **Superseded** | RabbitMQ is core to v1 |
| Anti-Pattern 2 "deriving current state by replaying events" | **Partially superseded** | Replay is now an explicit recovery mechanism (not an anti-pattern), but denormalized twin state is still maintained for fast reads |
| Anti-Pattern "Atomic state-update + event-insert via Prisma transaction" as Pattern 1 | **Superseded** | The transaction pattern is replaced by the broker-mediated report consumer write sequence with idempotency |

---

## Scalability Considerations

| Concern | At v1 (simulated, ~100 users) | Future hardware scale |
|---------|------------------------------|----------------------|
| Command throughput | Synchronous selector resolution + async broker publish; adequate | Shard command handling; pre-compute device-room-house membership cache (Redis) |
| Report ingestion | Single consumer process; adequate | Horizontally scale report consumers; partition reports queue by device_type |
| Event history query | MongoDB with `(device_id, recorded_at)` index; adequate | Time-series collection with bucketing; index TTL for retention |
| Twin state reads | Direct MariaDB typed table lookup; O(1) per device | Add Redis cache layer for house snapshot queries |
| Multi-tenant isolation | WHERE clause + ownership join; adequate | Application-level tenant context filter; row-level security at extreme scale |

---

## Sources

- `.planning/PROJECT.md` — authoritative architecture decisions (HIGH confidence, ground truth)
- `.planning/REQUIREMENTS.md` — v1 requirements with MSG/EVENT constraints (HIGH confidence, ground truth)
- `.planning/codebase/ARCHITECTURE.md` — existing layered Fastify architecture (HIGH confidence, direct analysis)
- `.planning/codebase/STRUCTURE.md` — file/directory conventions (HIGH confidence, direct analysis)
- Event-sourcing / CQRS community practice — projection-without-transactions, idempotent consumer, at-least-once delivery handling (HIGH confidence, well-established patterns)
- RabbitMQ documentation — topic exchange, DLQ, prefetch, at-least-once semantics (HIGH confidence, established broker behavior)
