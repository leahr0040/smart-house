# Phase 1: Schema & Data Conventions - Pattern Map

**Mapped:** 2026-07-02
**Files analyzed:** 1 modified schema file (10 new models + 1 modified model) + migration files
**Analogs found:** 1 primary in-repo analog (`RefreshToken`) covers all new models; RESEARCH.md Code Examples supplement for model-specific fields not yet demonstrated in-repo.

This is a **schema-only phase** — there is no controller/service/component code to write. The single file modified is `prisma/schema.prisma`; the single new file category is hand-authored migration SQL under `prisma/migrations/`. Every "file classification" below is really a **model** within that one file, but each is classified separately because each has a distinct data-shape role the planner will scaffold independently.

## File Classification

| New/Modified Model (all in `prisma/schema.prisma`) | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `User` (add `@@map("users")`, `deletedAt`) | model | CRUD | `RefreshToken` (existing `@@map`/`@map` usage in same file) | exact (convention), self (structural — only additive columns) |
| `House` | model | CRUD | `RefreshToken` | role-match (simple root entity w/ FK + soft-delete convention, no direct analog for `address`/optional fields — see RESEARCH.md Code Examples) |
| `Room` | model | CRUD | `RefreshToken` + `House` (once authored) | role-match (child entity with two denorm FKs) |
| `Device` | model | CRUD + polymorphic morph | `RefreshToken` (map convention only) | partial (morph discriminator pattern has no in-repo precedent; RESEARCH.md Pattern 3 is the analog) |
| `Command` | model | CRUD (state-machine status column) | `RefreshToken` (map convention, plus `status`-like plain-string precedent nowhere in repo) | partial |
| `CommandTarget` | model | CRUD (fan-out targets) | `RefreshToken` (FK denorm shape: `commandId`/`deviceId` mirrors `RefreshToken.userId`) | role-match |
| `LightState` / `AcState` / `HeaterState` / `SensorState` (the 4 morph detail tables) | model | CRUD (1:1 morph target) | `RefreshToken` (map convention + nullable optional column shape via `revokedAt`) | role-match |
| `Event` (`events` table) | model | event-driven / append-only log | `RefreshToken` (closest existing "record with timestamps + FK, no update after create" shape) | partial (append-only + JSON snapshot has no in-repo precedent; RESEARCH.md Pattern 4 is the analog) |
| `prisma/migrations/<ts>_rename_user_to_users/migration.sql` | migration | schema DDL (destructive-diff avoidance) | `prisma/migrations/20260616152601_init/migration.sql` (shows current `User` table DDL — the rename source) | exact (source-of-truth for what must be preserved) |
| `prisma/migrations/<ts>_add_domain_schema/migration.sql` | migration | schema DDL (additive) | `prisma/migrations/20260617121303_add_refresh_tokens/migration.sql` (shows the additive `CREATE TABLE` + snake_case + `UNIQUE INDEX`/`PRIMARY KEY` shape Prisma emits for a mapped model) | exact |

## Pattern Assignments

### `User` model edit (add `@@map`, `deletedAt`)

**Analog:** `prisma/schema.prisma` lines 15-23 (current `User`) + `RefreshToken` lines 25-36 (demonstrates the `@map`/`@@map` convention `User` is missing)

**Current state** (`prisma/schema.prisma:15-23`):
```prisma
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  password  String
  name      String?
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  refreshTokens RefreshToken[]
}
```

**Target state** (per RESEARCH.md Pattern 1, DATA-01/DATA-03):
```prisma
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  password  String
  name      String?
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")
  refreshTokens RefreshToken[]

  @@map("users")
}
```

Note: `id`/`email`/`password`/`name` stay `Int`/unmapped-camelCase-matches-lowercase — no `@map` needed on columns that are already valid snake_case single words (`email`, `password`, `name`, `id`). Only compound-word columns and the table name need mapping — this mirrors `RefreshToken`, where `id`, `email`-equivalent fields (`tokenHash`) *do* need `@map("token_hash")` because they're camelCase compounds, but `id` does not.

---

### `RefreshToken` model (no schema change — read only for `@@map` convention)

**Source of the convention to replicate** (`prisma/schema.prisma:25-36`):
```prisma
model RefreshToken {
  id        Int       @id @default(autoincrement())
  tokenHash String    @unique @map("token_hash")
  userId    Int       @map("user_id")
  user      User      @relation(fields: [userId], references: [id])
  expiresAt DateTime  @map("expires_at")
  revokedAt DateTime? @map("revoked_at")
  createdAt DateTime  @default(now()) @map("created_at")

  @@map("refresh_tokens")
  @@index([userId])
}
```

