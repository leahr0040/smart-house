# Phase 2: Entity CRUD & Multi-Tenancy - Research

**Researched:** 2026-07-09
**Domain:** Fastify 5 REST CRUD over Prisma/MariaDB, multi-tenant ownership enforcement, TypeBox validation, Prisma client extensions + interactive transactions
**Confidence:** HIGH (stack/tooling — empirically verified in a project-identical harness); MEDIUM (Prisma extension/transaction composability — strong documented + circumstantial evidence, not executed against a live DB in this session)

## Summary

Phase 2 is straightforward REST CRUD *except* for one genuinely hard technical seam: the Phase 1 `$extends()`-based soft-delete client in `src/lib/prisma.ts` converts `delete`/`deleteMany` into `update`/`updateMany` by reaching for a **separately captured, un-extended client reference (`base`)** instead of using the extension's `query()` continuation. Documented Prisma behavior (and multiple maintainer-acknowledged community reports) says extension code that reaches for a different client reference **does not participate in the active `$transaction()`** — it either runs outside the transaction or hangs waiting for a connection. This directly threatens D-07's "cascade soft-delete in one transaction" requirement. The fix is simple and low-risk: inside any `$transaction(async (tx) => {...})` cascade, call `tx.<model>.updateMany({ data: { deletedAt: new Date() } })` **directly** — never `tx.<model>.delete()`/`deleteMany()` — bypassing the extension's delete-interception entirely for cascade paths. This is flagged as **Pitfall 1** and is the single most important finding in this document.

The second major finding: this project's `tsconfig.json` compiles to CommonJS, and **both** candidate new dependencies — the new unscoped `typebox` (1.x, the official successor to `@sinclair/typebox`) and `nanoid` (5.x) — are **pure ESM, no CJS entry point at all**. This was empirically verified to still work end-to-end (compile + runtime) in this exact project's tsconfig, on the machine's installed Node v24.18.0, because Node's `require(esm)` feature (stable since Node 20.19.0 / 22.12.0) transparently loads them from compiled CommonJS `require()` calls. No `engines` field currently pins a Node floor in `package.json` — this phase should add one.

Everything else — TypeBox route typing (`FastifyPluginAsyncTypebox`, drop-in for `FastifyPluginAsync`), the NanoID `public_id` seam (extend the *existing* `modelConfig`/`$allModels` pattern in `prisma.ts`, not a new file), the eager per-type state-row creation (a 3-step sequence inside one interactive transaction), field validation defaults, and BigInt-safe response construction — was verified directly against this codebase and, where external facts were needed, against official docs/registry data.

