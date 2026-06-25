# Architecture Patterns

**Domain:** Multi-tenant smart-home device-state + telemetry REST API
**Researched:** 2026-06-25
**Confidence:** HIGH — patterns derived from established IoT/smart-home backend literature, CQRS/event-sourcing community practice, and direct analysis of the existing codebase.

---

## Recommended Architecture

The new milestone extends the existing layered Fastify app with four new top-level domains — House, Room, Device, and Event — without touching the auth layer. The central design decision is **denormalized current state alongside an append-only event log**: current state lives in a `device_states` or `devices.currentState` column for fast reads, and every write that changes it also appends an immutable row to `device_events`. This avoids the complexity of full event sourcing (where state must be replayed) while still giving you the complete history an AI consumer needs.

```
HTTP Client
     │
     ▼
Fastify Route Layer  (src/routes/)
  /houses/*   /rooms/*   /devices/*   /events/*
     │  all protected via preHandler: fastify.authenticate
     │
     ▼
Service Layer  (src/services/)
  house.ts   room.ts   device.ts   event.ts
     │
     ▼
Prisma Data Layer  (src/lib/prisma.ts singleton)
     │
     ▼
MariaDB
  users  ──< houses ──< rooms ──< devices ──< device_events
                                      │
                                  device_states (inline or separate)
```

---

## Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `src/routes/houses/index.ts` | CRUD /houses, ownership enforcement | House service, fastify.authenticate |
| `src/routes/rooms/index.ts` | CRUD /houses/:houseId/rooms | Room service |
| `src/routes/devices/index.ts` | CRUD /rooms/:roomId/devices, GET current state | Device service |
| `src/routes/devices/command/index.ts` | POST /devices/:id/command — intent in | Device service, Event service |
| `src/routes/devices/report/index.ts` | POST /devices/:id/report — sensor data in | Device service, Event service |
| `src/routes/events/index.ts` | GET /events — history queries, filter by device/room/time | Event service |
| `src/services/house.ts` | createHouse, getHousesByUser, getHouseById, updateHouse, deleteHouse | Prisma |
| `src/services/room.ts` | createRoom, getRoomsByHouse, getRoomById, updateRoom, deleteRoom | Prisma |
| `src/services/device.ts` | createDevice, getDeviceById, updateDeviceState, deleteDevice | Prisma |
| `src/services/event.ts` | recordEvent, queryEvents | Prisma |
| `prisma/schema.prisma` | House, Room, Device, DeviceEvent models | MariaDB |

**Hard rule:** services never import from `src/routes/` or from Fastify types. The route layer owns the translation between HTTP shape and service arguments — the same pattern already in use for auth.

---

## Data Model

### Prisma schema additions (conceptual)

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
}