**What every new model must copy from this:**
1. `@@map("<snake_case_plural_table_name>")` at the model level.
2. `@map("<snake_case_column_name>")` on every camelCase compound field (`userId` → `user_id`, `tokenHash` → `token_hash`, `expiresAt` → `expires_at`, `revokedAt` → `revoked_at`).
3. `@@index([userId])` — an **explicit** index on every denormalized FK-like column, required because `relationMode = "prisma"` (datasource block, `prisma/schema.prisma:11`) does not auto-create FK indexes the way native relations would.
4. Nullable optional columns (`revokedAt DateTime?`) use the same `Type? @map(...)` shape the four state tables' `lastEventAt`/`lastEventId` and `deletedAt` columns need.
5. `createdAt DateTime @default(now()) @map("created_at")` is the canonical creation-timestamp pattern — reuse verbatim on every new model.

**Do NOT copy:** `RefreshToken.user` is a declared `@relation` — new models must **not** declare `@relation` on the `Device`→state-table morph (RESEARCH.md Anti-Patterns) or on any denormalized `user_id`/FK column where the schema decision is "plain column, no relation" (DATA-02). Only declare `@relation` where CONTEXT.md/RESEARCH.md explicitly calls for a real FK relation (none of the new morph/denorm columns do).

---

### New PK convention — every new model (House, Room, Device, Command, CommandTarget, 4 state tables, Event)

**Source:** RESEARCH.md Pattern 2 (no in-repo analog exists yet — `User`/`RefreshToken` PKs are `Int @default(autoincrement())`, which is explicitly NOT the pattern for new models per the locked decision).

```prisma
id String @id @default(uuid(7)) @db.Char(36)
```

**Critical gate (flagged by RESEARCH.md Pitfall 1):** grep the finished schema for `@default(uuid())` with no argument — every occurrence must be `uuid(7)`. This applies to every new model's `id` plus `Event.eventId` and every state table's `lastEventId`.

---

### `House` (new model)

**Analog:** RESEARCH.md Code Examples (no closer in-repo analog — first "root entity with optional metadata + soft delete" in this codebase)

```prisma
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
```
Note: `userId` is `String @db.Char(36)` here because it denormalizes from... actually `House.userId` denormalizes from the `User.id` which is `Int @default(autoincrement())` — **planner must verify this type mismatch** against RESEARCH.md's example (which assumes all-UUID actors). Confirm during planning whether `House.userId`/`Room.userId`/`Device.userId`/`Command.userId` should be `Int` (matching the existing `User.id` type) rather than `String @db.Char(36)` as RESEARCH.md's generic example shows — this is a cross-cutting correctness issue for DATA-02 across all four models that denormalize `user_id`.

---

### `Room` (new model)

**Analog:** RESEARCH.md Code Examples + `House` (once authored, same file)

```prisma
model Room {
  id        String    @id @default(uuid(7)) @db.Char(36)
  houseId   String    @map("house_id") @db.Char(36)
  userId    String    @map("user_id") @db.Char(36)   // DATA-02 denorm — verify type vs User.id, see House note above
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
```

---

### `Device` (new model, polymorphic morph)

**Analog:** RESEARCH.md Pattern 2/3 (no in-repo morph precedent)

```prisma
model Device {
  id           String    @id @default(uuid(7)) @db.Char(36)
  userId       String    @map("user_id") @db.Char(36)   // verify type, see House note
  roomId       String    @map("room_id") @db.Char(36)
  name         String
  deviceType   String    @map("device_type")             // D-06: app-validated, not DB enum
  manufacturer String?
  model        String?
  stateType    String?   @map("state_type")               // morph discriminator, no @relation
  stateId      String?   @map("state_id") @db.Char(36)     // morph target id, no FK
  deletedAt    DateTime? @map("deleted_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  @@map("devices")
  @@index([userId])
  @@index([roomId])
}
```
**Anti-pattern reminder:** do NOT declare `@relation` between `Device` and the four state tables — a single `stateType`/`stateId` pair can't target four different models with Prisma's relation syntax (RESEARCH.md Anti-Patterns).

---

### `Command` / `CommandTarget` (new models, status state-machine)

**Analog:** RESEARCH.md Code Examples