**Primary recommendation:** `npm install typebox @fastify/type-provider-typebox nanoid`, add `"engines": {"node": ">=22.12.0"}` to `package.json`, extend the *existing* `$extends()` call in `src/lib/prisma.ts` (don't create a parallel extension), and for every cascade soft-delete inside `$transaction`, call `updateMany` directly rather than relying on the delete-interception hook.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Phase Boundary:** Deliver full REST CRUD for the House → Room → Device hierarchy with multi-tenancy enforced on every route, and eager per-type state-detail-row creation at device creation. Scope: HOUSE-01…05, ROOM-01…04, DEV-01…05, STATE-01, TEST-01/05/08. Not in scope (later phases): commands, state reads (STATE-02…04), event history, RabbitMQ. This is the first phase with runtime application logic — full **structure-first → tests-red → implement** sequence (not the Phase 1 compile/migration smoke-check exception).

- **D-01 (shallow nesting):** Create and list under the parent; act on an item by its own id. Houses: `POST /houses`, `GET /houses`, `GET/PATCH/DELETE /houses/:housePublicId`. Rooms: `POST /houses/:housePublicId/rooms`, `GET /houses/:housePublicId/rooms`, `GET/PATCH/DELETE /rooms/:roomPublicId`. Devices: `POST /rooms/:roomPublicId/devices`, plus two list views — `GET /rooms/:roomPublicId/devices` and `GET /houses/:housePublicId/devices` — and `GET/PATCH/DELETE /devices/:devicePublicId`. Not fully nested (no `/houses/:h/rooms/:r/devices/:d`) — ownership is enforced by `user_id`.
- **D-02 (list response = bare array, no pagination):** List endpoints return items directly (`[ ...items ]`) — no envelope, no pagination.
- **D-03 (public_id everywhere):** Route paths and JSON responses use the NanoID `public_id`; the internal `BigInt` id is never exposed. Services resolve `{ publicId, userId }` → internal row. Nested creation/list paths carry the parent's `public_id`.
- **D-04 (PATCH, partial):** Updates are `PATCH` with only the fields to change; omitted fields are untouched.
- **D-05 (no re-parenting in v1):** `house_id`/`room_id` fixed at creation. Update touches metadata only.
- **D-06 (device_type immutable):** `device_type` cannot change after creation. PATCH on a device rejects any `device_type` change.
- **D-07 (cascade soft-delete):** Deleting a house soft-deletes all its rooms **and** devices; deleting a room soft-deletes its devices — in **one transaction**. Device carries a denormalized `house_id` (added to schema in Phase 2, folded into the still-unpushed migration), so house→device cascade is a direct `device.deleteMany({where:{houseId}})` — no join through room ids. Per-type state rows are internal-only (not soft-deletable) — they simply remain; the device row is the access gate.

### Claude's Discretion
- **NanoID `public_id` generation seam** — a Prisma client `create`-extension vs. minting in each `createX` service. Add the `nanoid` dependency (not currently installed). Confirm 21-char length fits `@db.VarChar(21)`.
- **TypeBox introduction** — mandated validation standard (CLAUDE.md/PLAN.md rule 1.5) but not yet a dependency (`zod` is the only validator installed today). Adds `@sinclair/typebox` + the Fastify TypeBox type-provider, writes all new schemas with it (`Static<typeof schema>`). Do not migrate the legacy auth `as const` schemas unless touched.
- **Field validation limits** — name lengths, `floor` range, `brightness` 0–100, `target_temp` bounds, `ac_states.mode` vocabulary, sensor `unit` — all live in the TypeBox app layer (no DB constraints, per Phase 1 D-01…D-06). Pick sensible defaults.
- **Eager state-row defaults** — Phase 1 schema defaults (`is_on=false`, `brightness=0`, etc.; `ac_states.mode` and `sensor_states.reading`/`unit` have no schema default) need concrete creation-time values; choose sane ones.
- **BigInt serialization strategy** — since responses expose only `public_id`, internal BigInt ids should never reach the serializer; confirm no BigInt leaks into any response schema.

### Deferred Ideas (OUT OF SCOPE)
- **Setting initial device state at creation** (e.g. create a light already on) — v1 creates the eager state row with defaults only (STATE-01); client-supplied initial state is out of scope.
- **Re-parenting** (move room → house, device → room) — deferred; v1 has fixed parents, move = delete + recreate (D-05).
- **Filtering/search on list endpoints** (by device_type, name, etc.) — not in Phase 2 scope; add per real need.
- **Migrating the legacy auth schemas to TypeBox** — only when those routes are next touched (per CLAUDE.md rule).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| HOUSE-01 | User can create a house | Code Examples §Ownership-scoped create; Standard Stack (TypeBox body schema); NanoID seam (Pitfall/Architecture) |
| HOUSE-02 | User can list and view their own houses | Architecture Patterns §Read pattern (`readGuard` free soft-delete exclusion); D-02 bare-array list |
| HOUSE-03 | User can update a house they own | Code Examples §PATCH partial update (`Type.Partial`) |
| HOUSE-04 | User can delete a house they own (soft delete) | **Pitfall 1** (cascade transaction safety) + Code Examples §Cascade delete |
| HOUSE-05 | A user can only access houses they own (404 not 403) | Architecture Patterns §Ownership-embedded query; Security Domain §Access Control |
| ROOM-01 | User can create a room in a house they own | Code Examples §Parent-ownership verification before nested create |
| ROOM-02 | User can list rooms in a house they own | Same read pattern as HOUSE-02, scoped by `houseId` |
| ROOM-03 | User can update a room they own | Same PATCH pattern as HOUSE-03 |
| ROOM-04 | User can delete a room they own (soft delete) | Pitfall 1 + Code Examples §Cascade delete (room→devices, 1-level) |
| DEV-01 | User can add a device of a known type to a room | Code Examples §Eager state-row creation (3-step transaction); Standard Stack (TypeBox union-of-literals for device_type) |
| DEV-02 | User can list and view devices by room and by house | Architecture Patterns (denormalized `houseId` — no join through rooms) |
| DEV-03 | User can update device metadata | Same PATCH pattern, device_type excluded (D-06) |
| DEV-04 | User can remove a device (soft delete) | Leaf case — safe to use the existing single-call extension conversion (no transaction needed, no children) |
| DEV-05 | Per-device-type current state, TypeBox-validated, no JSON | Code Examples §Device-type validation (empirically verified 400 response) |
| STATE-01 | Eager per-type state row created at device creation | Code Examples §Eager state-row creation (full worked transaction) |
| TEST-01 | Second-user 404 fixture for every ownership-sensitive route | Validation Architecture §Test Map; Common Pitfalls §Test fixture uniqueness/performance |
| TEST-05 | Soft-delete exclusion on all reads; soft-deleted user cannot authenticate | Validation Architecture; Common Pitfalls (existing `loginUser`/`readGuard` already correct — only a test is missing) |
| TEST-08 | 401 without valid JWT on every new endpoint | Validation Architecture; reuses existing `fastify.authenticate` preHandler, no new code |
</phase_requirements>

## Architectural Responsibility Map

This project is an API-only backend (no browser/CDN/frontend-server tier exists — see PROJECT.md "Web UI/dashboard: Out of Scope"). All Phase 2 capabilities collapse into two tiers:

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| House/Room/Device REST endpoints | API/Backend | — | Fastify route handlers + service layer; no other tier exists in this project |
| Ownership/multi-tenancy enforcement | API/Backend | Database/Storage | `relationMode="prisma"` means MariaDB has no FK constraints or RLS — the app layer (`where: {publicId, userId}`) is the *sole* enforcement point; DB just stores rows |
| Request validation (TypeBox) | API/Backend | — | Validated at the Fastify route boundary before any service/DB call |
| Eager per-type state row creation | API/Backend | Database/Storage | Orchestrated by the service layer inside one Prisma `$transaction`; persisted rows live in MariaDB |
| Soft-delete cascade | API/Backend | Database/Storage | Explicit application-level cascade — `relationMode="prisma"` has no `ON DELETE CASCADE`; DB is a passive store |
| `public_id` generation | API/Backend | — | A Prisma client extension (app-level middleware around the DB call), not a DB-native feature like autoincrement |

## Project Constraints (from CLAUDE.md)

- **Never go straight to implementation** — bug/feature work requires an explained plan and approval first (enforced by the discuss/plan gates upstream of this research).
- **Structure-first → tests-red → implement**, one commit per stage minimum: Scaffold (`// TODO:` bodies) → Tests (compile + run red) → Implement (task-by-task to green). ROADMAP.md's Phase 2 notes already encode this; the planner must sequence Waves/tasks around it, not collapse it.
- **Explicit over magic:** typed `Record<Union, …>` config over runtime field-detection; one handler per case over `$allOperations`-style catch-all. Directly resolved below for the NanoID seam (extend `modelConfig: Record<Prisma.ModelName, {...}>`) and the device-state seam (`deviceStateConfig: Record<DeviceType, {...}>`). Neither uses `$allOperations` — both use `query.$allModels.<specificOperation>`, which is the same mechanism the existing `readGuard`/`softDelete` hooks already use and is explicitly **not** the forbidden catch-all (see Pitfall 3).
- **Readable conditions & names:** no single-use variables just to name a boolean; inline into early-return guards.
- **Separate concerns:** generic reusable helpers belong in their own `src/lib/` module. CONTEXT.md explicitly flags the NanoID generator as "a candidate for a sibling `src/lib/` module" next to `src/lib/strings.ts` — see Recommended Project Structure.
- **Validation standard: TypeBox** (PLAN.md rule 1.5) — `Static<typeof schema>` derives handler types; never hand-write a parallel type alias; co-locate schemas in `routes/<area>/schemas.ts`. Do not migrate the legacy auth `as const` schemas.
- **Migrations — amend, don't stack, until pushed.** The Phase 1 migration (`20260707094526_add_domain_schema`) is still local/unpushed. If any Phase 2 field-validation decision turns out to need a schema change (unlikely — Phase 1 is schema-complete for this phase's scope), amend that migration in place rather than creating a new one.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `typebox` | 1.3.6 `[VERIFIED: npm registry]` | Request/response schema validation + static type inference | Official successor generation to `@sinclair/typebox`; the required peer of `@fastify/type-provider-typebox` 6.x; satisfies CLAUDE.md/PLAN.md rule 1.5 |
| `@fastify/type-provider-typebox` | 6.1.0 `[VERIFIED: npm registry]` | Fastify type-provider integration for TypeBox; re-exports `Type`, `Static`, `TypeBoxTypeProvider`, `FastifyPluginAsyncTypebox` | Official `fastify` GitHub-org package; plugin version `>=5.x` is documented-compatible with Fastify `^5.x` (project runs 5.10.0) `[CITED: npm readme]` |
| `nanoid` | 5.1.16 `[VERIFIED: npm registry]` | Generates the `public_id` external identifier | CSPRNG-backed (`crypto.getRandomValues`), URL-safe 64-symbol alphabet, **default `nanoid()` output is exactly 21 characters** `[VERIFIED: empirical test — see below]`, matching `@db.VarChar(21)` exactly |

**Package name provenance:** all three names were discovered via direct `npm view` registry inspection (not WebSearch/training-data guessing) and independently confirmed by fetching each package's own README via `npm view <pkg> readme`. Combined with the Package Legitimacy Audit below, these are tagged `[VERIFIED: npm registry]`.

### Supporting
No new supporting libraries are needed. Existing `fastify`, `@prisma/client`/`prisma` (7.8.0), `@prisma/adapter-mariadb` (7.8.0), `@fastify/sensible`, `@fastify/jwt` are reused unchanged.

### Alternatives Considered

| Instead of | Could use | Tradeoff |
|------------|-----------|----------|
| `typebox` (unscoped, 1.x "Latest") | `@sinclair/typebox` (0.x, explicitly labeled "LTS") + `@fastify/type-provider-typebox@5.x` (peer range `>=0.26 <=0.34`) `[VERIFIED: npm registry — probed 4.1.0/5.0.0/5.1.0/5.2.0 peerDependencies]` | Avoids the ESM-only dependency entirely (0.x supports both ESM and CJS `[CITED: typebox npm readme "Versions" table]`) — zero Node-version risk. Loses TypeBox 1.x's JSON Schema 2020-12 coverage and faster JIT compiler. Also more literally matches CLAUDE.md's exact wording (`Static<typeof schema>` as a *named* import) since 1.x's own README primarily documents `Type.Static<typeof schema>` (namespace-member access) rather than a bare `Static` export, though `@fastify/type-provider-typebox` does re-export a named `Static` for either version. **This is the fallback if the team wants zero ESM/Node-version risk; this document's primary recommendation (1.x) was empirically verified to work and is not blocked — see Pitfall 2.** |
| `nanoid` | `crypto.randomUUID()` (built into Node, zero dependencies) | UUID v4 is 36 characters (with hyphens) vs. NanoID's 21 — the schema's `@db.VarChar(21)` column was sized specifically for NanoID's default output (Phase 1 D-11). Switching now would require a schema/migration change. Not recommended. |
| Prisma `$allModels.create` hook for `public_id` minting | Mint `nanoid()` inline in each `createX` service function, no extension | Fully explicit, zero "magic" — but duplicates `publicId: nanoid()` across House/Room/Device (and Command in Phase 4) and doesn't automatically cover future public_id-bearing models the way the config-driven extension does. **Recommended: use the extension** — it mirrors the *already-established* `modelConfig`/`softDelete` pattern in this exact file, so it is the lower-surprise choice for anyone reading `prisma.ts`, not a new "magic" mechanism. |

