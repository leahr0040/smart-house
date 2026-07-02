# Phase 1: Schema & Data Conventions - Research

**Researched:** 2026-07-02
**Domain:** Prisma ORM schema design on MariaDB (driver-adapter pattern), UUID v7 storage, hand-authored rename migrations, polymorphic morph modeling without native DB constraints
**Confidence:** HIGH (Prisma/MySQL mechanics, migration workflow) / MEDIUM (MariaDB-specific adapter quirks — verified via GitHub issues, not official docs, since no Context7/doc-provider access was available this session)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Per-type state detail columns** — no DB-level enums, CHECK constraints, or min/max; every value/range/vocabulary rule enforced in the TypeBox app layer.
- **D-01 `light_states`:** `is_on` (Boolean), `brightness` (Int) — no 0–100 DB constraint.
- **D-02 `ac_states`:** `is_on` (Boolean), `target_temp` (Int), `mode` (String — plain column).
- **D-03 `heater_states`:** `is_on` (Boolean), `target_temp` (Int).
- **D-04 `sensor_states`:** `reading` (Decimal), `unit` (String).
- **D-05:** Every detail table also carries `last_event_at` (DateTime, nullable) and `last_event_id` (uuid v7, nullable) for the tuple guard, plus the morph back-link to the owning device. Rows are created eagerly at device creation with defaults (STATE-01, delivered in Phase 2; columns/defaults shaped here).

**Enum representation (no native DB enums)**
- **D-06:** `Command.status`, `events.entity_type`, `events.device_type`, `events.event_kind`, `events.source`, `ac_states.mode` are all plain `String` columns validated in TypeBox, not Prisma/MySQL native enums.

**Event snapshot format**
- **D-07:** `events.snapshot` is a native MariaDB JSON column holding the effect/report payload verbatim. The "no JSON column" rule is scoped to queryable current-state detail tables only — the append-only audit log is explicitly exempt.

**Entity metadata (non-state columns)**
- **D-08 House:** `address` (String, optional). Timezone stays v2 (HOUSE-06).
- **D-09 Room:** `floor` (Int, default 0) and `room_type` (String, optional free-text label).
- **D-10 Device:** `manufacturer` (String, optional) and `model` (String, optional). `device_type` is a validated `String` (per D-06).

### Claude's Discretion
- **uuid v7 storage format** (`BINARY(16)` vs `CHAR(36)`): research spike (ROADMAP success criterion 5) — resolved below in Common Pitfalls / Code Examples. Must also confirm the Prisma MariaDB adapter emits v7 (not v4) for `@default(uuid())`. Whatever is chosen applies consistently to `event_id`/`last_event_id` and is carried into Phase 7's cursor-comparison decision.
- **Per-device limits/config surface:** not modeled as DB columns/enums in v1; limits live in the TypeBox action registry (`src/lib/device-actions.ts`). Registry-seamed for a v2 DB-backed source if dynamic device types ever land.
- **Exact Prisma decimal precision** for `sensor_states.reading` / temps — resolved below (Standard Stack) with sensible defaults.

### Deferred Ideas (OUT OF SCOPE)
- Per-device limits/config as DB columns or a config table — deferred; limits stay in the TypeBox action registry for v1.
- House timezone — v2 (HOUSE-06); `address` only in v1.
- Additional room/device metadata beyond the chosen fields — add per real need; not modeled speculatively.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DATA-01 | All DB tables/columns snake_case via `@map`/`@@map`, including existing `User`/`RefreshToken`; existing-table rename uses hand-authored `ALTER TABLE … RENAME` migration | See "Hand-Authored Rename Migration" pattern and Runtime State Inventory — confirms `refresh_tokens` is *already* correctly named in the live DB; only `User` needs the rename |
| DATA-02 | `user_id` denormalized onto Room, Device, Command; ownership checks use it directly | See "Standard Stack" schema fields and "Architecture Patterns" — denormalized FK modeled as a plain `Int`/`String` column, not a relation requirement, under `relationMode = "prisma"` |
| DATA-03 | Soft delete (`deleted_at`) on User, House, Room, Device; reads exclude soft-deleted; soft-deleted user cannot authenticate | See "Architecture Patterns" — `deleted_at DateTime? @map("deleted_at")`; app-layer filter convention (no DB partial index/generated column in v1) |
| DATA-04 | Batched `IN` queries; tuple-guarded UPDATE; unique index on deterministic `event_id`; CAS target transitions; `SELECT … FOR UPDATE` roll-up; one transaction | Schema-only in Phase 1 — this phase lays the indexes/columns (`@@unique([eventId])`, `(last_event_at, last_event_id)` columns, `@@index([deviceId, recordedAt])`) that DATA-04's runtime logic (Phase 4/6) depends on |
</phase_requirements>

## Summary

