# Phase 2: Entity CRUD & Multi-Tenancy - Pattern Map

**Mapped:** 2026-07-09
**Files analyzed:** 17 (new) + 2 (modified)
**Analogs found:** 17 / 17

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/routes/houses/index.ts` | route | CRUD/request-response | `src/routes/auth/index.ts` | role-match |
| `src/routes/houses/schemas.ts` | config (validation) | request-response | `src/routes/auth/schemas.ts` | role-match (pattern delta: TypeBox not `as const`) |
| `src/routes/rooms/index.ts` | route | CRUD/request-response | `src/routes/auth/index.ts` | role-match |
| `src/routes/rooms/schemas.ts` | config (validation) | request-response | `src/routes/auth/schemas.ts` | role-match (pattern delta) |
| `src/routes/devices/index.ts` | route | CRUD/request-response | `src/routes/auth/index.ts` | role-match |
| `src/routes/devices/schemas.ts` | config (validation) | request-response | `src/routes/auth/schemas.ts` | role-match (pattern delta) |
| `src/services/house.ts` | service | CRUD (+ transactional cascade) | `src/services/user.ts` + `src/services/refresh-token.ts` | role-match |
| `src/services/room.ts` | service | CRUD (+ transactional cascade) | `src/services/user.ts` + `src/services/refresh-token.ts` | role-match |
| `src/services/device.ts` | service | CRUD (+ transactional multi-step create) | `src/services/user.ts` (CRUD shape) + `src/lib/prisma.ts` (`modelConfig` Record pattern for `deviceStateConfig`) | role-match |
| `src/lib/nanoid.ts` | utility | transform | `src/lib/strings.ts` | exact (sibling helper module) |
| `src/lib/prisma.ts` (MODIFIED) | config/utility (Prisma client extension) | transform (query interception) | itself (extend existing `$extends()` call) | exact |
| `src/generated/prisma` regen (via `npm run prisma:generate`) | config | n/a | n/a | n/a (no code pattern, tooling step) |
| `src/test/helpers/fixtures.ts` | test (helper) | n/a | `src/test/helper.ts` (`build(t)`) — new file, no direct analog | role-match |
| `src/test/routes/houses.test.ts` | test | request-response | `src/test/routes/root.test.ts` | role-match |
| `src/test/routes/rooms.test.ts` | test | request-response | `src/test/routes/root.test.ts` | role-match |
| `src/test/routes/devices.test.ts` | test | request-response | `src/test/routes/root.test.ts` | role-match |
| `src/app.ts` / `src/server.ts` | plugin/bootstrap | n/a | unchanged (autoload already maps `src/routes/**`) | exact (no modification needed) |

## Pattern Assignments

### `src/routes/houses/index.ts`, `src/routes/rooms/index.ts`, `src/routes/devices/index.ts` (route, CRUD/request-response)

**Analog:** `src/routes/auth/index.ts` (lines 1-122)

**Imports pattern** (lines 1-6):
```typescript
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { Prisma } from '../../generated/prisma/client'
import { loginUser } from '../../services/auth'
import { createUser, getUserById } from '../../services/user'
import { REFRESH_TOKEN_EXPIRES_DAYS, verifyRefreshToken, revokeRefreshToken } from '../../services/refresh-token'
import { loginRouteSchema, meRouteSchema, registerRouteSchema, refreshRouteSchema, logoutRouteSchema } from './schemas'
```
**Delta for new routes:** swap `FastifyPluginAsync` for `FastifyPluginAsyncTypebox` (from `@fastify/type-provider-typebox`) — per RESEARCH.md Pattern 1, this is a drop-in swap, no other registration change needed. Import `Type`/`Static` from the same package instead of hand-rolled body types.

**Auth (preHandler) pattern** (line 69):
```typescript
fastify.get('/me', {
  preHandler: fastify.authenticate,
  schema: meRouteSchema
}, async (request, reply) => { ... })
```
Apply `preHandler: fastify.authenticate` to every new house/room/device route (all are ownership-sensitive — TEST-08).

**Core CRUD + Prisma P2002 error-mapping pattern** (lines 34-51):
```typescript
fastify.post<{ Body: RegisterBody }>('/register', {
  schema: registerRouteSchema
}, async (request, reply) => {
  let user
  try {
    user = await createUser(request.body)
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw fastify.httpErrors.conflict('Email already in use')
    }
    throw err
  }
  reply.send({ ... })
})
```
Reuse the `Prisma.PrismaClientKnownRequestError` + `P2002` → `fastify.httpErrors.conflict()` mapping if any new unique constraint is ever added (none currently exist on House/Room/Device per RESEARCH.md Pitfall 5 — no P2002 path is expected in practice, but the pattern should still be known).

**404-not-403 ownership pattern** (from RESEARCH.md, not literally in auth/index.ts — auth has no ownership check):
```typescript
const house = await getHouse(request.params.housePublicId, BigInt(request.user.id))
if (!house) throw fastify.httpErrors.notFound()
reply.send({ publicId: house.publicId, name: house.name, address: house.address })
```

**ANTI-PATTERN — do NOT copy:** lines 50, 65, 78, 107 all do `reply.send({ ..., user: { id: Number(user.id), ... } })` — this leaks the internal BigInt id (cast to Number). New routes must **never** include `id`/`Number(x.id)` in any response; only `publicId` (D-03). Always construct the response object explicitly field-by-field (never `reply.send(house)` raw spread).

---

### `src/routes/houses/schemas.ts`, `src/routes/rooms/schemas.ts`, `src/routes/devices/schemas.ts` (config, request-response)

**Analog (legacy shape to depart from):** `src/routes/auth/schemas.ts` (full file, 74 lines) — raw `as const` JSON Schema, e.g.:
```typescript
export const registerRouteSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 191 },
      password: { type: 'string', minLength: 6 },
      name: { type: 'string', maxLength: 191 }
    }
  },
  response: { 200: authResponseSchema }
} as const
```

**Delta — new files use TypeBox instead** (from RESEARCH.md Code Examples, empirically verified in this exact tsconfig):
```typescript
import { Type, Static } from '@fastify/type-provider-typebox'

export const CreateRoomSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 191 }),
  floor: Type.Optional(Type.Integer()),
  roomType: Type.Optional(Type.String({ maxLength: 191 }))
}, { additionalProperties: false })
export type CreateRoomBody = Static<typeof CreateRoomSchema>

// PATCH: Type.Partial(...) — no hand-rolled optional fields
export const PatchRoomSchema = Type.Partial(Type.Object({
  name: Type.String({ minLength: 1, maxLength: 191 }),
  floor: Type.Integer(),
  roomType: Type.String({ maxLength: 191 })
}), { additionalProperties: false })
```
Always set `{ additionalProperties: false }` on body schemas (mass-assignment defense-in-depth, RESEARCH.md Pitfall 4). Never include `id`/internal fields in response schemas — only `publicId` and safe metadata (mirrors the `userResponseSchema` shape in auth/schemas.ts but swap `id: number` for `publicId: string`).

---

### `src/services/house.ts`, `src/services/room.ts` (service, CRUD + transactional cascade)

**Analog:** `src/services/user.ts` (full file, lines 1-27) for plain CRUD shape; `src/services/refresh-token.ts` (lines 42-49, `revokeRefreshToken`) for the "resolve → mutate → return boolean/null" shape used by delete.

**Imports pattern** (user.ts lines 1-2):
```typescript
import { prisma } from '../lib/prisma'
```
(no bcrypt needed for house/room/device — that's auth-specific)

**Ownership-embedded query pattern** (from RESEARCH.md Architecture Patterns §2, this is the house/room-specific analog to `getUserById`):
```typescript
export async function getHouse(housePublicId: string, userId: bigint) {
  return prisma.house.findFirst({ where: { publicId: housePublicId, userId } })
  // readGuard extension auto-injects deletedAt:null — soft-deleted houses excluded for free
}
```

**Plain create pattern** (user.ts lines 10-19 — the shape to mirror minus bcrypt):
```typescript
export async function createUser(input: CreateUserInput) {
  const hashedPassword = await bcrypt.hash(input.password, 10)
  return prisma.user.create({
    data: { email: input.email, password: hashedPassword, name: input.name ?? null }
  })
}
```
For house/room: `prisma.house.create({ data: { userId, name, address: input.address ?? null } })` — `publicId` is minted by the new `$allModels.create` hook, never set manually (see `src/lib/prisma.ts` pattern below).

**Cascade soft-delete — SAFE transaction pattern** (RESEARCH.md Pitfall 1 + Code Examples, this is the load-bearing pattern for the whole phase):
```typescript
export async function deleteHouse(housePublicId: string, userId: bigint) {
  return prisma.$transaction(async (tx) => {
    const house = await tx.house.findFirst({ where: { publicId: housePublicId, userId }, select: { id: true } })
    if (!house) return null   // route → 404

    const now = new Date()
    await tx.device.updateMany({ where: { houseId: house.id }, data: { deletedAt: now } })
    await tx.room.updateMany({ where: { houseId: house.id }, data: { deletedAt: now } })
    await tx.house.updateMany({ where: { id: house.id }, data: { deletedAt: now } })
    return house
  })
}
```
**ANTI-PATTERN — do NOT copy:** `tx.device.deleteMany({...})` / `tx.room.deleteMany(...)` inside the transaction. The extension's `softDelete()` helper (see `src/lib/prisma.ts` below) reaches for a separately-captured `base` client reference to do the delete→update conversion, which does **not** participate in the active `tx` transaction (documented Prisma limitation, cited in RESEARCH.md Pitfall 1). Always call `updateMany({ data: { deletedAt: now } })` **directly** inside cascade transactions — never rely on the delete-interception hook when inside `$transaction`.

Room's cascade (1-level, no house.updateMany):
```typescript
export async function deleteRoom(roomPublicId: string, userId: bigint) {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findFirst({ where: { publicId: roomPublicId, userId }, select: { id: true } })
    if (!room) return null
    const now = new Date()
    await tx.device.updateMany({ where: { roomId: room.id }, data: { deletedAt: now } })
    await tx.room.updateMany({ where: { id: room.id }, data: { deletedAt: now } })
    return room
  })
}
```

---

### `src/services/device.ts` (service, CRUD + transactional multi-step create)

**Analog for CRUD shape:** `src/services/user.ts`. **Analog for the typed exhaustive-Record dispatch idiom:** `src/lib/prisma.ts` `modelConfig: Record<Prisma.ModelName, {...}>` (lines 8-21) — same "explicit over magic" idiom applies to `deviceStateConfig: Record<DeviceType, {...}>`.

**Eager per-type state row creation (STATE-01)** — the single most architecturally significant piece of this phase, fully worked in RESEARCH.md Code Examples (verbatim, not paraphrased):
```typescript
const deviceStateConfig: Record<DeviceType, {
  model: Extract<Prisma.ModelName, 'LightState' | 'AcState' | 'HeaterState' | 'SensorState'>
  createDefaults: (tx: Prisma.TransactionClient, deviceId: bigint) => Promise<{ id: bigint }>
}> = {
  light: { model: 'LightState', createDefaults: (tx, deviceId) => tx.lightState.create({ data: { deviceId }, select: { id: true } }) },
  ac:    { model: 'AcState',    createDefaults: (tx, deviceId) => tx.acState.create({ data: { deviceId, targetTemp: 22, mode: 'auto' }, select: { id: true } }) },
  heater:{ model: 'HeaterState',createDefaults: (tx, deviceId) => tx.heaterState.create({ data: { deviceId, targetTemp: 20 }, select: { id: true } }) },
  sensor:{ model: 'SensorState',createDefaults: (tx, deviceId) => tx.sensorState.create({ data: { deviceId, reading: 0, unit: '' }, select: { id: true } }) }
}

export async function createDevice(input: { roomPublicId: string; userId: bigint; name: string; deviceType: DeviceType; manufacturer?: string; model?: string }) {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findFirst({ where: { publicId: input.roomPublicId, userId: input.userId }, select: { id: true, houseId: true } })
    if (!room) return null // route → 404

    const device = await tx.device.create({
      data: { userId: input.userId, roomId: room.id, houseId: room.houseId, name: input.name, deviceType: input.deviceType, manufacturer: input.manufacturer ?? null, model: input.model ?? null }
    })

    const config = deviceStateConfig[input.deviceType]
    const state = await config.createDefaults(tx, device.id)

    return tx.device.update({ where: { id: device.id }, data: { stateType: config.model, stateId: state.id } })
  })
}
```
`create`/`update` are not intercepted by the delete-interception logic, so this transaction is unaffected by Pitfall 1 — safe to call `tx.device.create`/`tx.device.update` directly (contrast the cascade-delete anti-pattern above).

**List-by-house / list-by-room (D-02, bare array):** mirror `getUserById`'s single-`findUnique` simplicity but with `findMany({ where: { houseId, userId } })` / `findMany({ where: { roomId, userId } })` — no envelope, return the array as-is (route does `reply.send(devices.map(d => ({ publicId: d.publicId, ... })))`, never raw spread).

**Device delete (leaf case, no cascade needed):** unlike house/room, a single un-transactional call is safe here — this is the **only** place the delete-interception hook (`prisma.device.delete(...)`) may be used directly:
```typescript
export async function deleteDevice(devicePublicId: string, userId: bigint) {
  const device = await prisma.device.findFirst({ where: { publicId: devicePublicId, userId }, select: { id: true } })
  if (!device) return null
  await prisma.device.delete({ where: { id: device.id } }) // safe: leaf, no transaction, extension intercepts correctly
  return device
}
```

---

### `src/lib/nanoid.ts` (utility, transform)

**Analog:** `src/lib/strings.ts` (full file, lines 1-6) — sibling small-helper module pattern:
```typescript
// Lowercase the first character only (PascalCase → camelCase, e.g.
// "RefreshToken" → "refreshToken"). Not the same as toLowerCase(), which would
// flatten multi-word names ("refreshtoken").
export const lowerFirst = (s: string): string =>
  s.charAt(0).toLowerCase() + s.slice(1)
```
New file mirrors this shape exactly — single-purpose, documented, one named export:
```typescript
import { nanoid } from 'nanoid'

export const generatePublicId = (): string => nanoid() // default: 21 chars, matches @db.VarChar(21)
```

---

### `src/lib/prisma.ts` (MODIFIED — extend existing `$extends()` call)

**Analog:** itself. Do not create a parallel/second `$extends()` call — extend the one that exists (lines 8-21 `modelConfig`, lines 55-71 the `$extends` call).

**Current exhaustive Record** (lines 8-21):
```typescript
const modelConfig: Record<Prisma.ModelName, { softDelete: boolean }> = {
  User: { softDelete: true },
  House: { softDelete: true },
  Room: { softDelete: true },
  Device: { softDelete: true },
  RefreshToken: { softDelete: false },
  Command: { softDelete: false },
  CommandTarget: { softDelete: false },
  LightState: { softDelete: false },
  AcState: { softDelete: false },
  HeaterState: { softDelete: false },
  SensorState: { softDelete: false },
  Event: { softDelete: false }
}
```
**Change:** widen the value type to `{ softDelete: boolean; publicId: boolean }` and fill in every one of the 12 rows (TS will error on any missing row — RESEARCH.md Pitfall 3). House/Room/Device/Command → `publicId: true`; everything else → `publicId: false`.

**Current `$extends` block** (lines 55-71) — add one new `create` handler to the *existing* `$allModels` object, do not touch `delete`/`deleteMany`:
```typescript
export const prisma = base.$extends({
  query: {
    $allModels: {
      findUnique({ model, args, query }) { return query(readGuard(model, args)) },
      // ...unchanged...
      create({ model, args, query }) {
        if (!needsPublicId(model)) return query(args)
        const withData = { ...args, data: { ...(args as any).data, publicId: generatePublicId() } }
        return query(withData) // uses the continuation, not a captured client ref — tx-safe
      },
      delete({ model, args, query }) { return softDelete(model, args, query, false) },
      deleteMany({ model, args, query }) { return softDelete(model, args, query, true) }
    }
  }
})
```
This `create` hook fires identically for the top-level `prisma` client and any `tx` inside `$transaction` (unlike `softDelete()`, it never reaches for `base`) — safe to use inside `createDevice`'s transaction.

---

### `src/test/helpers/fixtures.ts`, `src/test/routes/{houses,rooms,devices}.test.ts` (test, request-response)

**Analog:** `src/test/helper.ts` (`build(t)`, full file) + `src/test/routes/root.test.ts` (full file, 13 lines) for the `app.inject()` convention:
```typescript
import { test } from 'node:test'
import assert from 'node:assert'
import { build } from '../helper'

test('default root route', async (t) => {
  const app = await build(t)
  const res = await app.inject({ url: '/' })
  assert.deepStrictEqual(JSON.parse(res.payload), { root: true })
})
```

**New pattern (no direct analog — first DB-touching tests in the repo):** per RESEARCH.md Pitfall 5/6, `fixtures.ts` should export helpers that register two distinct users (unique email per call, e.g. `crypto.randomUUID()` suffix) once per test file via `describe`/`before`, and return their access tokens for use in `app.inject({ headers: { authorization: \`Bearer ${token}\` } })` calls. House/Room/Device names need no uniqueness (no unique constraint besides nanoid `publicId`).

Standard per-route test shape to follow (extends the root.test.ts convention with auth + ownership):
```typescript
test('cross-tenant house access returns 404', async (t) => {
  const app = await build(t)
  const { userA, userB } = await createTwoTestUsers(app)
  const house = await createHouseAs(app, userA.token)
  const res = await app.inject({
    method: 'GET',
    url: `/houses/${house.publicId}`,
    headers: { authorization: `Bearer ${userB.token}` }
  })
  assert.strictEqual(res.statusCode, 404)
})
```

## Shared Patterns

### Ownership enforcement (never 403, always 404)
**Source:** RESEARCH.md Architecture Patterns Pattern 2 (no literal codebase precedent exists yet — auth routes have no ownership dimension); `src/lib/prisma.ts` `readGuard` supplies the free soft-delete exclusion half of this.
**Apply to:** every House/Room/Device GET/PATCH/DELETE route and every nested-create parent-ownership check.
```typescript
const house = await getHouse(request.params.housePublicId, BigInt(request.user.id))
if (!house) throw fastify.httpErrors.notFound()
```

### Authentication (preHandler)
**Source:** `src/routes/auth/index.ts` line 69, `/me` route.
**Apply to:** every new House/Room/Device route (all are protected — TEST-08).
```typescript
preHandler: fastify.authenticate
```

### Error normalization
**Source:** `src/plugins/error-handler.ts` (existing global `setErrorHandler`) — unchanged, no new code needed. `fastify.httpErrors.notFound()` / `.conflict()` from `@fastify/sensible`.
**Apply to:** all new routes; thrown `httpErrors.*` and TypeBox schema-validation `FastifyError`s both flow through the existing normalizer to `{ error, message, statusCode }`.

### BigInt-safe response construction
**Source:** anti-pattern called out directly in `src/routes/auth/index.ts` (lines 50/65/78/107 do `Number(user.id)` — do NOT copy) plus RESEARCH.md Anti-Patterns section.
**Apply to:** every new route handler's `reply.send(...)` — always construct the object explicitly with `publicId` and safe fields, never spread a raw Prisma row, never include `id`.

### Cascade soft-delete via direct `updateMany` inside `$transaction`
**Source:** RESEARCH.md Pitfall 1 (grounded in `src/lib/prisma.ts`'s existing `softDelete()`/`base` mechanism, which is the thing being *avoided* inside transactions).
**Apply to:** `deleteHouse`, `deleteRoom` in `src/services/house.ts` / `room.ts`. Does not apply to `deleteDevice` (leaf, no cascade, safe to use the extension's `delete` hook directly).

### `modelConfig`-style exhaustive `Record<Union, ...>` dispatch
**Source:** `src/lib/prisma.ts` lines 8-21 (`modelConfig`).
**Apply to:** `src/lib/prisma.ts`'s own extension (`publicId` field added to the same Record) and `src/services/device.ts`'s new `deviceStateConfig: Record<DeviceType, {...}>`.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/test/helpers/fixtures.ts` | test helper | n/a | First DB-writing test fixtures in the repo (`root.test.ts` makes no DB calls); pattern is newly established per RESEARCH.md Pitfall 5/6, not copied from an existing file — use the concrete shape given above |

## Metadata

**Analog search scope:** `src/routes/`, `src/services/`, `src/lib/`, `src/test/` (entire existing `src/` tree — small codebase, exhaustively covered)
**Files scanned:** `src/routes/auth/index.ts`, `src/routes/auth/schemas.ts`, `src/services/user.ts`, `src/services/auth.ts`, `src/services/refresh-token.ts`, `src/lib/prisma.ts`, `src/lib/strings.ts`, `src/test/helper.ts`, `src/test/routes/root.test.ts`
**Pattern extraction date:** 2026-07-09