**Installation:**
```bash
npm install typebox @fastify/type-provider-typebox nanoid
```

**Version verification:** confirmed via `npm view <pkg> version` against the live npm registry on the research date; `typebox` was published 2026-07-08 (one day before this research), `nanoid` 5.1.16 on 2026-06-24, `@fastify/type-provider-typebox` 6.1.0 on 2025-10-19. All three resolve cleanly; none are deprecated (`npm view <pkg> deprecated` → empty/false for all three, confirmed via the package-legitimacy seam).

## Package Legitimacy Audit

Ran `gsd-tools query package-legitimacy check --ecosystem npm nanoid typebox @fastify/type-provider-typebox`.

| Package | Registry | Age (latest release) | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `nanoid` | npm | latest patch published 2026-06-24 (~2 weeks old); package itself is a long-standing, foundational library | 228,633,869/week | `github.com/ai/nanoid` | `[SUS]` (reason: "too-new" — flags the latest *version's* publish date, not package age) | **Approved** — see override rationale below |
| `typebox` | npm | latest published 2026-07-08 (1 day old); package is the officially-announced successor line to `@sinclair/typebox` | 4,268,108/week | `github.com/sinclairzx81/typebox` | `[SUS]` (reason: "too-new") | **Approved** — see override rationale below |
| `@fastify/type-provider-typebox` | npm | published 2025-10-19 | 292,536/week | `github.com/fastify/fastify-type-provider-typebox` | `[OK]` | Approved |

**Override rationale for the two `[SUS]` verdicts:** the automated "too-new" signal measures the *latest version's* publish timestamp, not the package's overall history, and both these packages ship frequent releases. Cross-checked independently:
- `nanoid`: 228M weekly downloads (one of the most-downloaded packages on npm), maintainer `ai` (Andrey Sitnik, well-known OSS maintainer of PostCSS/Autoprefixer), no postinstall script (`npm view nanoid scripts.postinstall` → empty) `[VERIFIED: npm registry]`.
- `typebox`: same maintainer account (`sinclair <haydn.developer@gmail.com>`) as `@sinclair/typebox`, confirmed via `npm view @sinclair/typebox maintainers` and `npm view typebox maintainers` returning identical output `[VERIFIED: npm registry]`. The official `typebox` README explicitly documents this as a deliberate two-line succession (1.x "Latest" vs. 0.x "LTS", the latter forked to `github.com/sinclairzx81/sinclair-typebox` for continued maintenance) `[CITED: npm readme]`. No postinstall script.

Both are kept with **no** `checkpoint:human-verify` requirement given the strength of this cross-check (same-maintainer confirmation is a stronger signal than the automated heuristic can express) — but the planner should still note in the scaffold task that these two packages were flagged `[SUS]` by the automated check and manually cleared in this research, in case a stricter project policy wants a second look.

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `nanoid`, `typebox` — both manually cleared above with concrete evidence (see rationale).

## Architecture Patterns

### System Architecture Diagram

```
                    ┌───────────────────────────────────────┐
                    │              HTTP Client                │
                    └────────────────────┬────────────────────┘
                                          │ POST/GET/PATCH/DELETE
                                          ▼
                    ┌───────────────────────────────────────┐
                    │ Fastify route (src/routes/houses|rooms/  │
                    │ devices/index.ts)                        │
                    │  1. TypeBox schema validates body/params  │──▶ 400 (bad shape, unknown device_type)
                    │  2. preHandler: fastify.authenticate       │──▶ 401 (missing/invalid JWT)
                    └────────────────────┬────────────────────┘
                                          │ typed, authenticated request
                                          ▼
                    ┌───────────────────────────────────────┐
                    │ Service layer (src/services/house.ts|      │
                    │ room.ts|device.ts) — pure functions          │
                    │  - resolves parent ownership                │──▶ null → route throws 404
                    │    ({publicId, userId} lookup)               │    (never 403 — HOUSE-05)
                    │  - builds ownership-embedded queries          │
                    └────────────────────┬────────────────────┘
                                          │ prisma.*  /  prisma.$transaction(tx => ...)
                                          ▼
                    ┌───────────────────────────────────────┐
                    │ Extended Prisma client (src/lib/prisma.ts) │
                    │ query.$allModels hooks:                     │
                    │  - readGuard: injects deletedAt:null         │  (find*, count, aggregate, groupBy)
                    │  - create: mints publicId via nanoid()        │  (NEW this phase)
                    │  - delete/deleteMany → soft-delete update      │  (SAFE only OUTSIDE $transaction —
                    │                                                 see Pitfall 1)
                    └────────────────────┬────────────────────┘
                                          ▼
                    ┌───────────────────────────────────────┐
                    │        @prisma/adapter-mariadb           │
                    └────────────────────┬────────────────────┘
                                          ▼
                                 MariaDB (smart_house)
                         houses / rooms / devices / light_states /
                        ac_states / heater_states / sensor_states
```

### Recommended Project Structure
```
src/
├── lib/
│   ├── nanoid.ts            # NEW — thin wrapper: export const generatePublicId = () => nanoid()
│   │                         #   (sibling to strings.ts, per CONTEXT.md's own hint)
│   └── prisma.ts            # EXTENDED — modelConfig gains `publicId: boolean`;
│                              #   one new `create` handler added to the EXISTING query.$allModels object
├── services/
│   ├── house.ts              # NEW — createHouse, listHouses, getHouse, updateHouse, deleteHouse (cascade)
│   ├── room.ts                # NEW — createRoom (parent-ownership check), listRooms, updateRoom, deleteRoom (cascade)
│   └── device.ts              # NEW — createDevice (eager state-row transaction), listByRoom, listByHouse,
│                                #   getDevice, updateDevice, deleteDevice (leaf, no cascade);
│                                #   deviceStateConfig: Record<DeviceType, {...}> lives here or a sibling
│                                #   device-state.ts if device.ts gets unwieldy
├── routes/
│   ├── houses/
│   │   ├── index.ts           # POST /houses, GET /houses, GET|PATCH|DELETE /houses/:housePublicId
│   │   └── schemas.ts          # TypeBox schemas (Type.Object, Type.Partial for PATCH)
│   ├── rooms/
│   │   ├── index.ts           # POST /houses/:housePublicId/rooms, GET .../rooms,
│   │   │                       #   GET|PATCH|DELETE /rooms/:roomPublicId
│   │   └── schemas.ts
│   └── devices/
│       ├── index.ts           # POST /rooms/:roomPublicId/devices,
│       │                       #   GET /rooms/:roomPublicId/devices, GET /houses/:housePublicId/devices,
│       │                       #   GET|PATCH|DELETE /devices/:devicePublicId
│       └── schemas.ts
└── test/
    ├── helpers/
    │   └── fixtures.ts         # NEW — createTestUser()/createTwoTestUsers() shared across all 3 test files
    └── routes/
        ├── houses.test.ts
        ├── rooms.test.ts
        └── devices.test.ts
```

### Pattern 1: Route plugin typing (`FastifyPluginAsyncTypebox`)
**What:** New route files type their exported plugin as `FastifyPluginAsyncTypebox` instead of `FastifyPluginAsync`. This is a drop-in swap — everything else about the AutoLoad-based plugin registration is unchanged.
**When to use:** Every new Phase 2 route file. Do **not** touch the existing `src/routes/auth/index.ts` (still `FastifyPluginAsync` + raw JSON Schema, per CLAUDE.md's "don't migrate unless touched" rule).
**Why this works with `@fastify/autoload`:** per the official README: *"When using plugin types, `withTypeProvider` is not required in order to register the plugin."* `withTypeProvider<TypeBoxTypeProvider>()` is purely a TypeScript-generic annotation with no runtime effect — it does not need to be called on the root Fastify instance in `src/server.ts`/`src/test/helper.ts` for individual AutoLoad-registered route files to get correctly-typed `request.body`/`request.params`. `[CITED: @fastify/type-provider-typebox npm readme]`, cross-checked `[VERIFIED: empirical compile+run test]` below.
**Example (empirically verified — compiles with `tsc` and runs cleanly under this project's exact tsconfig):**
```typescript
// src/routes/rooms/index.ts
import { Type, Static, FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

const CreateRoomSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 191 }),
  floor: Type.Optional(Type.Integer()),
  roomType: Type.Optional(Type.String({ maxLength: 191 }))
}, { additionalProperties: false })
type CreateRoomBody = Static<typeof CreateRoomSchema>

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post('/houses/:housePublicId/rooms', {
    preHandler: fastify.authenticate,
    schema: { body: CreateRoomSchema }
  }, async (request, reply) => {
    const body: CreateRoomBody = request.body // fully typed, no separate hand-written type
    // ...
  })
}
export default plugin
```

### Pattern 2: Ownership-embedded query (never 403, always 404)
**What:** every read/update/delete resolves `{ publicId, userId }` in a single `where` clause; a miss (wrong owner OR wrong id OR soft-deleted) returns `null` from the service, and the route throws `fastify.httpErrors.notFound()`.
**When to use:** every ownership-sensitive route (HOUSE-05, and implicitly ROOM/DEV).
**Example:**
```typescript
// src/services/house.ts
export async function getHouse(housePublicId: string, userId: bigint) {
  return prisma.house.findFirst({ where: { publicId: housePublicId, userId } })
  // readGuard extension auto-injects deletedAt:null — soft-deleted houses are excluded for free
}
```
```typescript
// src/routes/houses/index.ts
const house = await getHouse(request.params.housePublicId, BigInt(request.user.id))
if (!house) throw fastify.httpErrors.notFound()
reply.send({ publicId: house.publicId, name: house.name, address: house.address, ... })
// NOTE: never `reply.send(house)` — that would leak the internal BigInt id. Always construct
// the response object explicitly (see BigInt Serialization pitfall below).
```

### Anti-Patterns to Avoid
- **Spreading the raw Prisma row into a response** (`reply.send(house)` or `{...house}`): leaks the internal BigInt `id` and will crash `JSON.stringify` on serialization, or worse, silently succeed if the response schema doesn't declare `id` (fast-json-stringify drops undeclared properties) — either way, never do this. Always construct the response object field-by-field, mirroring the (already-correct, in this respect) pattern in `src/routes/auth/index.ts`.
- **`$allOperations`-style catch-all extensions:** not used anywhere in this plan. Both new extension points (NanoID create-hook, and the existing soft-delete hooks) use `query.$allModels.<specificOperationName>` — model-generic but operation-specific, which is explicitly *not* the `$allOperations` catch-all CLAUDE.md forbids.
- **Relying on `tx.model.delete()`/`deleteMany()` inside a `$transaction` callback for cascade soft-deletes** — see Pitfall 1. Use direct `updateMany({data: {deletedAt: new Date()}})` instead.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Non-enumerable external IDs | Custom `crypto.randomBytes` + alphabet mapping | `nanoid()` | CSPRNG-backed, URL-safe, exactly 21 chars by default (matches the schema column), battle-tested (228M weekly downloads) |
| Request/response validation | Hand-written `as const` JSON Schema + a parallel hand-typed `type X = {...}` (the pattern the *legacy* auth routes use) | TypeBox `Type.Object(...)` + `Static<typeof schema>` | Single source of truth for both runtime validation and compile-time types; mandated by CLAUDE.md rule 1.5 |
| BigInt-safe JSON responses | A custom `JSON.stringify` replacer or `BigInt.prototype.toJSON` monkey-patch | Never `select`/return BigInt columns in response schemas; construct response objects explicitly with only `publicId` and other safe fields | A global prototype patch is invisible/surprising; simply never touching BigInt in the response path is both simpler and safer — and is D-03's whole point |
| Cascading delete logic | Ad-hoc, differently-shaped `updateMany` calls duplicated per route | One typed cascade pattern reused across `deleteHouse`/`deleteRoom` (see Code Examples) | Consistency; a single reviewed pattern is easier to get right than three similar-but-slightly-different ones |
| Device-type → state-table dispatch | `if/else` or `switch` chains scattered across services | `deviceStateConfig: Record<DeviceType, {...}>` (exhaustive by construction — TS errors if a device type is missing a handler) | Matches the existing `modelConfig` idiom already in `prisma.ts`; "explicit over magic" per CLAUDE.md |

**Key insight:** every "don't hand-roll" item in this phase already has an established idiom *somewhere in this exact codebase* (`modelConfig`, `readGuard`, the auth routes' explicit response construction). The lowest-risk implementation choice is almost always "extend the existing pattern," not "introduce a new one."

## Common Pitfalls

### Pitfall 1: Prisma's delete→update soft-delete conversion likely escapes `$transaction` context (HIGH severity)
**What goes wrong:** `src/lib/prisma.ts`'s `softDelete()` helper converts `delete`/`deleteMany` calls into `update`/`updateMany` by reaching for a **separately captured client reference** (`base`, the un-extended client) rather than using the extension's own `query()` continuation:
```typescript
// existing code, src/lib/prisma.ts
function softDelete<A>(model, args, query, many) {
  if (!isSoftDeletable(model)) return query(args)
  const delegate = (base as Record<string, any>)[lowerFirst(model)]   // <-- reaches for `base`
  const withData = { ...args, data: { deletedAt: new Date() } }
  return many ? delegate.updateMany(withData) : delegate.update(withData)  // <-- NOT query(withData)
}
```
If this fires while inside `prisma.$transaction(async (tx) => { await tx.device.deleteMany({...}) })`, the resulting `base.device.updateMany(...)` call is issued through `base` — a different client instance than `tx` — and does **not** participate in the active transaction.
**Why it happens:** Prisma's documented extension API explicitly states the `query()` continuation cannot change the *operation type* (you can't turn a `delete` into an `update` just by mutating `args` and calling `query(args)` — that always re-issues the same operation). The *only* way to genuinely swap operations inside an extension is to call a different method on some client/delegate object — and per Prisma's own community-acknowledged limitation, "if you trigger the extension from inside a transaction... the extension code will issue the queries in a new connection and ignore the current transaction context" when it reaches for a captured client reference other than the one passed into the hook `[CITED: github.com/prisma/prisma discussion #20016, issue #17948]`. This is a maintainer-acknowledged limitation, not a wild guess — but it was **not** executed against a live database in this research session (no DB credentials were read, per the untrusted-input/secrets boundary), so treat the specific failure mode (silent non-atomicity vs. an outright hang/timeout) as `MEDIUM confidence`, not certain.
**How to avoid:** for every cascade soft-delete, call `updateMany` **directly** on `tx` — never `tx.<model>.delete()`/`deleteMany()`. Plain `updateMany`/`update` are **not** intercepted by the current extension at all (only `find*`/`count`/`aggregate`/`groupBy`/`delete`/`deleteMany` have hooks registered), so calling them directly is a clean pass-through that stays on `tx` end-to-end:
```typescript
// src/services/house.ts — SAFE cascade pattern
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
The **only** safe use of the delete-interception mechanism (`prisma.device.delete(...)` directly, un-transacted) is `DEV-04`'s leaf case — a device has no soft-deletable children, so a single non-transactional call is fine and matches how Phase 1 already exercised this exact hook.
**Warning signs:** a cascade-delete integration test that hangs/times out instead of failing fast; a cascade where the parent is marked deleted but children are not (or vice versa) after a forced mid-cascade error — this is exactly the kind of thing a Wave 0/1 atomicity test should catch (see Open Questions #1 and Validation Architecture).

### Pitfall 2: `typebox` and `nanoid` are pure ESM — verify, don't assume, they work from this CommonJS build
**What goes wrong:** both packages' `package.json` have `"type": "module"` and an `exports` map with **no `"require"` condition** — a naive `require('typebox')` from a CommonJS build can throw `ERR_REQUIRE_ESM` on older Node.
**Why it happens:** the whole JS ecosystem (including TypeBox 1.x and nanoid 4.x+) has been moving to ESM-only publishing. This project's `tsconfig.json` has `"module": "commonjs"`, so `tsc` compiles `import Type from 'typebox'` into `require('typebox')`.
**How it was resolved here, not just theorized:** Node's `require(esm)` feature is **stable and unflagged** since Node 20.19.0 / 22.12.0 `[CITED: Node.js blog — Joyee Cheung, "require(esm) in Node.js: from experiment to stability"]`. The machine used for this research runs Node v24.18.0 (current Active LTS as of July 2026 `[CITED: WebSearch — Node.js release schedule]`), and **this was directly tested**, not assumed: a scratch project reproducing this repo's exact `tsconfig.json` (`module: commonjs`, `moduleResolution: node`, `ignoreDeprecations: "6.0"`, `esModuleInterop: true`, `strict: true`) plus `typebox@1.3.6`, `@fastify/type-provider-typebox@6.1.0`, and `nanoid@5.1.16` was compiled with `tsc` (exit code 0, zero errors) and executed with `node` — all imports (`Type`, `Static`, `TypeBoxTypeProvider`, `FastifyPluginAsyncTypebox`, `nanoid`) resolved and ran correctly, including a `Type.Object(...)` runtime call and a full Fastify route round-trip via `app.inject()` returning the expected `400` for an invalid `deviceType` value `[VERIFIED: empirical test, this session]`.
**How to avoid the *portability* risk (this still matters for CI/prod/teammates):** add `"engines": {"node": ">=22.12.0"}` to `package.json` — there is currently no `engines` field at all, so nothing warns on an incompatible Node version today.
**Warning signs:** `npm install` or `npm run build` succeeding locally but `node dist/...` throwing `ERR_REQUIRE_ESM` in CI or on a colleague's machine running an older Node — always check the Node version first if this class of error appears.

### Pitfall 3: `modelConfig` is exhaustive by construction — must set `publicId` for all 12 models, not just the 3 this phase uses
**What goes wrong:** `src/lib/prisma.ts` types `modelConfig` as `Record<Prisma.ModelName, {...}>` specifically so TypeScript errors if any schema model is missing an entry (the file's own comment says as much). Adding a `publicId: boolean` field to that type means **every** model — including `Command` (not built until Phase 4) and the four state tables and `Event` — must get a value now, or the file won't compile.
**Why it happens:** it's a natural consequence of the "explicit over magic, exhaustive by construction" pattern working correctly — this isn't really a bug, just an easy thing to under-scope when skimming the diff.
**How to avoid:** set `Command: { softDelete: false, publicId: true }` now (per Phase 1 D-11, Command is one of the four `public_id`-bearing entities) even though nothing creates a `Command` row until Phase 4; all four state tables + `Event` + `CommandTarget` + `RefreshToken` get `publicId: false`.
**Warning signs:** a `tsc` compile error pointing at the `modelConfig` object literal — that's the compiler doing its job, not a real problem, just fill in the missing entry.

### Pitfall 4: Mass assignment via naive body-to-Prisma spreading
**What goes wrong:** a PATCH handler that does `prisma.house.update({ where, data: request.body })` would let a client set fields never intended to be client-writable — most dangerously, nothing in this phase's schema *currently* allows setting `userId`/`deletedAt`/`stateType`/`stateId` directly, but a future careless PATCH schema addition could.
**Why it happens:** it's the shortest code to write, so it's an easy trap under time pressure.
**How to avoid:** (a) TypeBox body schemas should declare **only** the fields that are actually mutable (name/address for House; name/floor/roomType for Room; name/manufacturer/model for Device — never `deviceType`, per D-06) and (b) use `{ additionalProperties: false }` on every body schema as defense-in-depth so an unexpected field is rejected with 400 at the validation layer, before the service layer even runs `[VERIFIED: empirical test — TypeBox `Type.Object(schema, {additionalProperties: false})` produces the correct JSON Schema `additionalProperties: false]`. (c) services should destructure only the known-safe fields into the Prisma `data` object, never pass `request.body` through directly.

### Pitfall 5: No test-database isolation exists yet — this phase is the first to write DB-touching tests
**What goes wrong:** `src/test/helper.ts`/`TESTING.md` confirm the *only* existing test (`root.test.ts`) makes no DB writes; there is no reset/rollback/truncate mechanism, and `TESTING.md` itself flags this as an open recommendation ("Add transaction rollback between tests OR separate test database"). Phase 2 is the first phase to write tests that create real, persistent rows.
**Why it happens:** REQUIREMENTS.md's Testing section reserves testcontainers explicitly for *async* integration tests (Phase 8, RabbitMQ-dependent) and pure unit tests for infra-free logic — Phase 2's tests are neither: they're synchronous integration tests against a real (dev) MariaDB, a category the project's own test taxonomy doesn't yet have an explicit policy for.
**How to avoid — checked against the actual schema, not guessed:** the *only* unique constraint that can collide across test runs is `User.email` (`@unique`). House/Room/Device have **no** unique constraint besides their (nanoid-generated, always-unique) `publicId` `[VERIFIED: prisma/schema.prisma]` — so House/Room/Device names can be freely reused across tests with zero collision risk. The pragmatic, zero-new-infrastructure fix: give every test-created user a unique email (e.g. a random suffix or `crypto.randomUUID()`), and don't worry about House/Room/Device naming at all. This avoids introducing testcontainers/reset infrastructure a phase early (YAGNI), consistent with the project's minimalism.
**Warning signs:** a `P2002` unique-constraint error on `/auth/register` during test runs — almost certainly a reused test email, not a real bug.

### Pitfall 6: Second-user 404 fixtures are expensive if re-registered per test case
**What goes wrong:** TEST-01 requires a second-user fixture "for every ownership-sensitive route" — naively calling `POST /auth/register` (bcrypt cost 10, ~50-100ms) twice per test case, across ~13+ ownership-sensitive endpoints, adds up.
**How to avoid:** `node:test` supports `describe`/`before` hooks natively (stable since Node 18) `[ASSUMED — standard, stable Node.js runtime API, high confidence from general knowledge, not independently re-verified this session]`. Register the two fixture users **once per test file** via a `before` hook (or a shared `src/test/helpers/fixtures.ts` helper called at the top of each `describe` block) and reuse their tokens across all test cases in that file, rather than re-registering per test case.

### Pitfall 7: TypeBox validation error messages are verbose for union/enum mismatches (cosmetic only)
**What goes wrong:** an invalid `deviceType` produces a message like `"body/deviceType must be equal to constant, body/deviceType must be equal to constant, ..., body/deviceType must match a schema in anyOf"` — correct (400, `FST_ERR_VALIDATION`) but ugly `[VERIFIED: empirical test — see Code Examples]`.
**How to avoid:** not required for this phase (Success Criteria only requires 400, not a specific message shape) — noted so nobody spends time "fixing" it under the assumption it's a bug.

## Code Examples

### Eager per-type state row creation (STATE-01) — the full worked transaction
This is the most architecturally significant code in the phase. Device's `stateType`/`stateId` columns have **no** Prisma `@relation` to the four state tables (the schema comment explicitly says "no @relation (relationMode=prisma; one field, four possible tables)"), so a nested `device.create({data: {lightState: {create:{...}}}})` is not possible — three separate operations are required, sequenced because the state row needs `device.id` (unknown before insert) and the device needs the state row's `id` back (unknown before *its* insert):
```typescript
// src/generated/prisma/client.ts already exports `Prisma`, and Prisma.TransactionClient
// is the correct type for the `tx` callback parameter under this project's generator
// ("prisma-client", not the classic "prisma-client-js") — confirmed by reading
// src/generated/prisma/internal/prismaNamespace.ts directly. [VERIFIED: codebase]
import type { Prisma } from '../generated/prisma/client'
import { prisma } from '../lib/prisma'

type DeviceType = 'light' | 'ac' | 'heater' | 'sensor'

const deviceStateConfig: Record<DeviceType, {
  model: Extract<Prisma.ModelName, 'LightState' | 'AcState' | 'HeaterState' | 'SensorState'>
  createDefaults: (tx: Prisma.TransactionClient, deviceId: bigint) => Promise<{ id: bigint }>
}> = {
  light: {
    model: 'LightState',
    // is_on / brightness both have schema DEFAULTs (false / 0) — omit both from `data`.
    createDefaults: (tx, deviceId) => tx.lightState.create({ data: { deviceId }, select: { id: true } })
  },
  ac: {
    model: 'AcState',
    // targetTemp and mode have NO schema default — must be supplied here.
    createDefaults: (tx, deviceId) =>
      tx.acState.create({ data: { deviceId, targetTemp: 22, mode: 'auto' }, select: { id: true } })
  },
  heater: {
    model: 'HeaterState',
    createDefaults: (tx, deviceId) =>
      tx.heaterState.create({ data: { deviceId, targetTemp: 20 }, select: { id: true } })
  },
  sensor: {
    model: 'SensorState',
    // reading and unit have NO schema default — placeholder values, overwritten by the
    // first real device report once Phase 6 exists; never read by any Phase 2 endpoint.
    createDefaults: (tx, deviceId) =>
      tx.sensorState.create({ data: { deviceId, reading: 0, unit: '' }, select: { id: true } })
  }
}

export async function createDevice(input: {
  roomPublicId: string
  userId: bigint
  name: string
  deviceType: DeviceType
  manufacturer?: string
  model?: string
}) {
  return prisma.$transaction(async (tx) => {
    // 1. Verify room ownership + resolve houseId (denormalized onto Device per D-07/DATA-02)
    const room = await tx.room.findFirst({
      where: { publicId: input.roomPublicId, userId: input.userId },
      select: { id: true, houseId: true }
    })
    if (!room) return null // route → 404

    // 2. Create the device row first (stateType/stateId still null — both nullable columns)
    const device = await tx.device.create({
      data: {
        userId: input.userId,
        roomId: room.id,
        houseId: room.houseId,
        name: input.name,
        deviceType: input.deviceType,
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null
        // publicId is minted by the new $allModels.create extension hook — not set here.
      }
    })

    // 3. Create the matching per-type state row (needs device.id, which only exists now)
    const config = deviceStateConfig[input.deviceType]
    const state = await config.createDefaults(tx, device.id)

    // 4. Point the device at its state row (morph discriminator + id)
    return tx.device.update({
      where: { id: device.id },
      data: { stateType: config.model, stateId: state.id }
    })
  })
}
```
`create` and `update` are **not** intercepted by the existing extension's delete-interception logic (only `delete`/`deleteMany` are), so this entire transaction is unaffected by Pitfall 1 — it only becomes relevant for cascade *deletes*.

### NanoID `create` hook — extends the existing `$extends()` call, transaction-safe by construction
```typescript
// src/lib/prisma.ts — additions to the EXISTING file, not a new file
import { generatePublicId } from './nanoid'

const modelConfig: Record<Prisma.ModelName, { softDelete: boolean; publicId: boolean }> = {
  User: { softDelete: true, publicId: false },
  House: { softDelete: true, publicId: true },
  Room: { softDelete: true, publicId: true },
  Device: { softDelete: true, publicId: true },
  RefreshToken: { softDelete: false, publicId: false },
  Command: { softDelete: false, publicId: true }, // Phase 4 model, but the Record is exhaustive now
  CommandTarget: { softDelete: false, publicId: false },
  LightState: { softDelete: false, publicId: false },
  AcState: { softDelete: false, publicId: false },
  HeaterState: { softDelete: false, publicId: false },
  SensorState: { softDelete: false, publicId: false },
  Event: { softDelete: false, publicId: false }
}

const needsPublicId = (model: string): boolean =>
  modelConfig[model as Prisma.ModelName]?.publicId ?? false

export const prisma = base.$extends({
  query: {
    $allModels: {
      // ...existing findUnique/findMany/etc. handlers, unchanged...
      create({ model, args, query }) {
        if (!needsPublicId(model)) return query(args)
        const withData = { ...args, data: { ...(args as any).data, publicId: generatePublicId() } }
        return query(withData) // <-- uses the continuation, NOT a captured `base` reference —
                                //     transaction-safe by construction (contrast Pitfall 1)
      },
      delete({ model, args, query }) { return softDelete(model, args, query, false) },
      deleteMany({ model, args, query }) { return softDelete(model, args, query, true) }
    }
  }
})
```
```typescript
// src/lib/nanoid.ts — NEW, sibling to strings.ts
import { nanoid } from 'nanoid'

export const generatePublicId = (): string => nanoid() // default: 21 chars, matches @db.VarChar(21)
```
This create-hook fires identically whether called via the top-level `prisma` client or via a `tx` parameter inside `$transaction(async (tx) => {...})` — because, unlike `softDelete()`, it never reaches for a separate client reference.

### Device-type validation → 400 (DEV-05, Success Criteria #5) — empirically verified end-to-end
No new error-handling code is needed; the existing global `setErrorHandler` in `src/plugins/error-handler.ts` already reads `error.statusCode`, and Fastify's built-in schema validation already throws a `400` `FastifyError` for a schema mismatch:
```typescript
// src/routes/devices/schemas.ts
import { Type } from '@fastify/type-provider-typebox'

export const CreateDeviceSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 191 }),
  deviceType: Type.Union([
    Type.Literal('light'), Type.Literal('ac'), Type.Literal('heater'), Type.Literal('sensor')
  ]),
  manufacturer: Type.Optional(Type.String({ maxLength: 191 })),
  model: Type.Optional(Type.String({ maxLength: 191 }))
}, { additionalProperties: false })
```
Empirically confirmed via `app.inject()` against a Fastify instance with this exact schema attached: `POST /devices` with `{ deviceType: 'toaster' }` → `res.statusCode === 400`, body `{"error":"Error","message":"body/deviceType must be equal to constant, ...must match a schema in anyOf","statusCode":400,"code":"FST_ERR_VALIDATION"}` `[VERIFIED: empirical test, this session]`.

### PATCH partial update (D-04)
```typescript
// src/routes/devices/schemas.ts
export const PatchDeviceSchema = Type.Partial(Type.Object({
  name: Type.String({ minLength: 1, maxLength: 191 }),
  manufacturer: Type.String({ maxLength: 191 }),
  model: Type.String({ maxLength: 191 })
  // deviceType intentionally NOT included — D-06 immutability enforced by omission from the schema
}), { additionalProperties: false })
```
Empirically confirmed `Type.Partial(...)` produces an object schema with **no** `required` array (every field optional) `[VERIFIED: empirical test, this session]`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Hand-written `as const` JSON Schema + a parallel hand-typed `type X = {...}` (still used by the existing auth routes) | TypeBox `Type.Object(...)` + `Static<typeof schema>` derived types | Project rule since PLAN.md 1.5; first enforced starting this phase | Single source of truth for runtime validation and compile-time types; auth routes stay legacy, not retrofitted |
| `@sinclair/typebox` (scoped, 0.x line) | unscoped `typebox` package (1.x line), paired with `@fastify/type-provider-typebox` 6.x | TypeBox 1.x published as the new "Latest" generation; 0.x now explicitly documented as "LTS"-only, forked to a separate maintenance repo `[CITED: typebox npm readme]` | Pure ESM package; requires Node's stable `require(esm)` (Node ≥20.19.0 / ≥22.12.0) to load from this project's CommonJS build — verified working here on Node v24.18.0 (see Pitfall 2) |
| Sequential/predictable internal ids exposed in APIs | `nanoid()`-generated `public_id`, non-enumerable, generated app-side (no Prisma-native default exists for it) | Locked in Phase 1 (D-11) | Also ESM-only as of nanoid 4.x+ — same `require(esm)` consideration as typebox |
| Prisma's classic `prisma-client-js` generator | `prisma-client` generator (already in use, `generator client { provider = "prisma-client" }`) | Adopted by this project before Phase 1 | `Prisma.TransactionClient` and other namespace types are exported the same way (`import { Prisma } from '.../client'`) — no code-pattern change needed for this phase `[VERIFIED: codebase]` |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `ac_states` creation defaults: `targetTemp=22`, `mode='auto'` | Code Examples §Eager state-row creation | Cosmetic only — placeholder never surfaced to any user until Phase 6 state-read endpoints exist, and gets overwritten by the first real device report |
| A2 | `heater_states` creation default: `targetTemp=20` | Code Examples | Same as A1 |
| A3 | `sensor_states` creation defaults: `reading=0`, `unit=''` | Code Examples | Same as A1 — an empty-string unit could look odd in manual DB inspection but has no functional impact |
| A4 | Recommended maxLength/bounds (191 for names/address/manufacturer/model, no bound on `floor`, `ac`/`heater` target_temp left to the planner to pick a sensible range) | Field validation limits (throughout) | Low — TypeBox bounds are trivially adjustable later; worst case a legitimate edge-value gets rejected until noticed |
| A5 | JSON response keys use camelCase (`publicId`, `houseId`, `deviceType`) not snake_case | Anti-Patterns / Code Examples | Low — grounded in the existing `accessToken`/`expiresAt` precedent in the auth responses `[VERIFIED: codebase]`, but still a judgment call for genuinely new fields; changing later is a breaking API change, though there are no external consumers yet (unreleased v1) |
| A6 | The Prisma `delete`→`update` conversion in `softDelete()` does not participate in an active `$transaction` when called via `tx` | Pitfall 1 | **HIGH if ignored** — if the planner has the cascade-delete service call `tx.device.deleteMany()` instead of the recommended direct `tx.device.updateMany()`, and this diagnosis is correct, cascades could silently run non-atomically or hang/timeout in production. The recommended workaround (direct `updateMany`) is safe regardless of whether this specific diagnosis is 100% correct, so treat A6 as "why," not as something that gates whether to follow the recommendation. |
| A7 | Recommended `engines.node: ">=22.12.0"` floor | Environment Availability | Low — a safety rail; omitting it doesn't break anything on Node ≥22.12, only risks a confusing crash message on older Node without the npm engines warning |
| A8 | `node:test` `describe`/`before` hooks are available and appropriate for sharing fixture users across test cases in one file | Pitfall 6 | Low — this is standard, stable Node.js runtime API (not independently re-verified this session, general high-confidence knowledge); worst case the planner falls back to per-test registration, just slower |

## Open Questions

1. **Should cascade-delete transaction atomicity be spiked/verified before building the full cascade feature on top of it?**
   - What we know: strong documented + circumstantial evidence (Pitfall 1 / A6) that the *existing* delete-interception mechanism doesn't compose with `$transaction`, and a safe, low-cost workaround (direct `updateMany`) that sidesteps the question entirely.
   - What's unclear: whether Prisma 7.8.0 + `@prisma/adapter-mariadb` specifically behaves identically to the community reports referenced (which may predate this Prisma version), since this could not be executed against a live database in this research session (the `.env`/`DATABASE_URL` boundary was respected and not read).
   - Recommendation: the planner should sequence a small early task (first task of the House slice, before building the full cascade) that writes a throwaway test proving the recommended direct-`updateMany` pattern is atomic — e.g., force an error after the first cascade step and assert nothing committed. Cheap insurance, and it also happens to double as the actual HOUSE-04/ROOM-04 cascade tests once past the throwaway stage.

2. **Should `additionalProperties: false` be a blanket policy for every new TypeBox body schema, or decided per-route?**
   - What we know: it's a working, low-cost defense-in-depth against mass assignment (Pitfall 4), verified to compile and produce the correct JSON Schema.
   - What's unclear: whether any Phase 2 route legitimately needs to accept-and-ignore extra fields (none identified in the current requirements).
   - Recommendation: default to `{ additionalProperties: false }` on every new body schema unless a specific route surfaces a reason not to.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime for `typebox`/`nanoid` (ESM-only, needs `require(esm)`) | ✓ | v24.18.0 (Active LTS) `[VERIFIED: node --version]` | None needed — well above the 22.12.0 floor. Recommend pinning `engines.node: ">=22.12.0"` since no floor currently exists. |
| npm | Package install/build | ✓ | 11.16.0 `[VERIFIED: npm --version]` | — |
| MariaDB (`smart_house` @ localhost:3306) | All CRUD reads/writes | ✓ reachable | schema confirmed up to date (`prisma migrate status` → "Database schema is up to date!"; `houses`/`rooms`/`devices` tables including the Phase-1-added `house_id` column on `devices` all present) `[VERIFIED: prisma migrate status, prisma validate]` | — |
| `typebox` / `@fastify/type-provider-typebox` / `nanoid` | New dependencies this phase | ✓ resolve on npm registry, compile + run correctly under this project's exact tsconfig | 1.3.6 / 6.1.0 / 5.1.16 | See Alternatives Considered (`@sinclair/typebox` 0.x + provider 5.x) if the team wants zero ESM/Node-version dependency |
| `@prisma/adapter-mariadb` interactive transactions | Eager state-row creation, cascade deletes | ✓ supported, including nested-transaction savepoints as of Prisma 7.5.0 (project runs 7.8.0) `[CITED: prisma.io/changelog 2026-03-11]` | 7.8.0 | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none — everything required is present and working.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` + `node:assert` (Node built-in), no external runner |
| Config file | none — built into Node; `tsconfig.json` includes `src/**/*` |
| Quick run command | `npm run build && node --test dist/src/test/routes/houses.test.js` (swap filename per area) |
| Full suite command | `npm run build && npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| HOUSE-01 | Create house → 200 + house body | integration (`app.inject`) | `node --test dist/src/test/routes/houses.test.js` | ❌ Wave 0 |
| HOUSE-02 | List/view own houses; soft-deleted excluded | integration | same file | ❌ Wave 0 |
| HOUSE-03 | Update own house (PATCH partial) | integration | same file | ❌ Wave 0 |
| HOUSE-04 | Soft-delete house; cascades to rooms+devices atomically | integration | same file | ❌ Wave 0 |
| HOUSE-05 | Cross-tenant → 404 not 403 | integration | same file (TEST-01 fixture) | ❌ Wave 0 |
| ROOM-01…04 | Create/list/update/delete room, ownership-scoped | integration | `dist/src/test/routes/rooms.test.js` | ❌ Wave 0 |
| DEV-01…05 | Create/list/update/delete device; device-type validated | integration | `dist/src/test/routes/devices.test.js` | ❌ Wave 0 |
| STATE-01 | Eager state row exists post-create with correct defaults; `stateType`/`stateId` set | integration | `devices.test.js` (assert via a direct `prisma.lightState.findUnique` etc. after `POST /rooms/:id/devices`) | ❌ Wave 0 |
| TEST-01 | Second-user 404 on every ownership route | integration | cross-cutting across all 3 test files | ❌ Wave 0 |
| TEST-05 | Soft-delete excluded from reads; soft-deleted user can't log in | integration | cross-cutting + **one new `/auth/login` test** (no auth tests exist yet at all — `loginUser`'s behavior is already correct via the existing `readGuard`, only the test is missing `[VERIFIED: codebase — src/services/auth.ts]`) | ❌ Wave 0 |
| TEST-08 | 401 without JWT on every new endpoint | integration | cross-cutting, reuses existing `fastify.authenticate` — no new code | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the relevant single test file (`node --test dist/src/test/routes/<area>.test.js`)
- **Per wave merge:** `npm run build && npm test` (full suite)
- **Phase gate:** full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/test/helpers/fixtures.ts` — `createTestUser(app)` / `createTwoTestUsers(app)`, unique email per call (Pitfall 5/6)
- [ ] `src/test/routes/houses.test.ts`
- [ ] `src/test/routes/rooms.test.ts`
- [ ] `src/test/routes/devices.test.ts`
- [ ] one new test case in an auth-adjacent file (or added to `houses.test.ts`) covering "soft-deleted user cannot log in" (TEST-05's auth-side clause — first auth test in the codebase)
- [ ] Framework install: none — `node:test` is built in

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Reused, not new | Existing `fastify.authenticate` (`@fastify/jwt`) — unchanged this phase |
| V3 Session Management | No | No new session logic; JWT is stateless, refresh tokens are Phase 1 |
| V4 Access Control | **Yes — central to this phase** | Ownership-embedded Prisma queries (`where: {publicId, userId}`); 404-not-403 on cross-tenant access; `relationMode="prisma"` means there is no DB-level RLS, so this is the *only* enforcement layer |
| V5 Input Validation | Yes | TypeBox schemas on every new route, `additionalProperties: false` recommended (Pitfall 4) |
| V6 Cryptography | Indirect only | `nanoid()`'s CSPRNG (`crypto.getRandomValues`) is library-handled, not hand-rolled; no new crypto code this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| IDOR / Broken Object Level Authorization (OWASP API Top 10 #1) — a user accessing another user's house/room/device by guessing or reusing an id | Elevation of Privilege / Information Disclosure | Ownership-embedded `{publicId, userId}` queries on every route; 404 (not 403) so existence isn't confirmed to non-owners (HOUSE-05) |
| Mass assignment — a PATCH/POST body setting fields it shouldn't (`userId`, `deletedAt`, `stateType`, `deviceType` post-creation) | Tampering | TypeBox schemas declare only the intended-mutable fields; `additionalProperties: false`; services destructure explicitly rather than passing `request.body` through to Prisma `data` |
| SQL injection | Tampering | Inherently mitigated — Prisma's parameterized queries throughout, no raw SQL introduced this phase |
| Sequential-ID enumeration | Information Disclosure | `public_id` (nanoid, CSPRNG, non-sequential) is the only externally-exposed identifier; the sequential BigInt `id` is never serialized into any response (D-03) |

## Sources

### Primary (HIGH confidence — empirically verified this session, or first-party registry/codebase data)
- `npm view` (registry metadata, README content, `postinstall`/`repository.url`) for `nanoid`, `typebox`, `@fastify/type-provider-typebox`, `prisma`, `@prisma/client`, `@prisma/adapter-mariadb`, `@sinclair/typebox`
- Local empirical compile+run tests (this session, in the scratchpad, mirroring this repo's exact `tsconfig.json`) — confirmed `typebox`/`nanoid`/`@fastify/type-provider-typebox` work end-to-end under Node v24.18.0 + this project's CommonJS config; confirmed `Type.Union`/`Type.Partial`/`additionalProperties: false` JSON Schema output; confirmed a live Fastify `app.inject()` round-trip returns 400 for an invalid `deviceType`
- Direct codebase inspection (Read/Grep): `src/lib/prisma.ts`, `prisma/schema.prisma`, `tsconfig.json`, `package.json`, `src/routes/auth/*`, `src/services/*`, `src/generated/prisma/internal/prismaNamespace.ts`, `.planning/codebase/*.md`, git history for the `house_id` migration amendment
- `gsd-tools query package-legitimacy check` — package audit signals
- `npx prisma migrate status` / `npx prisma validate` — live confirmation the dev database schema is current

### Secondary (MEDIUM confidence — CITED, official docs/changelog via WebFetch/WebSearch)
- `@fastify/type-provider-typebox` README (npm) — plugin typing pattern (`FastifyPluginAsyncTypebox`), Fastify-version compatibility table
- `typebox` README (npm) — "Versions" table distinguishing 1.x "Latest"/ESM-only vs. 0.x "LTS"/dual-format
- `nanoid` README (npm) — default alphabet and 21-character default length
- prisma.io/docs — client-extensions/query component (create-hook signature: `{model, operation, args, query}`, mutate `args` then call `query(args)`)
- prisma.io/docs — queries/transactions (interactive transaction default timeout 5000ms)
- github.com/prisma/prisma discussion #20016 and issue #17948 — extension-in-transaction limitation, maintainer-acknowledged
- Node.js blog (Joyee Cheung) — `require(esm)` stability, Node 20.19.0/22.12.0 cutoff
- WebSearch — Prisma's MySQL `VARCHAR(191)` default rationale (utf8mb4 767-byte index key limit)
- WebSearch — `@prisma/adapter-mariadb` transaction support + Prisma 7.5.0 changelog (binary protocol, nested-transaction savepoints)
- WebSearch — Node.js LTS schedule as of July 2026 (Node 24 Active LTS, Node 22 Maintenance LTS)

### Tertiary (LOW confidence)
- None used un-cross-checked; all field-validation-default judgment calls are tracked in the Assumptions Log rather than presented as sourced facts.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions confirmed via npm registry and empirically compiled/run in a project-identical harness
- Architecture (Prisma extension/transaction composability, Pitfall 1): MEDIUM — grounded in official docs + maintainer-acknowledged community reports + direct reading of this repo's actual code, but not executed against a live database transaction in this session (the `.env`/`DATABASE_URL` boundary was respected)
- Pitfalls: HIGH for the ESM/`require(esm)` and TypeBox-validation findings (both empirically verified end-to-end); MEDIUM for the transaction-escape cascade risk (strong circumstantial evidence, workaround is safe regardless)
- Field validation limits/defaults: LOW-MEDIUM — mostly architectural judgment calls, not externally verifiable facts (see Assumptions Log A1-A4)

**Research date:** 2026-07-09
**Valid until:** ~14 days for the TypeBox-specific findings (the `typebox` package is iterating very actively — latest patch was published the day before this research); ~30 days for the Prisma/transaction and general-architecture findings, which are more stable.
