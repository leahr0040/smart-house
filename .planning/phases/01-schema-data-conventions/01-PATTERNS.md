# Phase 1: Schema & Data Conventions - Pattern Map

**Mapped:** 2026-07-02
**Files analyzed:** 3 (schema, migration set, client seam) — schema-only phase, no application code
**Analogs found:** 2 exact (schema conventions), 1 partial (client seam), 3 no-analog (flagged, use RESEARCH.md)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `prisma/schema.prisma` (add House/Room/Device/Command/CommandTarget/4 state tables/events) | model/schema | CRUD | `prisma/schema.prisma` — existing `RefreshToken` model | exact (snake_case `@map`/`@@map`/`@@index` convention) |
| `prisma/schema.prisma` (widen `User`/`RefreshToken` PK+FK Int→BigInt, add `@@map("users")` + `deleted_at`) | model/schema | CRUD | `prisma/schema.prisma` — existing `User` model | exact (rename/widen target itself) |
| `prisma/migrations/<ts>_rename_user_to_users/migration.sql` (hand-authored) | migration | batch/DDL | `prisma/migrations/20260616152601_init/migration.sql` | role-match (shows original `User` table shape to rename from) |
| `prisma/migrations/<ts>_widen_pk_to_bigint/migration.sql` (hand-authored) | migration | batch/DDL | `prisma/migrations/20260617121303_add_refresh_tokens/migration.sql` | role-match (shows current `INTEGER AUTO_INCREMENT` column defs being widened) |
| `prisma/migrations/<ts>_add_domain_schema/migration.sql` (generated, not hand-edited) | migration | batch/DDL | same two existing migration files | role-match (plain `CREATE TABLE` pattern, no widen risk) |
| `src/lib/prisma.ts` (Phase 2 lands `$extends` NanoID seam here — Phase 1 does not touch it) | service/singleton | CRUD | `src/lib/prisma.ts` (itself, unchanged this phase) | exact — just noting the seam, no edit in Phase 1 |

## Pattern Assignments

### `prisma/schema.prisma` — new domain models (House, Room, Device, Command, CommandTarget, 4 state tables, Event)

**Analog:** existing `RefreshToken` model (lines 25-36) for the snake_case mapping convention; RESEARCH.md Patterns 2/3/4 for the BigInt/NanoID/dual-id shapes (no in-repo analog for those three concerns — see "No Analog Found" below).

**Snake_case convention to replicate** (`prisma/schema.prisma:25-36`):
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
Take from this: camelCase Prisma field name + `@map("snake_case")` on every column that isn't already snake_case-identical; `@@map("table_name")` on the model; `@@index([fkField])` on denormalized FK columns. **Do not** copy the `@relation(fields: ..., references: ...)` line for any new denormalized FK (`user_id` on Room/Device/Command, morph columns) — `relationMode = "prisma"` (schema.prisma:11) means these are declared as **plain scalar columns**, no `@relation`, per DATA-02 and the "no `@relation` on the morph" anti-pattern in RESEARCH.md.

**PK shape — widen the existing `User` pattern rather than copy it as-is** (`prisma/schema.prisma:15-16`, current):
```prisma
model User {
  id        Int      @id @default(autoincrement())
```
New target shape for every new table's PK (all 10 new models) and the widened `User`/`RefreshToken`:
```prisma
id BigInt @id @default(autoincrement())
```
RESEARCH.md Pattern 3 gives the full worked example (`Device` model, lines 278-296 of 01-RESEARCH.md) — copy that shape verbatim for structural fields (denorm `userId BigInt @map("user_id")`, morph `stateType`/`stateId`, `deletedAt`/`createdAt`/`updatedAt`).

**public_id column (House/Room/Device/Command only)** — no in-repo analog; use RESEARCH.md Pattern 2/3 verbatim:
```prisma
publicId String @unique @map("public_id") @db.VarChar(21)
```

**events dual-id shape** — no in-repo analog; use RESEARCH.md Pattern 4 verbatim (`01-RESEARCH.md:304-321`):
```prisma
model Event {
  id         BigInt    @id @default(autoincrement())
  eventId    String    @unique @map("event_id") @db.Char(36)
  entityType String    @map("entity_type")
  ...
  @@map("events")
  @@index([deviceId, recordedAt])
}
```
And the `last_event_id` back-reference on each state table (`01-RESEARCH.md:323-337`, `LightState` example) — `lastEventId BigInt? @map("last_event_id")` referencing `events.id`, never `event_id`.

---

### `prisma/migrations/<ts>_rename_user_to_users/migration.sql`

**Analog:** `prisma/migrations/20260616152601_init/migration.sql` (shows the exact current `User` table definition being renamed away from — column names, types, indexes, charset, all must survive the rename unchanged).