```prisma
model Command {
  id        String    @id @default(uuid(7)) @db.Char(36)
  userId    String    @map("user_id") @db.Char(36)   // verify type, see House note
  status    String    @default("received")            // D-06: plain String, app-validated vocabulary
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")

  @@map("commands")
  @@index([userId])
}

model CommandTarget {
  id          String    @id @default(uuid(7)) @db.Char(36)
  commandId   String    @map("command_id") @db.Char(36)
  deviceId    String    @map("device_id") @db.Char(36)
  status      String    @default("pending")
  deadlineAt  DateTime  @map("deadline_at")
  createdAt   DateTime  @default(now()) @map("created_at")

  @@map("command_targets")
  @@index([commandId])
  @@index([deviceId])
}
```

---

### Four state detail tables: `LightState`, `AcState`, `HeaterState`, `SensorState`

**Analog:** RESEARCH.md Pattern 3 (`LightState` fully worked example) + Code Examples (`SensorState` decimal precision)

**LightState** (RESEARCH.md Pattern 3, verbatim):
```prisma
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

**AcState** (D-02, apply same shape as LightState, swap columns):
```prisma
model AcState {
  id           String    @id @default(uuid(7)) @db.Char(36)
  deviceId     String    @map("device_id") @db.Char(36)
  isOn         Boolean   @map("is_on") @default(false)
  targetTemp   Int       @map("target_temp") @default(0)
  mode         String    @default("auto")   // D-06: plain String, not DB enum
  lastEventAt  DateTime? @map("last_event_at")
  lastEventId  String?   @map("last_event_id") @db.Char(36)
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  @@map("ac_states")
  @@index([deviceId])
}
```

**HeaterState** (D-03, same shape minus `mode`):
```prisma
model HeaterState {
  id           String    @id @default(uuid(7)) @db.Char(36)
  deviceId     String    @map("device_id") @db.Char(36)
  isOn         Boolean   @map("is_on") @default(false)
  targetTemp   Int       @map("target_temp") @default(0)
  lastEventAt  DateTime? @map("last_event_at")
  lastEventId  String?   @map("last_event_id") @db.Char(36)
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  @@map("heater_states")
  @@index([deviceId])
}
```

**SensorState** (D-04, RESEARCH.md Code Examples verbatim):
```prisma
model SensorState {
  id          String    @id @default(uuid(7)) @db.Char(36)
  deviceId    String    @map("device_id") @db.Char(36)
  reading     Decimal   @db.Decimal(6, 2)
  unit        String
  lastEventAt DateTime? @map("last_event_at")
  lastEventId String?   @map("last_event_id") @db.Char(36)
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  @@map("sensor_states")
  @@index([deviceId])
}
```

**Open question the planner should resolve (RESEARCH.md Open Questions #2):** whether `@@unique([deviceId])` should be added to each of the four state tables to enforce 1:1 cardinality at the DB level. Recommendation in RESEARCH.md leans yes (structural, not value-range, so it doesn't conflict with the "no DB constraints on values" philosophy).

---

### `Event` (`events` table, append-only)

**Analog:** RESEARCH.md Pattern 4 (no in-repo append-only-log precedent; `RefreshToken` only contributes the map-convention/timestamp shape, not the JSON/append-only semantics)

```prisma
model Event {
  eventId    String    @id @default(uuid(7)) @map("event_id") @db.Char(36)
  entityType String    @map("entity_type")                 // D-06: "device" | "command", app-validated
  source     String                                          // app-validated vocabulary
  eventKind  String    @map("event_kind")                    // app-validated vocabulary
  deviceId   String?   @map("device_id") @db.Char(36)        // null for command-lifecycle rows
  deviceType String?   @map("device_type")
  commandId  String?   @map("command_id") @db.Char(36)
  snapshot   Json                                             // D-07: native JSON, scoped exception to "no JSON" rule
  recordedAt DateTime  @map("recorded_at")                   // producer-minted event time, NOT createdAt/updatedAt

  @@map("events")
  @@unique([eventId])
  @@index([deviceId, recordedAt])
}
```
Note: this model has **no `createdAt`/`updatedAt`** — it's append-only and `recordedAt` is the producer-minted timestamp of record (per DATA-04/EVENT-01), not an ORM-managed audit timestamp. Don't copy the `createdAt @default(now())` convention here — that's the one place it should be deliberately omitted.

---

### Migration: rename `User` → `users`

**Analog:** `prisma/migrations/20260616152601_init/migration.sql` (shows exact current DDL of the `User` table that must survive the rename) + RESEARCH.md Pattern 1 (the documented `--create-only` + hand-edit workflow)

**Current live DDL** (`prisma/migrations/20260616152601_init/migration.sql:1-12`):
```sql
CREATE TABLE `User` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(191) NOT NULL,
    `password` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