Phase 1 is a pure schema/migration phase: no application logic, no new npm dependencies. The work is (1) extend `prisma/schema.prisma` with House, Room, Device, Command, CommandTarget, four per-type state detail tables, and the append-only `events` table, all snake_case-mapped; (2) hand-author a `RENAME TABLE` migration for the existing un-mapped `User` model (verified: `refresh_tokens` is **already** correctly named in the live database — no rename needed there, only `@@map` needs adding to the Prisma schema source so future diffs don't re-attempt a rename); (3) resolve the uuid v7 storage-format spike; (4) run `prisma migrate dev`, `npm run build`, `npm test` to green.

The single most load-bearing finding from this research: **Prisma's `uuid()` schema function defaults to v4, not v7** — every new PK and every `event_id`/`last_event_id` column MUST explicitly use `@default(uuid(7))` or it silently generates non-time-ordered v4 UUIDs, breaking the tuple-guard ordering guarantee and the Phase 7 cursor design. Second: Prisma's `uuid(7)` generator **only works on `String` fields** — there is no built-in binary-UUID generator, so achieving true `BINARY(16)` MariaDB storage would require abandoning the native generator in favor of `dbgenerated()` + raw MySQL functions (`UUID_TO_BIN`/`BIN_TO_UUID`), which are not guaranteed present/behaviorally identical on MariaDB. Given the user's explicit "no DB enums/limits, keep it simple, app-layer owns complexity" philosophy, **`String @db.Char(36)` with `@default(uuid(7))` is the recommended storage format** — it is fully native to Prisma, requires no raw-SQL defaults, and the ~20-byte-per-row storage/index cost is negligible at this project's scale (a personal smart-home project, not a high-volume SaaS).

**Primary recommendation:** Use `String @db.Char(36) @default(uuid(7))` for all new PKs and for `event_id`/`last_event_id`; represent the Device→state-table morph and all denormalized `user_id`/FK columns as plain typed columns (no `@relation`) given `relationMode = "prisma"`; hand-author the `User` → `users` rename via `prisma migrate dev --create-only` + manual SQL edit to `RENAME TABLE`; keep `events.snapshot` as native Prisma `Json` (maps to MariaDB `LONGTEXT`-backed `JSON` alias) — functionally correct for this phase's read/write pattern, with one noted adapter caveat below.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Schema/table definitions | Database / Storage | — | Phase 1 is entirely schema-tier; no API or client code touches these tables yet |
| Naming convention enforcement (`@map`/`@@map`) | Database / Storage | — | Prisma schema is the single source of truth for both the TS-facing model name and the SQL-facing table/column name |
| UUID v7 generation | Database / Storage | — | Generated by Prisma's query engine at INSERT time via `@default(uuid(7))`, not app code — no service-layer involvement in Phase 1 |
| Soft-delete column presence | Database / Storage | API / Backend (future) | Column lives in schema now; the *filtering* logic (`WHERE deleted_at IS NULL`) is Phase 2+ service-layer responsibility, out of scope here |
| Polymorphic morph columns (`state_type`/`state_id`) | Database / Storage | API / Backend (future) | Columns and per-type tables defined now; the morph *resolution* logic (join by type) is Phase 2/6 service-layer |
| Event append-only table | Database / Storage | — | `events` table structure only; the write path (INSERT via consumer transaction) is Phase 6 |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `prisma` | 7.8.0 (pinned, matches package.json) [VERIFIED: npm registry] | Schema authoring + migration CLI | Already the project's ORM; no alternative considered — extending existing stack per PROJECT.md constraints |
| `@prisma/client` | 7.8.0 [VERIFIED: npm registry] | Generated query client | Already in use |
| `@prisma/adapter-mariadb` | 7.8.0 [VERIFIED: npm registry] | Driver-adapter pattern for MariaDB connectivity | Already in use; project constraint (not the default TCP connector) |

No new packages are introduced in Phase 1. All schema-level features used (`uuid(7)`, `Json`, `Decimal`, `@map`/`@@map`, `relationMode = "prisma"`) are native Prisma Schema Language — zero additional npm installs required.

### Supporting
_None — no supporting libraries needed for a schema-only phase._

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `String @db.Char(36) @default(uuid(7))` for PKs/event ids | `Bytes @db.Binary(16)` with `dbgenerated("UUID_TO_BIN(UUID(), 1)")` | Saves ~20 bytes/row and produces smaller indexes, but forfeits Prisma's native `uuid(7)` generator (Prisma has no binary-UUID generator — see Pitfall 1), requires raw SQL functions whose MariaDB compatibility is not verified, and adds serialization complexity (every read must `BIN_TO_UUID()`, every write must `UUID_TO_BIN()`) that the app-layer would have to hand-roll. Not worth it at this project's scale. |
| Native MariaDB `UUID` data type (available since MariaDB 10.7) [CITED: mariadb.com/docs] | N/A | Prisma has no schema-level mapping for MariaDB's native `UUID` column type as of 7.8.0 (it is not one of the documented `@db.*` native type attributes for the MySQL connector) — would require `Unsupported("uuid")` + raw queries throughout, defeating the point of using Prisma. Not evaluated further. |
| Prisma `Json` scalar for `events.snapshot` | Separate normalized snapshot columns per event type | User explicitly scoped the "no JSON" rule to *current-state* tables only (D-07); the audit log is the one place JSON is the right shape (heterogeneous payload, replay/AI-mining use case) — normalizing it would require a schema migration per new device type. |

**Installation:**
No installation required — schema-language features only, no new packages.

**Version verification:** Confirmed via `npm view prisma version`, `npm view @prisma/client version`, `npm view @prisma/adapter-mariadb version` — all resolve to `7.8.0`, matching `package.json` and the locally installed `npx prisma --version` output exactly. No stale-version risk.

## Package Legitimacy Audit

**No new packages are introduced by this phase.** All three Prisma packages (`prisma`, `@prisma/client`, `@prisma/adapter-mariadb`) are already installed dependencies, already vetted by the project's existing setup, and no new package names need registry verification.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| — | — | — | — | — | — | No new packages — audit N/A |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```text
┌─────────────────────────────────────────────────────────────┐
│  prisma/schema.prisma  (single source of truth)              │
│                                                                │
│  User ──rename@@map──> users            RefreshToken (already │
│                                          @@map'd, no rename)   │
│                                                                │
│  House ──user_id(denorm)──┐                                   │
│    └─ Room ──user_id(denorm)──┐                               │
│         └─ Device ──user_id(denorm)──┐                        │
│              │  state_type/state_id (morph, no FK)            │
│              ├──> light_states  ──last_event_at/id──┐         │
│              ├──> ac_states     ──last_event_at/id──┤         │
│              ├──> heater_states ──last_event_at/id──┤         │
│              └──> sensor_states ──last_event_at/id──┤         │
│                                                       │         │
│  Command ──user_id(denorm)──> CommandTarget          │         │
│                                     │ deadline_at     │         │
│                                     ▼                 │         │
│                              (Phase 4+ writes)        │         │
│                                                       ▼         │
│                              events (append-only, JSON snapshot)│
│                              entity_type: device|command        │
│                              device_id: nullable                │
│                              event_id: UNIQUE (uuid v7)          │
│                              index: (device_id, recorded_at)     │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
      `prisma migrate dev` ──> hand-verified SQL ──> MariaDB
                          │
                          ▼
      `prisma generate` ──> src/generated/prisma/ (typed client)
                          │
                          ▼
      `npm run build` (tsc) ──> `npm test` (existing auth tests, green)
```

This phase's data flow is entirely build-time: schema edits flow into migration SQL, migration SQL is hand-verified then applied, the client is regenerated, and the only runtime check is that the existing auth test suite still passes against the renamed `users` table. No request ever reaches these new tables in Phase 1.

### Recommended Project Structure
```
prisma/
├── schema.prisma              # all models added here, single file (matches existing convention)
└── migrations/
    ├── 20260616152601_init/                    # existing — untouched
    ├── 20260617121303_add_refresh_tokens/       # existing — untouched
    ├── <timestamp>_rename_user_to_users/        # NEW — hand-edited RENAME TABLE
    └── <timestamp>_add_domain_schema/           # NEW — House/Room/Device/Command/state tables/events
src/
├── generated/prisma/           # regenerated, unchanged location
└── services/                   # untouched in Phase 1 (no service files needed — no runtime logic)
```

Two separate migrations are recommended (rename first, additive second) rather than one combined migration — this isolates the risky hand-edited SQL (rename) from the mechanical additive SQL (new tables), so if the rename needs a second pass it doesn't entangle with unrelated `CREATE TABLE` statements.

### Pattern 1: Hand-Authored Rename Migration (DATA-01)
**What:** Use `prisma migrate dev --create-only` to generate a draft migration, then manually edit the generated SQL to replace Prisma's default `DROP TABLE`/`CREATE TABLE` pair with `RENAME TABLE`, before applying it.
**When to use:** Any time a `@@map` (or a plain rename) is added to a model that already has a live, populated table — Prisma's schema diffing cannot distinguish "rename" from "drop + create" and defaults to the latter, which is destructive.
**Example:**
```prisma
// schema.prisma — add @@map to the existing User model
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  password  String
  name      String?
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")   // DATA-03 addition
  refreshTokens RefreshToken[]

  @@map("users")
}
```
```bash
# Source: Prisma official docs — "Customizing Migrations" workflow
npx prisma migrate dev --name rename_user_to_users --create-only
```
```sql
-- Generated draft (DESTRUCTIVE — do not apply as-is):
-- DROP TABLE `User`;
-- CREATE TABLE `users` ( ... );

-- Hand-edit to:
ALTER TABLE `User` RENAME TO `users`;
-- Then apply any column additions (e.g., deleted_at) as a separate ALTER TABLE
-- in the SAME migration file, after the rename, referencing the new table name:
ALTER TABLE `users` ADD COLUMN `deleted_at` DATETIME(3) NULL;
```
```bash
npx prisma migrate dev   # applies the hand-edited SQL
```

**Verified finding:** `refresh_tokens` does **not** need this treatment — its existing migration (`20260617121303_add_refresh_tokens/migration.sql`, read directly from the repo) already does `CREATE TABLE refresh_tokens (...)`. The Prisma model was authored with `@@map("refresh_tokens")` from day one, so the live table is already correctly named. Only `User` (never mapped) needs the rename. `[VERIFIED: prisma/migrations/*/migration.sql read directly]`

### Pattern 2: uuid v7 as Prisma-native String PK
**What:** Every new domain PK (`House.id`, `Room.id`, `Device.id`, `Command.id`, `CommandTarget.id`, state-table ids, `events.event_id`) uses `String @id @default(uuid(7)) @db.Char(36)`.
**When to use:** All new tables in this phase. `User`/`RefreshToken` PKs stay `Int @default(autoincrement())` per the locked decision (no migration needed for existing tables).
**Example:**
```prisma
// Source: Prisma Schema Reference (uuid() function) + Prisma changelog 2024-08-08 "native UUIDv7 support"
model Device {
  id         String   @id @default(uuid(7)) @db.Char(36)
  userId     String   @map("user_id") @db.Char(36)   // denormalized, no @relation required under relationMode=prisma
  roomId     String   @map("room_id") @db.Char(36)
  name       String
  deviceType String   @map("device_type")             // validated in TypeBox, not a DB enum (D-06)
  manufacturer String? 
  model      String?
  stateType  String?  @map("state_type")               // morph discriminator
  stateId    String?  @map("state_id") @db.Char(36)     // morph target id, no FK
  deletedAt  DateTime? @map("deleted_at")
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  @@map("devices")
  @@index([userId])
  @@index([roomId])
}
```

**CRITICAL caveat — confirm before finalizing:** `@default(uuid())` (no argument) resolves to **v4**, not v7. `[CITED: Prisma changelog 2024-08-08 "Prisma ORM v5.18.0: native UUIDv7 support"]` This project MUST use the explicit `uuid(7)` form everywhere a time-ordered id is required — `event_id`, `last_event_id`, and (per the roadmap's "uuid v7 for new entities" decision) every new PK. A bare `@default(uuid())` anywhere in the new schema is very likely a bug and should be caught in plan review / code review.

### Pattern 3: Polymorphic Morph Without FK Constraints
**What:** `Device.stateType` (String, e.g. `"light"`/`"ac"`/`"heater"`/`"sensor"`) + `Device.stateId` (String, the PK of the corresponding `*_states` row) act as an app-resolved polymorphic pointer. No Prisma `@relation` is declared between `Device` and the four state tables because a single FK field can't target four different tables.
**When to use:** Any "single facet, multiple possible types" modeling need. Consistent with `relationMode = "prisma"` (already set) — the project already accepts emulated relations with app-enforced integrity, so a morph with zero DB-level referential integrity is a natural extension, not a new risk category.
**Example:**
```prisma
// Source: pattern derived from Prisma's documented relationMode=prisma emulation
// (Prisma's official position is that native polymorphic associations are unsupported;
// this "typed discriminator + app-resolved id, no @relation" shape is the community-standard workaround)
model LightState {
  id           String    @id @default(uuid(7)) @db.Char(36)
  deviceId     String    @map("device_id") @db.Char(36)   // morph back-link, no @relation
  isOn         Boolean   @map("is_on") @default(false)
  brightness   Int       @default(0)
  lastEventAt  DateTime? @map("last_event_at")
  lastEventId  String?   @map("last_event_id") @db.Char(36)
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  @@map("light_states")
  @@index([deviceId])
}
```
The back-link is indexed (`@@index([deviceId])`) even without a `@relation`/FK — under `relationMode = "prisma"` Prisma does not auto-create this index the way it would for a declared relation, so it must be added explicitly. This is a documented requirement of emulated relation mode, not specific to the morph pattern. `[CITED: Prisma docs — "Manage relations between records with relation modes" — "you must add indexes on foreign keys manually" under relationMode=prisma]`

### Pattern 4: Append-Only Events Table with Command-Lifecycle Support from Day One
**What:** `events.entity_type` (`device`|`command`) and nullable `events.device_id` are present in the schema even though Phase 1 never writes a row — this avoids a later migration when command-lifecycle events (`command.received`, etc.) are introduced in Phase 4.
**Example:**
```prisma
model Event {
  eventId    String    @id @default(uuid(7)) @map("event_id") @db.Char(36)
  entityType String    @map("entity_type")                 // "device" | "command", app-validated
  source     String                                          // app-validated vocabulary
  eventKind  String    @map("event_kind")                    // app-validated vocabulary
  deviceId   String?   @map("device_id") @db.Char(36)        // null for command-lifecycle rows
  deviceType String?   @map("device_type")
  commandId  String?   @map("command_id") @db.Char(36)
  snapshot   Json
  recordedAt DateTime  @map("recorded_at")                   // producer-minted event-time, NOT createdAt

  @@map("events")
  @@unique([eventId])          // redundant with @id but documents DATA-04's "unique index on event_id" explicitly
  @@index([deviceId, recordedAt])
}
```
Note: `@id` already implies a unique index in Prisma/MySQL, so the explicit `@@unique([eventId])` is belt-and-suspenders documentation rather than a functional requirement — the planner may omit it if it's judged redundant, but DATA-04 explicitly calls out "a MariaDB unique index on the deterministic `event_id`" as a requirement, so making it visible in the schema (even if technically implied by `@id`) is defensible for clarity to future readers.

### Anti-Patterns to Avoid
- **Using `@default(uuid())` (bare) anywhere in the new schema:** silently produces v4, breaking time-ordering assumptions baked into the tuple guard and Phase 7 cursor design. Always write `uuid(7)` explicitly.
- **Declaring a Prisma `@relation` on the Device→state-table morph:** impossible to express correctly (one field, four possible target tables) and not needed — `relationMode = "prisma"` already means no DB constraint is enforced; the morph is just two plain columns.
- **Combining the rename and the additive schema changes into one giant `prisma migrate dev` run without `--create-only`:** removes the opportunity to hand-edit the destructive rename portion before it touches the live database.
- **Adding a DB-level `ENUM` type for `Command.status`, `ac_states.mode`, etc.:** directly contradicts the user's explicit, locked decision (D-06) and the project's "no DB enums/limits" philosophy.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| UUID v7 generation | A custom JS/TS uuid-v7 generator function called from services | Prisma's native `@default(uuid(7))` | Zero app code, zero new dependency, generated at the DB-engine level consistently for every insert path (including any future direct SQL/seed scripts) |
| Rename-safe migrations | A custom migration-diffing script | `prisma migrate dev --create-only` + manual SQL edit (official, documented workflow) | This is Prisma's own documented and supported pattern for exactly this problem — no need to reinvent it |
| snake_case mapping | A runtime column-name-transforming wrapper around Prisma Client | `@map`/`@@map` declarative attributes | Compile-time, zero runtime cost, and the existing `RefreshToken` model already demonstrates the pattern to extend |

**Key insight:** Every "hand-roll risk" in this phase already has a first-class Prisma schema-language answer. The only genuinely custom work is the one hand-edited migration SQL file (the rename) — everything else is declarative schema authoring.

## Runtime State Inventory

> This phase is a rename (User → users) touching a live, populated table. Full inventory below.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | The `User` table (MariaDB, local dev instance) currently holds live rows created via `prisma migrate dev` against `20260616152601_init` and used by existing auth tests/manual testing. `refresh_tokens` already correctly named — no data-shape change needed there. | Data migration: the `User`→`users` rename must preserve every existing row (ids, emails, password hashes, refresh-token FKs by `user_id` Int) — this is why `RENAME TABLE` (not drop+recreate) is mandatory, not just a style preference. |
| Live service config | None — no external services (n8n, Datadog, etc.) reference the `User` table name. This is a single-service Fastify app; only this codebase's own Prisma client and raw SQL (if any) reference the table name. | None. |
| OS-registered state | None found. No Windows Task Scheduler entries, no pm2/launchd/systemd units reference "User" or the smart-house DB. | None. |
| Secrets/env vars | `DATABASE_URL` in `.env` points at the database, not the table — unaffected by the table rename. No secret key names embed "User" or "users". | None. |
| Build artifacts | `src/generated/prisma/` (Prisma Client output) contains generated TypeScript referencing the Prisma model name `User` (the *model* name, not the table name) — `@@map` changes only the underlying SQL table name; the generated client's `prisma.user.findMany()` API surface is **unchanged**. Must run `npm run prisma:generate` after the schema edit regardless, to pick up the new `@@map` and any new models. | Code action: `npm run prisma:generate` (already part of the phase's own "regenerate Prisma client" step — no separate action needed beyond what the roadmap already specifies). |

**Nothing found in three of five categories** (live service config, OS-registered state, secrets/env vars) — verified by inspecting `.env` variable names, confirming this is a single-process local-dev Fastify app with no OS-level service registration, and confirming no other process/service in this repo or its `package.json` scripts references the raw SQL table name "User".

## Common Pitfalls

### Pitfall 1: Assuming `@default(uuid())` produces UUID v7
**What goes wrong:** A developer (or an LLM continuing this codebase) writes `@default(uuid())` expecting time-ordered ids, because the roadmap says "uuid v7 for new entities," but Prisma's function defaults to v4 when no argument is given.
**Why it happens:** `uuid(7)` support was added relatively recently (Prisma 5.18.0, August 2024) `[CITED: Prisma changelog 2024-08-08]`, and a lot of existing tutorials/training data show the bare `uuid()` form from before v7 support existed, when it was the only option.
**How to avoid:** Grep the finished schema for `@default(uuid())` with no argument before finalizing Phase 1 — every occurrence should be `uuid(7)`. This is exactly the roadmap's success-criterion-5 spike; treat it as a hard gate, not a suggestion.
**Warning signs:** If `last_event_id` values inserted during later manual testing don't sort in insertion order when queried `ORDER BY last_event_id`, v4 was used by mistake.

### Pitfall 2: Trying to get true `BINARY(16)` storage while keeping Prisma's native `uuid(7)` generator
**What goes wrong:** A developer tries to write `Bytes @db.Binary(16) @default(uuid(7))` expecting Prisma to generate a v7 UUID and store it as compact binary. This does not work — Prisma's `uuid()`/`uuid(7)` generator is only valid on `String`-typed fields. `[CITED: prisma/prisma GitHub issue #11414 "New binary equivalent for uuid()" — confirms no binary-native uuid() generator exists as of this research date]`
**Why it happens:** The `BINARY(16)` vs `CHAR(36)` performance advice is extremely common general MySQL/MariaDB advice, but it predates (and is not aware of) Prisma's specific generator limitations.
**How to avoid:** This research recommends **not** pursuing `BINARY(16)` for this project — see Alternatives Considered. If a future phase needs it for scale reasons, the correct approach is `Bytes @db.Binary(16) @default(dbgenerated("UUID_TO_BIN(UUID(), 1)"))`, but this must first be verified against the actual MariaDB server version in use (not assumed compatible with MySQL 8's `UUID_TO_BIN`) — flagged as an open question below, not resolved in this research pass since it's out of scope for the recommended path.
**Warning signs:** A Prisma validation error like "Function `uuid()` is not supported on fields of type `Bytes`" at `prisma generate`/`migrate dev` time.

### Pitfall 3: Prisma v7 + MariaDB 10.11+ JSON-related introspection/Studio syntax error
**What goes wrong:** Running `npx prisma studio` (or possibly other introspection-driven tooling) against this project's MariaDB instance may throw a SQL syntax error near a `CAST(... AS json)` clause, because Prisma 7's new "JSON Protocol" engine emits MySQL-8-specific casting syntax that MariaDB's parser rejects.
**Why it happens:** This is a currently **open, unfixed regression** in Prisma itself (introduced in v7.0.0, confirmed still open as of the GitHub issue's last update). `[CITED: prisma/prisma GitHub issue #29023, opened 2026-01-12, status: open/unconfirmed]`
**How to avoid:** The bug is reported as scoped to **introspection and Prisma Studio** queries against `information_schema` — not confirmed to affect `prisma migrate dev`, `prisma generate`, or normal Prisma Client CRUD queries against application tables. Phase 1's acceptance bar (`prisma migrate dev` exits 0, `npm run build` compiles, `npm test` passes) does not invoke Studio or introspection, so this should not block Phase 1. However: **do not run `npm run prisma:studio` as a manual sanity-check during this phase** — it may fail with a confusing SQL error unrelated to the actual schema correctness. Use `npx prisma migrate status` or direct SQL queries via a MariaDB client instead if manual verification is wanted.
**Warning signs:** A syntax error mentioning `json) from (select` when running Prisma Studio or an introspection command (`prisma db pull`).

### Pitfall 4: MariaDB's `JSON` is `LONGTEXT`, not a binary JSON type
**What goes wrong:** Assuming `events.snapshot` gets PostgreSQL-`jsonb`-like binary storage, indexed path queries, etc.
**Why it happens:** MariaDB introduced `JSON` as an alias for `LONGTEXT COLLATE utf8mb4_bin` for MySQL syntax compatibility — it is not a first-class binary JSON type the way MySQL 8's `JSON` or Postgres's `jsonb` are. `[CITED: MariaDB Server documentation — "JSON Data Type"]`
**How to avoid:** No action needed for Phase 1 — the schema decision (D-07) already only requires storing and retrieving the snapshot verbatim, not querying inside it. If a future phase needs to query/filter on `snapshot` fields, be aware `JSON_EXTRACT`/`JSON_VALUE` on MariaDB operates over a `LONGTEXT`-backed column (functionally works, but without a native binary type's storage/indexing advantages) — this is a known, accepted limitation per PROJECT.md's "no separate event datastore... MariaDB suffices for v1."
**Warning signs:** N/A for this phase — informational only.

### Pitfall 5: Prisma's `cursor:` API cannot express the required `(recorded_at, event_id)` compound tuple cursor
**What goes wrong:** A future phase (Phase 7) developer reaches for Prisma's built-in `cursor: { id: ... }` pagination option expecting it to handle the compound `(recorded_at, event_id)` cursor EVENT-05 requires, and finds it only supports a single unique field, not a tuple comparison.
**Why it happens:** Prisma's cursor pagination looks up the row at the cursor and applies `skip: 1` from there — it does not generate a `WHERE (col_a, col_b) > (?, ?)` tuple comparison. `[CITED: Prisma docs "Pagination" + community discussion confirming compound-cursor tuple comparisons require `$queryRaw`]`
**How to avoid:** Not a Phase 1 action item (Phase 7 concern), but worth recording now since it directly depends on this phase's storage-format decision: whatever `event_id` string format Phase 1 lands on (`CHAR(36)`), Phase 7's cursor implementation should use a raw parameterized query (`$queryRaw`) with an explicit `WHERE (recorded_at, event_id) > (?, ?) ORDER BY recorded_at, event_id` tuple comparison, not Prisma's `cursor` option. Flagged here so Phase 1's schema doesn't need to change again to support it — `CHAR(36)` compares correctly as a string tiebreaker in SQL.
**Warning signs:** N/A for Phase 1 — forward-looking note for Phase 7 planning.

## Code Examples

### Full new-model skeleton respecting all locked conventions
```prisma
// Source: composed from Prisma Schema Reference + this project's existing RefreshToken pattern
model House {
  id        String    @id @default(uuid(7)) @db.Char(36)
  userId    String    @map("user_id") @db.Char(36)
  name      String
  address   String?
  deletedAt DateTime? @map("deleted_at")
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")

  @@map("houses")
  @@index([userId])
}

model Room {
  id        String    @id @default(uuid(7)) @db.Char(36)
  houseId   String    @map("house_id") @db.Char(36)
  userId    String    @map("user_id") @db.Char(36)   // DATA-02 denorm
  name      String
  floor     Int       @default(0)
  roomType  String?   @map("room_type")
  deletedAt DateTime? @map("deleted_at")
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")

  @@map("rooms")
  @@index([houseId])
  @@index([userId])
}

model Command {
  id        String    @id @default(uuid(7)) @db.Char(36)
  userId    String    @map("user_id") @db.Char(36)   // DATA-02 denorm — GET /commands/:id never joins
  status    String    @default("received")            // received|rejected|pending|done|partially_failed|failed|no_targets — TypeBox-validated
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")

  @@map("commands")
  @@index([userId])
}

model CommandTarget {
  id          String    @id @default(uuid(7)) @db.Char(36)
  commandId   String    @map("command_id") @db.Char(36)
  deviceId    String    @map("device_id") @db.Char(36)
  status      String    @default("pending")            // pending|done|failed — CAS-transitioned in Phase 6
  deadlineAt  DateTime  @map("deadline_at")
  createdAt   DateTime  @default(now()) @map("created_at")

  @@map("command_targets")
  @@index([commandId])
  @@index([deviceId])
}
```

### Decimal precision for sensor readings (Claude's Discretion item resolved)
```prisma
// Source: Prisma Schema Reference — MySQL native type attributes
model SensorState {
  id          String    @id @default(uuid(7)) @db.Char(36)
  deviceId    String    @map("device_id") @db.Char(36)
  reading     Decimal   @db.Decimal(6, 2)   // e.g. -999.99..9999.99 — ample for temp/humidity/lux sensors
  unit        String
  lastEventAt DateTime? @map("last_event_at")
  lastEventId String?   @map("last_event_id") @db.Char(36)
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  @@map("sensor_states")
  @@index([deviceId])
}
```
`Decimal(6,2)` gives 4 integer digits + 2 fractional (range ±9999.99) — comfortably covers temperature (°C/°F), humidity (%), and lux readings without DB-level range enforcement (per D-01…D-04, ranges are TypeBox's job, not the DB's — `Decimal(6,2)` is a storage-precision choice, not a value constraint). `target_temp` fields (ac_states, heater_states) stay `Int` per the locked decision in CONTEXT.md D-02/D-03.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `@default(uuid())` was the only uuid option (always v4) | `@default(uuid(7))` explicit form available | Prisma 5.18.0, August 2024 `[CITED: Prisma changelog]` | This project (Prisma 7.8.0) has full v7 support — no workaround/raw-SQL needed for time-ordered ids on `String` fields |
| Prisma's legacy Rust query engine | New "Client engine" / "JSON Protocol" (default in Prisma v7) | Prisma v7.0.0 | Introduced the MariaDB introspection/Studio JSON-casting regression (Pitfall 3) — not present in v5/v6 |
| Prisma-generated migrations for renames always DROP+CREATE | `--create-only` + manual SQL edit is the documented, supported workaround | Long-standing (predates this project) | No native "detect rename" exists yet — GitHub issue #7710 (automatic `@map`/`@@map` rename detection) remains open, so hand-editing stays necessary |

**Deprecated/outdated:** None directly relevant — all recommended patterns here are current as of Prisma 7.8.0.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The MariaDB server version running locally is recent enough (10.7+) to theoretically support a native `UUID` type, and recent enough (10.11+) to be affected by the Prisma v7 Studio/introspection bug — exact version was not confirmed this session (`SELECT @@version` did not return output through the available tool). | Common Pitfalls (Pitfall 3), Alternatives Considered | Low — the recommended path (`String @db.Char(36)`) does not depend on the exact MariaDB version; only the *rejected* `BINARY(16)`/native-`UUID`-type alternatives would need version confirmation, and this research already recommends against pursuing them |
| A2 | Prisma's `uuid(7)` generator, when used on `@db.Char(36)`, produces a canonical hyphenated 36-character UUID v7 string (not some other 36-char format) — based on Prisma changelog description, not directly observed by running `prisma generate` + an insert against a live table in this session. | Architecture Patterns (Pattern 2), Standard Stack | Low-Medium — if the format differs from expectation, string-based lexicographic sort order (relied on for Phase 7 cursor ordering) could be affected. Recommend the planner add a smoke-check task: insert one row, read back `event_id`, confirm it matches UUID v7 shape (`xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`) as part of Phase 1's own acceptance verification. |
| A3 | The Prisma v7 MariaDB introspection/Studio bug (#29023) does not affect `prisma migrate dev` or Prisma Client CRUD queries — based on reading the issue's reported reproduction steps (which only mention `prisma studio`), not on independently reproducing the bug against this project's MariaDB instance. | Common Pitfalls (Pitfall 3) | Medium — if the bug's blast radius is actually broader than reported (e.g., also affects `prisma migrate dev`'s internal schema introspection against a MariaDB with existing JSON columns), Phase 1's acceptance bar could fail unexpectedly. Mitigation: this is directly testable — running `prisma migrate dev` after adding the `events.snapshot Json` column IS the smoke test; if it fails with a JSON-cast syntax error, this assumption was wrong and the fallback is either downgrading Prisma (last resort, contradicts "already installed, verified current" stack) or reporting upstream. |
| A4 | No Context7 or other MCP documentation-lookup tool was available in this research session (tool call failed with "No such tool available"); all Prisma-specific claims were verified via WebSearch + WebFetch against official Prisma docs pages, the Prisma GitHub repo (issues/PRs), and MariaDB's own documentation site — not via a live Context7 docs query. | Entire document | Low — WebFetch was used to pull actual page content from `prisma.io/docs` and `github.com/prisma/prisma` directly (not just search snippets) for the highest-stakes claims (rename workflow, uuid(7) support, the v7/MariaDB bug), so confidence remains HIGH/MEDIUM despite the tooling gap. |

## Open Questions

1. **Exact MariaDB server version in local dev / target deployment**
   - What we know: `npx prisma migrate status` confirms a reachable MariaDB instance named `smart_house` on `localhost:3306`, with both existing migrations applied cleanly.
   - What's unclear: The exact version string (10.6? 10.11? 11.x?) was not retrieved this session — `prisma db execute` ran without surfacing query output through the available tooling.
   - Recommendation: Not a blocker for the recommended `CHAR(36)` path. If the planner wants certainty before starting, a one-line check (`mariadb --version` or `SELECT VERSION();` via any DB client) resolves it in seconds and should be added as a cheap first task in the plan, purely to pre-empt Pitfall 3 surprises.

2. **Should `light_states`/`ac_states`/`heater_states`/`sensor_states` declare a `@unique` on `deviceId` (one state row per device, enforced) or leave it a plain indexed column?**
   - What we know: STATE-01 (Phase 2) creates exactly one state row per device at creation time and never creates a second one; the morph is described as "single current facet per device."
   - What's unclear: CONTEXT.md doesn't explicitly say whether the DB should enforce this 1:1 cardinality via `@@unique([deviceId])` or leave it to application discipline (consistent with the broader "no DB constraints, app owns correctness" philosophy already applied to enums/ranges).
   - Recommendation: Lean toward `@@unique([deviceId])` on each state table — this is a *structural* integrity guarantee (one row per device), not a *value/range* constraint, so it doesn't conflict with D-01…D-07's "no enums/CHECK/min-max" scope, which is specifically about value vocabularies and ranges. A unique index also makes the guarded UPDATE in Phase 6 unambiguous (exactly one row to match). Planner should confirm this reading with the user if there's any doubt, since it's a borderline case relative to the "no DB constraints" theme.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Build/run everything | ✓ | v24.15.0 | — |
| Prisma CLI | Schema authoring, migrations | ✓ | 7.8.0 | — |
| MariaDB (local dev instance) | `prisma migrate dev` target | ✓ | Reachable at `localhost:3306`, database `smart_house`; exact version string not confirmed (see Open Questions #1) | — |
| TypeScript compiler | `npm run build` | ✓ | 6.0.3 (per `npx prisma --version` output) | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none — environment is fully ready for this phase.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node built-in `node:test` + `node:assert` |
| Config file | none — plain `node --test` invocation via `npm test` script |
| Quick run command | `npm run build && node --test dist/src/test/routes/root.test.js` |
| Full suite command | `npm test` (runs `tsc && node --test dist/src/test/**/*.test.js`) |

### Phase Requirements → Test Map

This phase has **no runnable application logic** — per PROJECT.md's explicit "Development Process" exception, schema/infra phases substitute a compile + migration smoke-check for the red-test step. There is no unit/integration test file to write for DATA-01…DATA-04 in Phase 1 itself; DATA-04's *runtime* behaviors (batched IN queries, tuple-guarded UPDATE, CAS, `SELECT … FOR UPDATE`) are exercised by tests in Phases 2, 4, and 6, which consume the schema this phase produces.

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DATA-01 | `prisma migrate dev` applies rename + new schema without error; existing auth tests still pass against renamed `users` table | smoke-check | `npx prisma migrate dev && npm run build && npm test` | ❌ — no new test file; existing `src/test/routes/root.test.ts` is the regression guard |
| DATA-02 | Schema compiles with `user_id` columns present on Room/Device/Command (compile-time check only — no runtime ownership query exists yet) | smoke-check | `npm run build` (TypeScript will fail to compile if the generated Prisma Client's types don't match schema usage anywhere — though nothing consumes these fields yet in Phase 1) | ❌ — behavior tested in Phase 2 |
| DATA-03 | `deleted_at` columns present on User/House/Room/Device; existing auth flow (register/login/refresh/me/logout) still works post-migration | smoke-check + existing regression suite | `npm test` | ✅ (existing `root.test.ts` / auth suite covers login flow indirectly via `build(t)` — confirm during planning whether a dedicated `auth.test.ts` exists beyond `root.test.ts`) |
| DATA-04 | Unique index on `event_id`, compound index on `(device_id, recorded_at)`, `last_event_at`/`last_event_id` columns present — structural only, no runtime CAS/transaction logic in Phase 1 | smoke-check | `npx prisma migrate dev` (fails if index/column DDL is malformed) | ❌ — runtime behavior tested in Phase 4/6 |

### Sampling Rate
- **Per task commit:** `npm run build` (fast compile check after each schema edit)
- **Per wave merge:** `npx prisma migrate dev && npm run build && npm test` (full smoke-check)
- **Phase gate:** `prisma migrate dev` exits 0, `npm run build` compiles clean, `npm test` passes — exactly the roadmap's stated acceptance bar, no more, no less.

### Wave 0 Gaps
None — this phase does not add test files. The existing `src/test/routes/root.test.ts` (and any other existing auth test files under `src/test/`) already form the complete regression guard needed for this phase's acceptance bar. Confirm during planning whether a test specifically exercising login (not just the root health-check) exists; if `src/test/routes/root.test.ts` is the *only* test file, note that as a pre-existing gap (not created by this phase) rather than a Phase-1-introduced one.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No (Phase 1 scope) | Existing JWT/refresh-token flow untouched; only the underlying table is renamed, not the auth logic |
| V3 Session Management | No (Phase 1 scope) | Same as above — no session logic changes |
| V4 Access Control | Indirectly — schema only | `user_id` denormalization on Room/Device/Command (DATA-02) is the schema-level foundation for ownership-scoped access control enforced in later phases; no access-control *logic* exists yet in Phase 1 |
| V5 Input Validation | Indirectly — schema only | TypeBox is the standard for all future validation of these columns' values (device_type, status, mode, etc.) — no validation logic exists yet in Phase 1, but the schema's deliberate avoidance of DB-level constraints means 100% of value validation responsibility shifts to TypeBox in later phases; this is a locked, explicit user decision, not an oversight |
| V6 Cryptography | No (Phase 1 scope) | No new secrets/credentials introduced; existing bcrypt/JWT_SECRET handling untouched |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Destructive migration causing silent data loss on rename (DROP+CREATE instead of RENAME) | Tampering / Repudiation (loss of audit trail for existing users) | Hand-verify the generated SQL emits `RENAME TABLE` before applying (Pattern 1) — this is exactly DATA-01's explicit acceptance criterion; not a generic threat, a named requirement in this phase |
| Missing FK/relation integrity under `relationMode = "prisma"` allowing orphaned rows (e.g., a `Device` row pointing at a deleted `Room`) | Tampering (data integrity) | Already an accepted, documented trade-off in PROJECT.md ("loose FK integrity is fine for a rebuildable projection") — no new mitigation needed in Phase 1; this is a locked architectural decision, not a gap to close here |
| Soft-delete bypass (a query forgets to filter `deleted_at IS NULL`) | Elevation of Privilege (deleted/revoked entity remains accessible) | Phase 1 only adds the column; the filtering discipline is Phase 2+ service-layer responsibility (already flagged in DATA-03's requirement text: "all reads exclude soft-deleted rows") — out of scope for this phase's code, but the column must exist correctly-typed (`DateTime?`, nullable) for that future enforcement to be possible |

## Sources

### Primary (HIGH confidence)
- Prisma official docs — "Customizing Migrations" workflow page (fetched via WebFetch, full page content extracted): `--create-only` flag, manual SQL editing, explicit table-rename guidance
- Prisma official docs — "Prisma Schema API" reference page (fetched via WebFetch): `uuid()`/`uuid(4)`/`uuid(7)` argument syntax, `@db.Char`/`@db.VarChar`/`@db.Binary` native type attributes
- Prisma changelog, 2024-08-08, "Prisma ORM v5.18.0: native UUIDv7 support" — confirms v4 is the default, v7 requires explicit argument, and the version this landed in
- `prisma/migrations/20260616152601_init/migration.sql`, `prisma/migrations/20260617121303_add_refresh_tokens/migration.sql` — read directly from this repo; ground-truth confirmation that `refresh_tokens` is already correctly named and only `User` needs a rename

### Secondary (MEDIUM confidence)
- Prisma docs — "Manage relations between records with relation modes" (WebSearch-summarized, official domain): `relationMode = "prisma"` behavior, manual-index requirement for emulated FKs
- MariaDB Server documentation — "UUID Data Type" and "JSON Data Type" pages (WebSearch-summarized, official domain): MariaDB 10.7+ native UUID availability, MariaDB's `JSON` = `LONGTEXT COLLATE utf8mb4_bin` alias behavior
- `prisma/prisma` GitHub issues #28143, #28168 (closed, fixed by PR #28211 in Prisma 6.17.0) — MariaDB adapter JSON-handling regression, confirmed fixed well before this project's pinned 7.8.0
- `prisma/prisma` GitHub issue #29023 (open, unconfirmed as of research date) — Prisma v7 + MariaDB 10.11+ JSON-casting introspection/Studio syntax error, fetched via WebFetch for full issue detail (error text, affected versions, scope)
- `prisma/prisma` GitHub issue #11414 — confirms no binary-native `uuid()` generator exists in Prisma as of this research

### Tertiary (LOW confidence)
- General MySQL/MariaDB UUID storage performance articles (emmer.dev, PingCAP, PlanetScale, MariaDB rjweb doc) — WebSearch only, used only to corroborate the well-established `BINARY(16)` vs `CHAR(36)` storage-size trade-off, not relied upon for any Prisma-specific mechanics

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; existing pinned versions independently confirmed current via `npm view`
- Architecture (schema patterns, uuid(7), rename workflow): HIGH — verified against official Prisma docs pages (full content fetched, not just search snippets) and this repo's own migration files
- MariaDB-adapter-specific caveats (Pitfalls 3 & 4): MEDIUM — sourced from GitHub issues and MariaDB's own docs (not fetched via Context7, which was unavailable this session), cross-checked for currency (fix versions vs. this project's pinned version) but not independently reproduced against this project's actual MariaDB instance
- Pitfalls (general): HIGH — each pitfall traces to a specific, dated, sourced claim, not general knowledge

**Research date:** 2026-07-02
**Valid until:** 2026-08-01 (30 days — Prisma ships frequently; re-verify version-pinned claims, especially issue #29023's status, if planning is delayed past this window)