**Current shape to rename FROM** (full file, `prisma/migrations/20260616152601_init/migration.sql:1-12`):
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
Target hand-edit (per RESEARCH.md Pattern 1, `01-RESEARCH.md:219-224`):
```sql
ALTER TABLE `User` RENAME TO `users`;
ALTER TABLE `users` ADD COLUMN `deleted_at` DATETIME(3) NULL;
```
Confirmed: `refresh_tokens` needs **no** rename — `20260617121303_add_refresh_tokens/migration.sql` already creates `refresh_tokens` directly (table name matches `@@map` from day one).

---

### `prisma/migrations/<ts>_widen_pk_to_bigint/migration.sql`

**Analog:** `prisma/migrations/20260617121303_add_refresh_tokens/migration.sql` (full file, current `INTEGER AUTO_INCREMENT` / `INTEGER NOT NULL` column defs being widened):
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
Target hand-verified widen SQL (RESEARCH.md Pattern 1b, `01-RESEARCH.md:236-240` — copy verbatim, must restate every existing attribute including `AUTO_INCREMENT`, per Pitfall 2):
```sql
ALTER TABLE `users` MODIFY COLUMN `id` BIGINT NOT NULL AUTO_INCREMENT;
ALTER TABLE `refresh_tokens` MODIFY COLUMN `id` BIGINT NOT NULL AUTO_INCREMENT;
ALTER TABLE `refresh_tokens` MODIFY COLUMN `user_id` BIGINT NOT NULL;
```
Post-check per RESEARCH.md Pitfall 2: run `SHOW CREATE TABLE users;` to confirm `AUTO_INCREMENT` survived.

---

### `prisma/migrations/<ts>_add_domain_schema/migration.sql`

**Analog:** same two existing migration files, purely for the `CREATE TABLE ... DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` boilerplate Prisma will auto-generate — this migration should NOT be hand-edited (RESEARCH.md: "pure CREATE TABLE, zero risk"). Let `prisma migrate dev` generate it from the schema.prisma models directly; no manual SQL authoring needed here, unlike the two migrations above.

---

## Shared Patterns

### Snake_case mapping convention
**Source:** `prisma/schema.prisma:25-36` (`RefreshToken` model)
**Apply to:** every new model — camelCase Prisma fields, `@map("snake_case")` per column, `@@map("table_name")` per model.

### No `@relation` on denormalized/morph FKs
**Source:** `datasource db { relationMode = "prisma" }` at `prisma/schema.prisma:9-13`; confirmed no `FOREIGN KEY` clause in either existing migration.sql.
**Apply to:** `user_id` on Room/Device/Command, `house_id` on Room, `room_id`/`state_type`/`state_id` on Device, `device_id` on state tables, `device_id`/`command_id` on Event — all plain scalar columns with `@@index`, never `@relation`.

### Hand-authored migration workflow (`--create-only` + manual SQL edit)
**Source:** RESEARCH.md Patterns 1 and 1b (official Prisma "Customizing Migrations" workflow)
**Apply to:** the rename migration and the widen migration only — never the additive domain-schema migration.

### BigInt PK / no native enums / no DB JSON except events.snapshot
**Source:** RESEARCH.md Patterns 3, D-06, D-07 (no in-repo precedent — this is a net-new convention for the codebase)
**Apply to:** all 10 new models (`BigInt @id @default(autoincrement())`); all status/type/mode columns as plain `String` (Command.status, events.entity_type/device_type/event_kind/source, ac_states.mode); `events.snapshot` as `Json`, every other detail table stays JSON-free.

## No Analog Found

| File/Concern | Role | Data Flow | Reason |
|---|---|---|---|
| `public_id String @unique @db.VarChar(21)` (House/Room/Device/Command) | model column | CRUD | No existing external-identifier column in the repo (User/RefreshToken have no such concept) — use RESEARCH.md Pattern 2/3 verbatim. |
| `events` dual-id (`id` BigInt + `event_id` uuidv5 Char(36)) | model | event-driven/append-only | No append-only/event-log table exists yet — use RESEARCH.md Pattern 4 verbatim. |
| `src/lib/prisma.ts` `$extends` NanoID generation seam | service/singleton | CRUD | Not built this phase (Phase 2) — no query-extension pattern exists anywhere in the current codebase to copy from; RESEARCH.md Pattern 2's illustrative `$extends` snippet is the only reference, and it is explicitly non-normative/illustrative until Phase 2. |

## Metadata

**Analog search scope:** `prisma/schema.prisma`, `prisma/migrations/**/migration.sql`, `src/lib/prisma.ts` (only DB-schema-adjacent files exist in this repo — no other models/migrations/services touch schema conventions)
**Files scanned:** 4 (schema.prisma, 2 migration.sql files, prisma.ts)
**Pattern extraction date:** 2026-07-02