**Hand-edit target** (do NOT let `prisma migrate dev --create-only` apply its default `DROP`/`CREATE`):
```sql
ALTER TABLE `User` RENAME TO `users`;
ALTER TABLE `users` ADD COLUMN `deleted_at` DATETIME(3) NULL;
```

Workflow: `npx prisma migrate dev --name rename_user_to_users --create-only`, inspect the generated draft, replace the destructive DROP+CREATE with the two lines above, then `npx prisma migrate dev` to apply.

---

### Migration: additive domain schema (House/Room/Device/Command/state tables/events)

**Analog:** `prisma/migrations/20260617121303_add_refresh_tokens/migration.sql` — this is the template for what Prisma will auto-generate correctly (no hand-editing needed) for every purely-additive `CREATE TABLE`:
```sql
CREATE TABLE `refresh_tokens` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `token_hash` VARCHAR(191) NOT NULL,
    `user_id` INTEGER NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `refresh_tokens_token_hash_key`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```
Because none of the 10 new models rename an existing table, this migration can be generated normally with `npx prisma migrate dev --name add_domain_schema` (no `--create-only`/hand-edit needed) — Prisma's diffing only becomes destructive/ambiguous for renames of already-live tables, not brand-new `CREATE TABLE` statements. Run this as a **second, separate** migration after the rename migration is applied (RESEARCH.md's explicit recommendation: isolates risky hand-edited SQL from mechanical additive SQL).

---

## Shared Patterns

### snake_case `@map`/`@@map` convention
**Source:** `prisma/schema.prisma:25-36` (`RefreshToken`)
**Apply to:** every new model and the `User` edit.
```prisma
@@map("<snake_case_table>")
// and per-column:
fieldName Type @map("field_name")
```

### Explicit index on every denormalized FK / morph back-link
**Source:** `prisma/schema.prisma:35` (`@@index([userId])` on `RefreshToken`), reinforced by RESEARCH.md ("you must add indexes on foreign keys manually" under `relationMode = "prisma"`)
**Apply to:** every `userId`, `houseId`, `roomId`, `deviceId`, `commandId` column on every new model, plus `Event`'s `(deviceId, recordedAt)` compound index.

### uuid v7 PK convention (new, no in-repo precedent yet — first use in this phase)
**Source:** RESEARCH.md Pattern 2
**Apply to:** every new model's primary key and `Event.eventId`/state tables' `lastEventId`.
```prisma
id String @id @default(uuid(7)) @db.Char(36)
```
**Gate:** grep for bare `@default(uuid())` before finalizing — must not appear anywhere in the new schema additions.

### No DB enums / no CHECK / no min-max
**Source:** CONTEXT.md D-06 (locked user decision), reinforced by RESEARCH.md Anti-Patterns
**Apply to:** `Command.status`, `CommandTarget.status`, `ac_states.mode`, `Device.deviceType`, `Event.entityType`/`eventKind`/`source`/`deviceType` — all plain `String` columns, all with app-layer (TypeBox) validation only.

### Soft delete column shape
**Source:** RESEARCH.md Pattern 1 (`deletedAt DateTime? @map("deleted_at")`)
**Apply to:** `User`, `House`, `Room`, `Device` only (per DATA-03 — state tables, `Command`, `CommandTarget`, `Event` are NOT soft-deletable per the requirements).

### JSON scoped exception
**Source:** CONTEXT.md D-07
**Apply to:** `Event.snapshot` only — the one and only `Json`-typed column in the entire schema; do not use `Json` on any current-state detail table.

## No Analog Found

| File/Model | Role | Data Flow | Reason |
|------------|------|-----------|--------|
| `Event` (append-only, JSON snapshot) | model | event-driven | No append-only/audit-log table exists in the codebase yet; RESEARCH.md Pattern 4 is the only reference, not a real in-repo file |
| `Device` (polymorphic morph columns) | model | CRUD + morph resolution (future) | No polymorphic/discriminator pattern exists elsewhere in the codebase; RESEARCH.md Pattern 3 is the only reference |
| Hand-authored rename migration SQL | migration | schema DDL | No prior rename migration exists in `prisma/migrations/` — both existing migrations are `CREATE TABLE` only; RESEARCH.md Pattern 1 (official Prisma docs workflow) is the reference, not an in-repo precedent |

## Metadata

**Analog search scope:** `prisma/schema.prisma`, `prisma/migrations/*/migration.sql`, `src/lib/prisma.ts`
**Files scanned:** 4 (schema file, 2 migration.sql files, prisma client singleton)
**Pattern extraction date:** 2026-07-02