model Room {
  id        String   @id @default(cuid())
  name      String
  houseId   String
  house     House    @relation(fields: [houseId], references: [id], onDelete: Cascade)
  devices   Device[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([houseId])
}

model Device {
  id           String        @id @default(cuid())
  name         String
  type         String        // "light" | "ac" | "heater" | "sensor" — enforced in code
  roomId       String
  room         Room          @relation(fields: [roomId], references: [id], onDelete: Cascade)
  // Denormalized current state — fast reads, no replay needed
  currentState String        // JSON string, validated per type in service layer
  updatedAt    DateTime      @updatedAt
  createdAt    DateTime      @default(now())
  events       DeviceEvent[]

  @@index([roomId])
}

model DeviceEvent {
  id         String   @id @default(cuid())
  deviceId   String
  device     Device   @relation(fields: [deviceId], references: [id])
  // "command" = user-issued intent; "report" = device-reported telemetry
  source     String   // "command" | "report"
  state      String   // JSON snapshot of the full state at this moment
  createdAt  DateTime @default(now())

  @@index([deviceId])
  @@index([createdAt])
}
```

**Why this shape:**
- `Device.currentState` is a JSON string — flexible, avoids a migration per new device type, validated per `type` in the service layer using TypeBox discriminated unions.
- `DeviceEvent.state` is a full snapshot (not a delta) — the AI consumer gets a self-contained row per event without needing to reconstruct prior state.
- `DeviceEvent.source` distinguishes commands from reports — enables filtering "only changes the user made" vs "only sensor readings".
- `onDelete: Cascade` propagates house deletion through rooms → devices → events without orphan rows.

---

## Multi-Tenant Scoping Strategy

All data is scoped through the ownership chain: `User → House → Room → Device → DeviceEvent`.

**Strategy: anchor every query to `userId` at the house level.**

1. Every authenticated request provides `request.user.id` (from the JWT, via `fastify.authenticate`).
2. House service functions always filter by `userId`: `prisma.house.findFirst({ where: { id, userId } })`.
3. Room/device queries join through the house: `prisma.room.findFirst({ where: { id, house: { userId } } })`.
4. No cross-tenant leakage is possible if this join is always present — a missing join is a security bug, not just a data bug.
5. Services enforce this; routes do not re-implement ownership checks.

**Recommended helper pattern in services:**

```typescript
// src/services/house.ts
export async function getHouseById(id: string, userId: string) {
  return prisma.house.findFirst({ where: { id, userId } })
  // returns null if not found OR not owned — route throws 404 in both cases
}

// src/services/room.ts
export async function getRoomById(id: string, userId: string) {
  return prisma.room.findFirst({
    where: { id, house: { userId } }
  })
}

// src/services/device.ts
export async function getDeviceById(id: string, userId: string) {
  return prisma.device.findFirst({
    where: { id, room: { house: { userId } } }
  })
}
```

Routes call these and throw `fastify.httpErrors.notFound()` on null — the client cannot distinguish "not found" from "not yours", which is correct.

---

## Data Flow

### Command flow: user issues a device command

```
POST /devices/:id/command  { state: { power: "on", temp: 22 } }
  │
  ├─ preHandler: fastify.authenticate  — verifies JWT, sets request.user
  │
  ├─ Route: validate body via TypeBox schema
  │
  ├─ Service: getDeviceById(id, request.user.id)
  │     └─ returns null → route throws 404
  │
  ├─ Service: validateStateForType(device.type, body.state)
  │     └─ throws validation error if enum/value invalid
  │
  ├─ Prisma transaction:
  │   ├─ UPDATE devices SET currentState = newState, updatedAt = now WHERE id = ?
  │   └─ INSERT INTO device_events (deviceId, source, state) VALUES (?, 'command', newState)
  │
  └─ Route: return { device: updatedDevice, event: newEvent }
```

**Why a transaction:** state update + event insert must be atomic. If the insert fails, the state must not have changed (and vice versa). A partial write would desync the log.

### Report flow: device/sensor pushes a reading

```
POST /devices/:id/report  { state: { temperatureCelsius: 22.4 } }
  │
  ├─ preHandler: fastify.authenticate  (same auth; simulated client sends JWT)
  │
  ├─ Route: validate body via TypeBox schema for "report" type
  │
  ├─ Service: getDeviceById(id, request.user.id)
  │
  ├─ Service: validateStateForType(device.type, body.state)
  │
  ├─ Prisma transaction:
  │   ├─ UPDATE devices SET currentState = newState, updatedAt = now WHERE id = ?
  │   └─ INSERT INTO device_events (deviceId, source, state) VALUES (?, 'report', newState)
  │
  └─ Route: return { device: updatedDevice, event: newEvent }
```

Command and report share the same underlying state-update+event-insert logic. The only difference is the `source` field on the event. This can be a single `updateDeviceState(deviceId, userId, newState, source)` service function.

### Read flow: query current state

```
GET /devices/:id
  │
  ├─ preHandler: fastify.authenticate
  ├─ Service: getDeviceById(id, request.user.id)
  └─ Route: return device (includes currentState)
```

No replay, no aggregation — `currentState` is always the latest value.

### Read flow: query event history

```
GET /events?deviceId=X&from=ISO&to=ISO&limit=50
  │
  ├─ preHandler: fastify.authenticate
  ├─ Route: validate query params (TypeBox)
  ├─ Service: queryEvents({ userId, deviceId?, roomId?, from?, to?, limit })
  │     └─ Prisma: SELECT * FROM device_events WHERE deviceId IN (owned devices) ORDER BY createdAt DESC LIMIT ?
  └─ Route: return { events: [...], total, cursor }
```

The events query must join back through the ownership chain to avoid cross-tenant data: only events whose device belongs to the requesting user's house.

---

## Patterns to Follow

### Pattern 1: Atomic state-update + event-insert via Prisma transaction

**What:** Wrap `device.update` and `deviceEvent.create` in `prisma.$transaction([...])`.

**When:** Every time `currentState` changes — commands and reports both.

**Example:**

```typescript
// src/services/device.ts
export async function updateDeviceState(
  deviceId: string,
  newState: string,       // JSON-serialized, pre-validated
  source: 'command' | 'report'
) {
  const [updatedDevice, newEvent] = await prisma.$transaction([
    prisma.device.update({
      where: { id: deviceId },
      data: { currentState: newState },
    }),
    prisma.deviceEvent.create({
      data: { deviceId, source, state: newState },
    }),
  ])
  return { device: updatedDevice, event: newEvent }
}
```

### Pattern 2: Per-device-type state validation in a single module

**What:** A `src/lib/device-state.ts` (or `src/services/device-state-validator.ts`) module holds TypeBox schemas keyed by device type. The service imports it and validates before calling `updateDeviceState`.

**When:** Any write to `currentState`.

**Example:**

```typescript
// src/lib/device-state.ts
import { Type, Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

const LightState = Type.Object({
  power: Type.Union([Type.Literal('on'), Type.Literal('off')]),
  brightness: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
})

const ACState = Type.Object({
  power: Type.Union([Type.Literal('on'), Type.Literal('off')]),
  temperatureCelsius: Type.Number({ minimum: 16, maximum: 30 }),
  mode: Type.Union([Type.Literal('cool'), Type.Literal('heat'), Type.Literal('fan')]),
})

const stateSchemas: Record<string, unknown> = {
  light: LightState,
  ac: ACState,
  // heater, sensor, etc.
}

export function validateStateForType(type: string, state: unknown): string {
  const schema = stateSchemas[type]
  if (!schema) throw new Error(`Unknown device type: ${type}`)
  if (!Value.Check(schema, state)) throw new Error(`Invalid state for device type: ${type}`)
  return JSON.stringify(state)
}
```

### Pattern 3: Ownership guard in every service function

**What:** Service functions always accept `userId` and include it in the Prisma `where` clause through the ownership chain.

**When:** Every read or write involving a House, Room, Device, or DeviceEvent.

**Example:** (shown in multi-tenant section above)

### Pattern 4: Events are AI-ready by default

**What:** Store the full state snapshot (not a delta) in each `DeviceEvent.state`. Include `source` to distinguish intent-vs-measurement. Keep `createdAt` indexed.

**When:** Designing the schema.

**Rationale:** When the AI milestone arrives, it can query `SELECT state, source, createdAt FROM device_events WHERE deviceId = ? ORDER BY createdAt` and get a complete, self-contained time series without joining or replaying. Delta encoding would save space but complicates AI consumption.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Updating currentState without inserting an event

**What:** Calling `prisma.device.update({ data: { currentState: x } })` without a corresponding `DeviceEvent` row.

**Why bad:** State and history go out of sync. The history log becomes unreliable; the AI consumer can't trust it. Silent data integrity hole.

**Instead:** Always use `updateDeviceState()` which wraps both operations in a transaction.

### Anti-Pattern 2: Deriving current state by replaying events

**What:** No `currentState` column; latest state computed by `SELECT state FROM device_events WHERE deviceId = ? ORDER BY createdAt DESC LIMIT 1`.

**Why bad:** Works at small scale, but N devices in a house = N sequential queries just to render the dashboard. Every "what is the current state of my house?" call is O(devices). The denormalized column makes it O(1).

**Instead:** Keep `currentState` on the device row, maintained atomically with each event.

### Anti-Pattern 3: Ownership check only in routes (not services)

**What:** Route does `if (device.userId !== request.user.id) throw 403` after a plain `prisma.device.findUnique({ where: { id } })`.

**Why bad:** If another route forgets the check, cross-tenant access is possible. Defense in depth requires ownership to be baked into the query, not bolted on after retrieval.

**Instead:** Services embed ownership into the `where` clause; routes never receive data that doesn't belong to the requesting user.

### Anti-Pattern 4: One giant `/devices` route file handling commands, reports, history, and CRUD

**What:** All device-related logic in one route file with dozens of handlers.

**Why bad:** Hard to navigate, test, and evolve. The existing codebase demonstrates separation: `src/routes/auth/index.ts` handles only auth routes.

**Instead:** Split into `src/routes/devices/index.ts` (CRUD + current state) and nested `src/routes/devices/[id]/command/index.ts` + `[id]/report/index.ts`, or handle command/report as sub-paths within the devices route file but keep the file focused.

### Anti-Pattern 5: Storing device type as an enum in the database

**What:** `type Enum @map("type") { LIGHT AC HEATER SENSOR }` in Prisma schema.

**Why bad:** Adding a new device type requires a DB migration. The project document explicitly prefers flexible storage + code-level validation.

**Instead:** `type String` in Prisma; enforce valid values in `src/lib/device-state.ts` via TypeBox. New types = new entry in the schema map, no migration.

---

## Suggested Build Order

Dependencies run shallow-to-deep. Each layer depends on the one above it.

```
1. Prisma schema (House, Room, Device, DeviceEvent models + indexes)
      ↓
2. House service + House routes  (establishes ownership anchor)
      ↓
3. Room service + Room routes  (depends on house ownership)
      ↓
4. Device CRUD service + Device CRUD routes  (depends on room → house chain)
      ↓
5. device-state validator module  (per-type TypeBox schemas)
      ↓
6. updateDeviceState service function (transaction: state update + event insert)
      ↓
7. Command route  POST /devices/:id/command
   Report route   POST /devices/:id/report
      ↓
8. Event query service + Event history routes  GET /events
      ↓
9. Integration tests per route group
```

**Rationale for this order:**
- Schema first: Prisma generates types that every service and route relies on for TypeScript correctness.
- House before Room before Device: referential integrity — you can't create a Room without a House model in place, and you can't create a Device without a Room.
- Validator module before command/report routes: the routes cannot validate state values without it; putting it before step 7 ensures it's never bypassed.
- Event query last: events are produced by command/report flows; nothing to query until those flows exist. Also lets you verify the event log is correct before building the query surface.

---

## Scalability Considerations

| Concern | At 100 users | At 10K users | At 1M users |
|---------|--------------|--------------|-------------|
| Current state reads | Direct `device.currentState` column; trivial | Same — denormalized, no aggregation | Add Redis cache in front of MariaDB if read throughput demands it |
| Event log growth | Negligible | Add composite index `(deviceId, createdAt)` — already recommended | Partition `device_events` by `createdAt` month; cold-tier archival |
| Multi-tenancy isolation | WHERE clause filtering — sufficient | Same; consider connection pool tuning | Row-level security or schema-per-tenant only at extreme scale |
| Command throughput | Synchronous request-response is fine | Same | At very high command rates, decouple via a queue (MQTT → worker → DB); not needed for v1 |

For v1 (API-only, simulated clients, no hardware), synchronous request-response is the correct and simplest choice. The architecture does not block later introduction of a message queue.

---

## Integration with Existing App

The new code extends the existing boot path without modifying it:

- **No changes to `app.ts`** — AutoLoad discovers new directories under `src/routes/` and `src/plugins/` automatically.
- **No changes to existing plugins** — `fastify.authenticate` is reused on all new protected routes with no modification.
- **No changes to `src/services/auth.ts`, `user.ts`, or `refresh-token.ts`** — auth is a separate concern.
- **Prisma schema additions only** — new models added to `prisma/schema.prisma`; existing `User` model gains a `houses House[]` relation field; one new migration via `npx prisma migrate dev`.
- **`src/lib/device-state.ts`** is a new file in the existing `src/lib/` infrastructure layer, consistent with `src/lib/env.ts` and `src/lib/prisma.ts`.

The only cross-cutting change to existing code is adding `houses House[]` to the `User` model in `schema.prisma`, which is a backward-compatible addition.

---

## Sources

- Existing codebase analysis: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md` (HIGH confidence — ground truth)
- PROJECT.md requirements: `.planning/PROJECT.md` (HIGH confidence — authoritative requirements)
- IoT/smart-home backend patterns: established CQRS + denormalized-state literature, Prisma transaction documentation, Fastify AutoLoad conventions (HIGH confidence — well-established patterns corroborated by codebase structure)
- TypeBox discriminated-union validation pattern: consistent with CLAUDE.md rule 1.5 (HIGH confidence)
