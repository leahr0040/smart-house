# Phase 1: Schema & Data Conventions - Research (REVISED — id strategy)

**Researched:** 2026-07-02
**Domain:** Prisma ORM schema design on MariaDB (driver-adapter pattern) — BigInt autoincrement PKs, Int→BigInt column widening, app-side NanoID generation seam, dual-id append-only event log (BigInt ordering key + uuidv5 idempotency key)
**Confidence:** HIGH (Prisma/MySQL mechanics, migration workflow, widen-safety) / MEDIUM (MariaDB-adapter-specific quirks — no Context7/doc-provider access this session, all search-provider flags are `false` in `.planning/config.json`, so findings are WebSearch/WebFetch + direct repo/registry verification)

**This is a re-plan.** The prior research pass (commit `0a7de7c`, superseded by `aa45a85`) researched a `uuid v7` PK strategy that CONTEXT.md has since replaced. That prior document is retained in git history for reference; sections below that are unaffected by the id-strategy change (rename-migration mechanics, morph pattern, JSON snapshot, Decimal precision, relationMode=prisma indexing rule) are carried forward and re-verified; everything about `uuid(7)`/`BINARY(16)`/`CHAR(36)` PK storage is dropped as obsolete per the new CONTEXT.md.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Identifier strategy (revised 2026-07-02 — supersedes the earlier "uuid v7 PKs" decision)**
- **D-11:** Every table uses a `BigInt @default(autoincrement())` internal PK (`id`). The existing `User`/`RefreshToken` PKs (and `refresh_tokens.user_id` FK) widen Int→BigInt so all FKs are uniform integers — this also dissolves the earlier `User.id`-Int-vs-`Char(36)` denorm type mismatch. External, non-enumerable identity is a NanoID `public_id` (`@unique`) on **user-facing entities only** — House, Room, Device, Command. CommandTarget, the four state tables, and `events` have no `public_id` (addressed internally). NanoID has no Prisma native default → generated app-side at create time; Phase 1 shapes the `@unique` column (sized for a 21-char NanoID), the generator lands in Phase 2. Motivation: compact 8-byte keys/indexes on the hot append-only `events` table; non-enumerable external IDs preserved via `public_id`.
- **D-12 (events ids):** `events` gets a BigInt `id` PK — the ordering key: cursor `(recorded_at, id)` and the target referenced by `last_event_id` — **plus** the deterministic `event_id` uuidv5 (idempotency) already locked in PROJECT.md. Ordering never compares the uuidv5. No `@default(uuid())` anywhere, so the former uuid-v7-vs-v4 adapter spike is dropped.

**Per-type state detail columns** — no DB-level enums, CHECK constraints, or min/max; every value/range/vocabulary rule enforced in the TypeBox app layer.
- **D-01 `light_states`:** `is_on` (Boolean), `brightness` (Int) — no 0–100 DB constraint.
- **D-02 `ac_states`:** `is_on` (Boolean), `target_temp` (Int), `mode` (String — plain column).
- **D-03 `heater_states`:** `is_on` (Boolean), `target_temp` (Int).
- **D-04 `sensor_states`:** `reading` (Decimal), `unit` (String).
- **D-05:** Every detail table also carries `last_event_at` (DateTime, nullable) and `last_event_id` (BigInt, nullable — references `events.id`) for the tuple guard, plus the morph back-link to the owning device. Rows are created eagerly at device creation with defaults (STATE-01, delivered in Phase 2; columns/defaults shaped here).

**Enum representation (no native DB enums)**
- **D-06:** `Command.status`, `events.entity_type`, `events.device_type`, `events.event_kind`, `events.source`, `ac_states.mode` are all plain `String` columns validated in TypeBox, not Prisma/MySQL native enums.

**Event snapshot format**
- **D-07:** `events.snapshot` is a native MariaDB JSON column holding the effect/report payload verbatim. The "no JSON column" rule is scoped to queryable current-state detail tables only — the append-only audit log is explicitly exempt.

**Entity metadata (non-state columns)**
- **D-08 House:** `address` (String, optional). Timezone stays v2 (HOUSE-06).
- **D-09 Room:** `floor` (Int, default 0) and `room_type` (String, optional free-text label).
- **D-10 Device:** `manufacturer` (String, optional) and `model` (String, optional). `device_type` is a validated `String` (per D-06).

### Claude's Discretion
- **NanoID `public_id` generation seam** (app-side): recommend a Prisma client `query` extension on create vs. minting in each `createX` service. The *generator* lands in Phase 2; Phase 1 only shapes the `@unique` column. Also confirm the NanoID column type/length under the MariaDB adapter — resolved below (Standard Stack / Architecture Patterns).
- **Per-device limits/config surface:** not modeled as DB columns/enums in v1; limits live in the TypeBox action registry (`src/lib/device-actions.ts`).
- **Exact Prisma decimal precision** for `sensor_states.reading` / temps — resolved below (Standard Stack) with sensible defaults, carried forward unchanged from the prior research pass.

### Deferred Ideas (OUT OF SCOPE)
- Per-device limits/config as DB columns or a config table — deferred; limits stay in the TypeBox action registry for v1.
- House timezone — v2 (HOUSE-06); `address` only in v1.
- Additional room/device metadata beyond the chosen fields — add per real need; not modeled speculatively.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DATA-01 | All DB tables/columns snake_case via `@map`/`@@map`, including existing `User`/`RefreshToken`; existing-table rename uses hand-authored `ALTER TABLE … RENAME` migration | "Hand-Authored Rename Migration" pattern + Runtime State Inventory — `refresh_tokens` is *already* correctly named live; only `User` needs the rename. The rename and the Int→BigInt widen are sequenced as two separate, independently-verifiable migrations (see Architecture Patterns, Pattern 1 and Pattern 1b). |
| DATA-02 | `user_id` denormalized onto Room, Device, Command; ownership checks use it directly | "Standard Stack" schema fields — denormalized FK modeled as a plain `BigInt` column, not a relation, under `relationMode = "prisma"` (no real FK constraint exists in the DB today — confirmed by reading the live migration SQL). |
| DATA-03 | Soft delete (`deleted_at`) on User, House, Room, Device; reads exclude soft-deleted; soft-deleted user cannot authenticate | `deleted_at DateTime? @map("deleted_at")`; app-layer filter convention (unchanged from prior research). |
| DATA-04 | Batched `IN` queries; tuple-guarded UPDATE; unique index on deterministic `event_id`; CAS target transitions; `SELECT … FOR UPDATE` roll-up; one transaction | Schema-only in Phase 1 — this phase lays the indexes/columns (`@@unique([eventId])` on the uuidv5 string, `(last_event_at, last_event_id)` BigInt columns, `@@index([deviceId, recordedAt])`) that DATA-04's runtime logic (Phase 4/6) depends on. The **ordering** key (`id` BigInt) and the **idempotency** key (`event_id` uuidv5 String) are two distinct columns — see D-12 and Pattern 4. |
</phase_requirements>

## Summary

Phase 1 is a pure schema/migration phase: no application logic, no new npm dependencies actually *installed* this phase (NanoID/uuidv5 packages are referenced for forward compatibility but their generators land in Phase 2/5). The work is: (1) extend `prisma/schema.prisma` with House, Room, Device, Command, CommandTarget, four per-type state detail tables, and the append-only `events` table, all snake_case-mapped, all with `BigInt @default(autoincrement())` PKs; (2) widen the existing `User.id`, `RefreshToken.id`, and `refresh_tokens.user_id` columns from `Int` to `BigInt`; (3) hand-author a `RENAME TABLE` migration for the existing un-mapped `User` model (`refresh_tokens` is already correctly named — confirmed by reading its migration SQL directly, no rename needed there); (4) shape (not populate) a `@unique` NanoID `public_id` column on House/Room/Device/Command, sized `VarChar(21)`; (5) shape the `events` table's dual-id design — BigInt `id` (ordering/cursor/`last_event_id` target) plus a separate uuidv5 `event_id` String column (`@unique`, idempotency, never used for ordering); (6) run `prisma migrate dev`, `npm run build`, `npm test` to green.

The single most load-bearing finding from this research: **the Int→BigInt widen is a low-risk `ALTER TABLE … MODIFY COLUMN` operation on MySQL/MariaDB — fundamentally different from, and safer than, the analogous Postgres operation.** A known Prisma bug (`prisma/prisma#18532`) makes Prisma generate an *invalid* migration when widening Postgres `Int` (`SERIAL`) columns to `BigInt`, because Postgres's `BIGSERIAL` is a pseudotype that cannot appear in `ALTER COLUMN ... SET DATA TYPE`. **This bug is Postgres-specific** — MySQL/MariaDB has no equivalent pseudotype problem; `AUTO_INCREMENT` is a plain column attribute, so `ALTER TABLE users MODIFY id BIGINT NOT NULL AUTO_INCREMENT;` is valid, standard, lossless SQL that preserves both existing row data and the current auto-increment counter value `[CITED: MySQL/MariaDB ALTER TABLE reference — widening an integer column via MODIFY COLUMN is a documented, in-place, non-destructive operation]`. Nonetheless, `--create-only` + hand-verification is still recommended for this phase (not because MariaDB is known to be broken here, but because it is cheap insurance and this project's own working style already treats every touch of the live `User`/`refresh_tokens` tables as requiring hand-verification). Second load-bearing finding: because `relationMode = "prisma"` is already set and no real `FOREIGN KEY` constraint exists on `refresh_tokens.user_id` today (verified by reading `prisma/migrations/*/migration.sql` directly — only `PRIMARY KEY`/`UNIQUE INDEX`, no `FOREIGN KEY` clause), widening `User.id` and `refresh_tokens.user_id` are two **independent** column changes with no DB-level cascading-constraint complexity to worry about — a real concern on a database with enforced FKs, a non-issue here.

**Primary recommendation:** `BigInt @id @default(autoincrement())` for every table's internal `id`, no exceptions; widen `User.id`/`RefreshToken.id`/`refresh_tokens.user_id` via a **third**, isolated hand-verified migration (rename first, widen second, additive domain schema third — or widen+additive combined once the widen SQL is independently verified, see Pattern 1b); `public_id String @unique @db.VarChar(21)` on House/Room/Device/Command only, generated app-side via a **Prisma Client `$extends` query extension** (not per-service minting — see Pattern 3, rationale below); `events.id BigInt @id @default(autoincrement())` for ordering **plus** `events.event_id String @unique @db.Char(36)` for the uuidv5 idempotency key, with `last_event_id` on every state table typed `BigInt?` (referencing `events.id`, never the uuidv5); keep `events.snapshot` as native Prisma `Json`; `Decimal(6,2)` for `sensor_states.reading`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Schema/table definitions | Database / Storage | — | Phase 1 is entirely schema-tier; no API or client code touches these tables yet |
| Naming convention enforcement (`@map`/`@@map`) | Database / Storage | — | Prisma schema is the single source of truth for both the TS-facing model name and the SQL-facing table/column name |
| BigInt PK generation | Database / Storage | — | MariaDB's `AUTO_INCREMENT` mechanism generates the value at INSERT time — no app code involved |
| NanoID `public_id` generation | API / Backend (Phase 2+) | Database / Storage | The *column* is DB-tier (shaped now); the *generator* is an app-tier concern (Prisma Client extension or service-layer mint) because NanoID has no native DB/Prisma default — this is the one identity concern that is NOT purely schema-tier, flagged explicitly since it differs from the BigInt PK's DB-native generation |
| uuidv5 `event_id` generation | API / Backend (worker, Phase 5) | Database / Storage | The column (`@unique` String) is shaped now; the deterministic hash computation (`uuidv5(command_target_id [+ outcome], namespace)`) happens in the worker process, not the DB |
| Soft-delete column presence | Database / Storage | API / Backend (future) | Column lives in schema now; the *filtering* logic (`WHERE deleted_at IS NULL`) is Phase 2+ service-layer responsibility |
| Polymorphic morph columns (`state_type`/`state_id`) | Database / Storage | API / Backend (future) | Columns and per-type tables defined now; morph *resolution* logic is Phase 2/6 service-layer |
| Event append-only table (dual-id design) | Database / Storage | — | `events` table structure only; the write path (INSERT via consumer transaction) is Phase 6 |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `prisma` | 7.8.0 (pinned, matches package.json) [VERIFIED: npm registry — `npm view prisma version` re-confirmed this session] | Schema authoring + migration CLI | Already the project's ORM |
| `@prisma/client` | 7.8.0 [VERIFIED: npm registry] | Generated query client | Already in use |
| `@prisma/adapter-mariadb` | 7.8.0 [VERIFIED: npm registry] | Driver-adapter pattern for MariaDB connectivity | Already in use; project constraint |

No new packages are strictly required to complete Phase 1's acceptance bar (schema + migration only). Two packages are **referenced by this research for the columns Phase 1 shapes**, but their install/usage is deferred to later phases per CONTEXT.md:

| Library | Version | Purpose | When Installed |
|---------|---------|---------|-----------------|
| `nanoid` | 5.1.16 [ASSUMED — package name from training knowledge + WebSearch, registry existence alone does not confer VERIFIED status per provenance rule] | Generates the `public_id` value (21-char default alphabet) | Phase 2, when the create-time generation seam is implemented |
| `uuid` | 14.0.1 [ASSUMED — same provenance caveat; provides the `v5` export] | Generates the deterministic `event_id` (`uuidv5(name, namespace)`) | Phase 5 (worker) / Phase 6 (consumer double-check), when reports are minted |

Both names were cross-checked against the npm registry this session (`npm view nanoid version` → `5.1.16`, published 2026-06-24; `npm view uuid version` → `14.0.1`; neither package declares a `postinstall` script). Per the package-name-provenance rule, registry existence does not upgrade these to `[VERIFIED]` — only Context7/official-docs confirmation would. Treat both as `[ASSUMED]` until the planner/executor for Phase 2 and Phase 5 re-confirms at install time.

### Supporting
_None — no supporting libraries needed for Phase 1's schema-only scope._

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `BigInt @default(autoincrement())` for all new PKs | `String @default(uuid(7))` (the prior decision) | Rejected by the user in the revised CONTEXT.md — larger keys/indexes on the hot `events` table, and the `User.id`-Int-vs-`Char(36)`-denorm mismatch this new strategy explicitly dissolves. Documented here only to explain why the old research pass is obsolete. |
| App-side NanoID generation via Prisma `$extends` query extension | Minting `nanoid()` inline in every `createX` service function | Both work; the extension centralizes the generation seam in one place (`src/lib/prisma.ts` or a new `src/lib/prisma-extensions.ts`) so every model that needs a `public_id` gets it automatically on `create`, rather than requiring each of 4 future service files (House/Room/Device/Command) to remember to call `nanoid()` — see Pattern 3 for the recommended shape and why per-service minting is the fallback, not the primary recommendation. |
| `events.id BigInt` (ordering) + `events.event_id String uuidv5` (idempotency) as two columns | A single uuidv5 column serving both roles (the prior plan, before D-12) | Rejected by D-12: uuidv5 is not insertion-ordered (unlike uuid v7 or an autoincrement integer), so it cannot serve as a cursor/ordering key. Splitting the concerns means the ordering guarantee (`(recorded_at, id)`) is trivially correct on a plain BigInt, while the idempotency guarantee (`event_id` unique index) is independent of insertion order. |
| `Decimal(6,2)` for `sensor_states.reading` | `Float`/`Double` | Rejected (carried forward from prior research) — floating point introduces rounding artifacts on sensor readings that a fixed-point `Decimal` avoids; MariaDB's `DECIMAL` is exact, `Decimal(6,2)` covers ±9999.99, ample for temp/humidity/lux without DB-level range enforcement (per D-01…D-04, ranges are TypeBox's job). |

**Installation:**
No installation required this phase — schema-language features only (`BigInt`, `@default(autoincrement())`, `@unique`, `@db.VarChar`, `@db.Char`, `Json`, `Decimal`). `nanoid`/`uuid` installs are Phase 2/5 concerns, flagged here for forward visibility only.

**Version verification:** Confirmed via `npm view prisma version`, `npm view @prisma/client version`, `npm view @prisma/adapter-mariadb version` (all `7.8.0`, matching `package.json` and local `npx prisma --version` output) and `npx prisma migrate status` (confirms live connectivity to `smart_house` on `localhost:3306`, 2 migrations applied cleanly) — all re-verified this session, not carried over stale from the prior pass.

## Package Legitimacy Audit

**No new packages are installed by Phase 1 itself.** `nanoid` and `uuid` are referenced above because this phase's column-shaping decisions (`public_id VarChar(21)`, `event_id Char(36)`) depend on their output formats, but neither package is added to `package.json` in this phase — that happens in Phase 2 (`nanoid`) and Phase 5 (`uuid`). The audit below is provided **proactively** so the Phase 2/5 planner does not need to re-run it, but the actual `checkpoint:human-verify` gate (if any) belongs to whichever phase runs `npm install`.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `nanoid` | npm | Long-established (v3 popularized ~2020; this major v5 line active); latest `5.1.16` published 2026-06-24 [VERIFIED: npm registry — `npm view nanoid time.modified`] | Very high (tens of millions/week historically) | github.com/ai/nanoid | OK | Approved for Phase 2 install — re-verify at install time per provenance rule |
| `uuid` | npm | Long-established (pre-2015); latest `14.0.1` | Very high (tens of millions/week historically) | github.com/uuidjs/uuid | OK | Approved for Phase 5 install — re-verify at install time per provenance rule |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

*Both `nanoid` and `uuid` were discovered via WebSearch/training knowledge in this research session (not via Context7/official docs), so per the package-name provenance rule they remain `[ASSUMED]` in the Standard Stack table above despite the clean registry verdict here. The Phase 2 and Phase 5 planners should treat their install as a `checkpoint:human-verify` step out of caution, even though no red flags were found — this is a low-risk, well-known package, but the provenance rule applies uniformly.*

## Architecture Patterns

### System Architecture Diagram

```text
┌──────────────────────────────────────────────────────────────────────┐
│  prisma/schema.prisma  (single source of truth)                       │
│                                                                        │
│  User ──rename@@map──> users (Int→BigInt widen)   RefreshToken        │
│         (Int→BigInt widen)                        (already @@map'd,   │
│                                                     Int→BigInt widen,  │
│                                                     no rename needed)  │
│                                                                        │
│  House(BigInt id, public_id) ──user_id(denorm BigInt)──┐              │
│    └─ Room(BigInt id, public_id) ──user_id(denorm)──┐  │              │
│         └─ Device(BigInt id, public_id) ──user_id(denorm)──┐          │
│              │  state_type/state_id (morph, no FK)          │          │
│              ├──> light_states  ──last_event_at/id(BigInt?)─┤          │
│              ├──> ac_states     ──last_event_at/id(BigInt?)─┤          │
│              ├──> heater_states ──last_event_at/id(BigInt?)─┤          │
│              └──> sensor_states ──last_event_at/id(BigInt?)─┤          │
│                                                              │          │
│  Command(BigInt id, public_id) ──user_id(denorm)──> CommandTarget     │
│                                     (BigInt id, no public_id)         │
│                                     │ deadline_at                     │
│                                     ▼                                 │
│                              (Phase 4+ writes)                        │
│                                                       ▼                │
│                              events (append-only, JSON snapshot)       │
│                              id: BigInt @id @default(autoincrement()) │
│                                → ordering / cursor / last_event_id     │
│                              event_id: String @unique (uuidv5)         │
│                                → idempotency ONLY, never ordering      │
│                              entity_type: device|command (String)     │
│                              device_id: nullable                      │
│                              index: (device_id, recorded_at)          │
└──────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
      `prisma migrate dev` ──> hand-verified SQL ──> MariaDB
                          │
                          ▼
      `prisma generate` ──> src/generated/prisma/ (typed client, BigInt fields as JS `bigint`)
                          │
                          ▼
      `npm run build` (tsc) ──> `npm test` (existing auth tests, green)
```

This phase's data flow is entirely build-time: schema edits flow into migration SQL, migration SQL is hand-verified then applied, the client is regenerated, and the only runtime check is that the existing auth test suite still passes against the renamed+widened `users`/`refresh_tokens` tables. No request ever reaches these new tables in Phase 1; no `public_id` or `event_id` value is ever generated in Phase 1 (columns exist, empty).

### Recommended Project Structure
```
prisma/
├── schema.prisma              # all models added here, single file (matches existing convention)
└── migrations/
    ├── 20260616152601_init/                    # existing — untouched
    ├── 20260617121303_add_refresh_tokens/       # existing — untouched
    ├── <timestamp>_rename_user_to_users/        # NEW — hand-edited RENAME TABLE
    ├── <timestamp>_widen_pk_to_bigint/          # NEW — hand-verified MODIFY COLUMN x3 (users.id, refresh_tokens.id, refresh_tokens.user_id)
    └── <timestamp>_add_domain_schema/           # NEW — House/Room/Device/Command/state tables/events, all BigInt PKs from birth (plain CREATE TABLE, no widen risk)
src/
├── generated/prisma/           # regenerated, unchanged location
├── lib/
│   └── prisma.ts               # singleton — Phase 2 adds the $extends nanoid seam HERE, not per-service
└── services/                   # untouched in Phase 1 (no service files needed — no runtime logic)
```

Three separate migrations are recommended (rename, then widen, then additive) rather than combining them — this isolates each risky hand-edited SQL statement (rename; type-widen on a live-data table) from the purely mechanical additive SQL (new `CREATE TABLE` statements for tables that have never held data, so a widen-style risk does not apply to them). If the planner prefers fewer migrations, the widen and rename MAY be combined into one migration (both touch only `users`/`refresh_tokens`, both are hand-verified before apply) — but do not combine either with the additive schema migration, since that dilutes what needs hand-verification.

### Pattern 1: Hand-Authored Rename Migration (DATA-01, unchanged from prior research)
**What:** Use `prisma migrate dev --create-only` to generate a draft migration, then manually edit the generated SQL to replace Prisma's default `DROP TABLE`/`CREATE TABLE` pair with `RENAME TABLE`, before applying it.
**When to use:** Any time a `@@map` is added to a model that already has a live, populated table.
**Example:**
```prisma
// schema.prisma — add @@map to the existing User model
model User {
  id        BigInt   @id @default(autoincrement())
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
-- Generated draft is likely destructive for the RENAME portion (DROP+CREATE) — hand-edit to:
ALTER TABLE `User` RENAME TO `users`;
-- Any column additions (e.g., deleted_at) can be appended in the SAME migration file:
ALTER TABLE `users` ADD COLUMN `deleted_at` DATETIME(3) NULL;
```
**Verified finding (re-confirmed this session):** `refresh_tokens` does **not** need a rename — `prisma/migrations/20260617121303_add_refresh_tokens/migration.sql` (read directly) already does `CREATE TABLE refresh_tokens (...)`; the model was authored with `@@map("refresh_tokens")` from day one. Only `User` (never mapped) needs the rename. `[VERIFIED: prisma/migrations/*/migration.sql read directly this session]`

### Pattern 1b: Widening an AUTO_INCREMENT PK from Int to BigInt (NEW — the core of this re-plan)
**What:** `ALTER TABLE <table> MODIFY COLUMN <col> BIGINT NOT NULL AUTO_INCREMENT` (for the PK) and `ALTER TABLE <table> MODIFY COLUMN <col> BIGINT NOT NULL` (for a plain FK-shaped column like `refresh_tokens.user_id`) is the correct, lossless, in-place MySQL/MariaDB DDL for widening an integer column. It does not drop/recreate the table, does not touch existing row values (they are numerically re-encoded in place, which for a widen — never a narrow — cannot lose precision), and preserves the current `AUTO_INCREMENT` counter value on the PK column.
**When to use:** Exactly this phase's `User.id`, `RefreshToken.id`, and `refresh_tokens.user_id` widen (D-11 / ROADMAP success criterion 2).
**Why Prisma needs hand-verification here specifically:** A confirmed, dated Prisma bug (`prisma/prisma` GitHub issue #18532, filed against **Postgres**) shows Prisma's migration-diff engine can generate `ALTER COLUMN "id" SET DATA TYPE BIGSERIAL`, which Postgres rejects (`BIGSERIAL` is a pseudotype, not a valid conversion target) `[CITED: github.com/prisma/prisma/issues/18532]`. **This specific failure mode is Postgres-only** — MySQL/MariaDB has no `SERIAL`/`BIGSERIAL` pseudotype; `AUTO_INCREMENT` is a plain attribute on any integer column, so the direct MySQL equivalent (`MODIFY COLUMN ... BIGINT ... AUTO_INCREMENT`) is syntactically unambiguous and does not hit this bug class. No MySQL-specific analogue of issue #18532 was found in this session's searches. Despite the low risk, still use `--create-only` and read the generated SQL before applying — this is cheap, and it is this project's established practice for any migration touching the live `users`/`refresh_tokens` tables (see Pattern 1).
**Example:**
```bash
npx prisma migrate dev --name widen_pk_to_bigint --create-only
```
```sql
-- Expected/verify generated SQL resembles:
ALTER TABLE `User` MODIFY COLUMN `id` BIGINT NOT NULL AUTO_INCREMENT;
ALTER TABLE `refresh_tokens` MODIFY COLUMN `id` BIGINT NOT NULL AUTO_INCREMENT;
ALTER TABLE `refresh_tokens` MODIFY COLUMN `user_id` BIGINT NOT NULL;
```
```bash
npx prisma migrate dev   # apply after confirming the SQL is exactly MODIFY COLUMN, no DROP/CREATE
```
**Why this is safe to combine with the rename in sequence, not in parallel risk:** Because `relationMode = "prisma"` means **no real `FOREIGN KEY` constraint exists** on `refresh_tokens.user_id → User.id` in the live database (confirmed: neither migration SQL file contains a `FOREIGN KEY` clause) — there is no DB-enforced dependency that could block or complicate widening the two columns independently. This is a genuine advantage of the project's existing `relationMode = "prisma"` choice that this research surfaces as directly relevant to migration safety, not just an ORM-level relation-emulation detail.
**Sequencing recommendation:** Run the rename migration first (isolates the one truly destructive-looking operation), then the widen migration second (isolates the one type-changing operation on live data), then the additive domain-schema migration third (pure `CREATE TABLE`, zero risk to existing data since these tables have never held rows). This matches ROADMAP's existing Wave 2 (rename) / Wave 3 (everything else) split — the planner should fold the widen into Wave 2 or make it its own micro-wave inside Wave 3, but it must NOT be silently bundled into the same `--create-only` diff as the 10 new `CREATE TABLE` statements, or hand-verification of the widen SQL becomes harder to isolate and review.

### Pattern 2: NanoID `public_id` generation seam (NEW — replaces the old uuid(7) PK pattern)
**What:** NanoID has no Prisma schema-level default function (unlike `uuid()`/`cuid()`) — `nanoid()` must be computed in JS/TS and passed into the `create` call. Two implementation shapes are viable:
1. **Prisma Client `$extends` query extension** (recommended) — intercept `create` (and `createMany`) for the four models that need `public_id` and inject `nanoid()` into `args.data` before the query executes.
2. **Per-service minting** — each of `createHouse`/`createRoom`/`createDevice`/`createCommand` calls `nanoid()` inline before `prisma.house.create({ data: { ...input, publicId: nanoid() } })`.
**Recommendation:** Use the `$extends` approach, centralized in `src/lib/prisma.ts` (the existing singleton file) or a new `src/lib/prisma-extensions.ts` imported by it. Rationale: (a) it matches this codebase's existing "singleton owns cross-cutting DB behavior" convention (`src/lib/prisma.ts` already the sole DB-access seam per `CONVENTIONS.md`/`STRUCTURE.md`); (b) it cannot be forgotten — a developer adding a fifth `createX` service later automatically gets `public_id` generation without needing to remember the pattern, unlike per-service minting where a missed call silently leaves `public_id` unset (and Prisma would reject the insert with a NOT NULL violation only at runtime, not compile time, since a `String @unique` column will typically be required/non-optional); (c) it keeps service functions free of "generate a random identifier" concerns, consistent with the existing pattern where `refresh-token.ts` (not the route) owns raw-token generation.
**Column type/length:** `public_id String @unique @db.VarChar(21)`. NanoID's default alphabet (`A-Za-z0-9_-`) and default length (21 characters) yields a collision probability comparable to UUID v4 at practical scales `[CITED: nanoid README — "urlsafe, unique string ID generator" collision-safety claims for the default 21-char/64-symbol configuration]`. `VarChar(21)` is exact-fit (no wasted bytes vs. an oversized `VarChar(36)`), and NanoID output is fixed-length by construction (no truncation risk).
**Collision-retry note:** at 21 chars/64-symbol alphabet, collision probability is astronomically low for this project's realistic entity counts (a personal smart-home platform, not a global-scale multi-tenant SaaS) — no retry-on-conflict wrapper is warranted for v1. If a `P2002` unique-constraint error is ever observed on `public_id` in practice, the fix is a simple retry-with-regenerate loop in the extension, not a schema change. Document this as a known, accepted, extremely-low-probability risk rather than building unneeded retry logic now (matches the project's broader "don't add complexity for problems that haven't materialized" philosophy already evident in the "no per-device limits table" decision).
**Example (illustrative — the actual `$extends` implementation is Phase 2 work, not Phase 1):**
```typescript
// Source: pattern derived from Prisma Client Extensions docs (query component)
// https://www.prisma.io/docs/orm/prisma-client/client-extensions/query
// NOT implemented in Phase 1 — Phase 1 only shapes the `public_id` column.
import { nanoid } from 'nanoid'

const withPublicId = Prisma.defineExtension((client) =>
  client.$extends({
    query: {
      house:   { create: ({ args, query }) => query({ ...args, data: { ...args.data, publicId: nanoid() } }) },
      room:    { create: ({ args, query }) => query({ ...args, data: { ...args.data, publicId: nanoid() } }) },
      device:  { create: ({ args, query }) => query({ ...args, data: { ...args.data, publicId: nanoid() } }) },
      command: { create: ({ args, query }) => query({ ...args, data: { ...args.data, publicId: nanoid() } }) },
    },
  })
)
```

### Pattern 3: BigInt PK columns (NEW — replaces the old uuid(7) PK pattern)
**What:** Every new domain PK (`House.id`, `Room.id`, `Device.id`, `Command.id`, `CommandTarget.id`, all four state-table ids, `events.id`) uses `BigInt @id @default(autoincrement())`. This maps to MariaDB `BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY` — a first-class, fully-native Prisma/MySQL feature (no `dbgenerated()`, no raw SQL, no adapter caveats — `autoincrement()` is universally supported on the mysql connector and has been for every Prisma version this project could plausibly use).
**Example:**
```prisma
// Source: Prisma Schema Reference (autoincrement() function, BigInt scalar type)
model Device {
  id           BigInt    @id @default(autoincrement())
  publicId     String    @unique @map("public_id") @db.VarChar(21)
  userId       BigInt    @map("user_id")            // denormalized, no @relation required under relationMode=prisma
  roomId       BigInt    @map("room_id")
  name         String
  deviceType   String    @map("device_type")         // validated in TypeBox, not a DB enum (D-06)
  manufacturer String?
  model        String?
  stateType    String?   @map("state_type")           // morph discriminator
  stateId      BigInt?   @map("state_id")             // morph target id, no FK
  deletedAt    DateTime? @map("deleted_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  @@map("devices")
  @@index([userId])
  @@index([roomId])
}
```
**Client-side caveat to flag now, solve later:** `@prisma/client` represents `BigInt` fields as the native JS `bigint` primitive (not `number`), because MariaDB `BIGINT` values can exceed `Number.MAX_SAFE_INTEGER` (2^53-1) `[CITED: Prisma docs — "Fields & types" special-fields-and-types page — BigInt fields map to JS BigInt]`. **`JSON.stringify()` throws `TypeError: Do not know how to serialize a BigInt`** on any object containing a raw `bigint` value, because BigInt has no native JSON representation `[CITED: MDN — BigInt_not_serializable error page; corroborated by multiple Prisma GitHub discussions, e.g. prisma/studio#614, prisma/prisma#9793]`. **This does not block Phase 1** (no HTTP responses are serialized this phase — schema/migration only), but it is a hard requirement for every future phase that returns a BigInt `id` in a JSON response (Phase 2 onward, e.g. `GET /houses/:id`). Flagging, not solving: the standard fixes are (a) a global `BigInt.prototype.toJSON = function () { return this.toString() }` shim, or (b) a Prisma Client `result` extension that stringifies BigInt fields on read, or (c) never returning internal `id` in API responses at all — only `public_id` — which this project's own id-strategy (external identity = `public_id`, internal `id` = DB-only) suggests may be the cleanest fit and worth raising to the user/planner for Phase 2. **Recommendation for the planner:** add an explicit note or question in Phase 2 planning about whether internal BigInt `id`s are ever exposed in API responses at all, given `public_id` already exists for exactly that purpose.

### Pattern 4: Dual-id append-only events table (NEW — replaces the single-uuid `event_id`-as-PK pattern)
**What:** `events.id` (BigInt, PK, autoincrement) is the **ordering** key — used for the cursor `(recorded_at, id)`, and referenced by every state table's `last_event_id BigInt?` column for the tuple guard. `events.event_id` (String, `@unique`, uuidv5) is a **separate** column serving only as the **idempotency** key — the report consumer's `INSERT ... ON DUPLICATE KEY` (or catch-P2002) dedup target. These are never compared against each other or substituted for one another.
**Why two columns, not one:** uuidv5 output is a deterministic hash of its inputs (`uuidv5(name, namespace)` — SHA-1-based per RFC 4122) and carries **no insertion-order information** — two uuidv5 values cannot be compared to determine which was inserted first. An autoincrement BigInt, by contrast, is *only* insertion-ordered and carries no semantic meaning otherwise. D-12 explicitly locks this split; the previous research pass's plan (a single `uuid(7)` PK serving both roles) is obsolete precisely because it relied on uuid v7's time-ordering property, which is no longer part of this design.
**uuidv5 implementation detail worth surfacing now (affects nothing in Phase 1, but shapes what "the generator" in Phase 5 needs):** the `uuid` npm package's `v5` export has the signature `uuidv5(name: string, namespace: string)` — it requires a fixed **namespace UUID** in addition to the name being hashed `[CITED: uuid npm package docs / RFC 4122 §4.3]`. The requirement text "`event_id = uuidv5(command_target_id [+ outcome])`" implies `command_target_id` (optionally concatenated with an outcome string) is the *name*; a separate, fixed application-level namespace UUID constant (generated once via `uuidv4()` and hardcoded, e.g. in `src/lib/ids.ts`) will be needed in Phase 5/6 — this is not a Phase 1 concern (no code is written), but the planner for Phase 5 should not be surprised that `uuidv5()` needs a second argument beyond `command_target_id`.
**Column types:**
```prisma
model Event {
  id         BigInt    @id @default(autoincrement())
  eventId    String    @unique @map("event_id") @db.Char(36)   // uuidv5, canonical 36-char hyphenated form
  entityType String    @map("entity_type")                      // "device" | "command", app-validated
  source     String
  eventKind  String    @map("event_kind")
  deviceId   BigInt?   @map("device_id")                        // null for command-lifecycle rows
  deviceType String?   @map("device_type")
  commandId  BigInt?   @map("command_id")
  snapshot   Json
  recordedAt DateTime  @map("recorded_at")                      // producer-minted event-time, NOT createdAt

  @@map("events")
  @@index([deviceId, recordedAt])
}
```
`@db.Char(36)` for `event_id` matches the canonical hyphenated UUID string format (`xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx`) that `uuidv5()` returns by default — fixed-length, no truncation risk. `@unique` on a non-`@id` field creates its own unique index in MySQL, satisfying DATA-04's "MariaDB unique index on the deterministic `event_id`" requirement independently of the `@id` (which is now on `id`, not `event_id`).
**`last_event_id` on state tables:**
```prisma
model LightState {
  id          BigInt    @id @default(autoincrement())
  deviceId    BigInt    @map("device_id")
  isOn        Boolean   @map("is_on") @default(false)
  brightness  Int       @default(0)
  lastEventAt DateTime? @map("last_event_at")
  lastEventId BigInt?   @map("last_event_id")                   // references events.id — NOT events.event_id
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  @@map("light_states")
  @@index([deviceId])
}
```

### Anti-Patterns to Avoid
- **Using `@default(uuid())` or `@default(uuid(7))` anywhere in the new schema:** obsolete per the revised id strategy — every PK is now `BigInt @default(autoincrement())`. A stray `uuid()` default is a sign the old research/pattern leaked into the new plan.
- **Comparing or ordering by `events.event_id` (the uuidv5 String):** it carries no time-ordering information; ordering/cursor logic must always use `events.id` (BigInt).
- **Minting `public_id` in some `createX` services but not others:** defeats the purpose of centralizing the seam — use the `$extends` approach (Pattern 2) precisely to make this structurally impossible to forget.
- **Declaring a Prisma `@relation` on the Device→state-table morph:** impossible to express correctly (one field, four possible target tables) and not needed — `relationMode = "prisma"` already means no DB constraint is enforced.
- **Combining the rename, the widen, and the additive schema changes into one giant `prisma migrate dev` run without `--create-only`:** removes the opportunity to hand-edit/verify each risky portion independently before it touches the live database.
- **Adding a DB-level `ENUM` type for `Command.status`, `ac_states.mode`, etc.:** directly contradicts D-06 and the project's "no DB enums/limits" philosophy.
- **Returning raw BigInt `id` fields directly in a Fastify JSON response** (future phases): will throw at serialization time unless explicitly stringified — see Pattern 3's caveat.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| BigInt PK generation | A custom sequence table or app-side counter | MariaDB's native `AUTO_INCREMENT` via Prisma's `@default(autoincrement())` | Zero app code, DB-engine-guaranteed uniqueness and monotonicity, works correctly even under concurrent inserts (a hand-rolled counter would need its own locking) |
| NanoID collision handling | A custom collision-retry-with-backoff wrapper "just in case" | Nothing — at 21 chars/64-symbol alphabet the collision probability is negligible at this project's scale; add a simple retry only if a `P2002` on `public_id` is ever actually observed | Building retry logic for a risk this small, before it manifests, is speculative complexity the project's own philosophy (documented in CONTEXT.md's Deferred Ideas) explicitly steers away from |
| Rename-safe migrations | A custom migration-diffing script | `prisma migrate dev --create-only` + manual SQL edit (official, documented workflow) | Prisma's own documented and supported pattern for exactly this problem |
| Int→BigInt widen-safe migrations | A custom `ALTER TABLE` script run outside Prisma's migration history | Same `--create-only` + manual SQL edit workflow, applied via `prisma migrate dev` so it's tracked in `prisma/migrations/` like every other schema change | Keeps the widen in the same auditable migration history as everything else; a hand-run out-of-band `ALTER TABLE` would desync Prisma's migration ledger from the live schema |
| snake_case mapping | A runtime column-name-transforming wrapper around Prisma Client | `@map`/`@@map` declarative attributes | Compile-time, zero runtime cost |
| Deterministic idempotency ids | A custom hash function (e.g., `sha256(commandTargetId).slice(0, 36)`) | `uuidv5(name, namespace)` from the `uuid` package | RFC 4122-compliant, produces a valid UUID string (fits `Char(36)` cleanly), well-tested, and already the locked project decision — no reason to hand-roll an equivalent |

**Key insight:** As with the prior research pass, every genuine "hand-roll risk" in this phase already has a first-class, native answer (Prisma schema language for the DB-tier concerns; the `uuid`/`nanoid` packages for the two app-tier id-generation concerns that Prisma cannot express declaratively). The only hand-authored artifacts in Phase 1 are migration SQL files — and even those follow Prisma's own documented `--create-only` workflow, not a bespoke process.

## Runtime State Inventory

> This phase is a rename (`User` → `users`) AND a type-widen (`Int` → `BigInt` on three columns) touching a live, populated table. Full inventory below — re-verified this session against the actual migration SQL files.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | The `User` table (MariaDB, local dev instance `smart_house` on `localhost:3306`, confirmed reachable via `npx prisma migrate status` this session) holds live rows created via the two existing migrations, used by existing auth tests/manual testing. `refresh_tokens` is already correctly named. Both tables' PK/FK columns are currently `INTEGER` (confirmed by reading both `migration.sql` files directly — `id INTEGER NOT NULL AUTO_INCREMENT`, `user_id INTEGER NOT NULL`). | **Two** actions: (1) the `User`→`users` rename must preserve every existing row via `RENAME TABLE`, not drop+recreate; (2) the `Int`→`BigInt` widen on `id`/`id`/`user_id` must preserve every existing row's numeric value and the live `AUTO_INCREMENT` counter via `MODIFY COLUMN`, not a column drop+recreate. Both are data migrations in the sense that they must not lose data, but both are also non-destructive schema-only operations when done correctly (no data *transformation* is needed — widening never requires recomputing values). |
| Live service config | None — single-service Fastify app; no external service (n8n, Datadog, etc.) references the `User` table name or its column types. | None. |
| OS-registered state | None found — no Windows Task Scheduler entries, no pm2/launchd/systemd units reference "User", "users", or the smart-house DB. | None. |
| Secrets/env vars | `DATABASE_URL` in `.env` points at the database, not the table/column shape — unaffected by rename or widen. No secret key names embed "User"/column type info. | None. |
| Build artifacts | `src/generated/prisma/` (Prisma Client output) contains generated TypeScript referencing the Prisma model name `User` and its field types (`id: number` currently, becomes `id: bigint` after the widen — this is a **breaking type change** for any code that currently treats `user.id` as a JS `number`, though a grep of `src/` shows no such usage today since the auth flow only threads `user.id` through JWT payloads/Prisma queries, never arithmetic). Must run `npm run prisma:generate` after the schema edit. | Code action: `npm run prisma:generate` (already the phase's own "regenerate Prisma client" step). Additionally: **grep `src/` for any place `user.id` (or `request.user.id`) is used in a way that assumes `number`** (e.g., arithmetic, `Number()` coercion, template-literal interpolation without `.toString()`) before finalizing — none was found in this session's read of `src/plugins/auth.ts`/`src/routes/auth/index.ts`, but this is a genuine behavior-affecting side-effect of the widen, distinct from the pure-rename case in the prior research pass, and worth a dedicated grep step in the plan. |

**Nothing found in three of five categories** (live service config, OS-registered state, secrets/env vars) — verified by inspecting `.env` variable names and confirming this is a single-process local-dev Fastify app with no OS-level service registration and no raw-SQL table-name/type references outside Prisma-generated code.

## Common Pitfalls

### Pitfall 1: Assuming the Postgres Int→BigInt Prisma bug also affects MySQL/MariaDB
**What goes wrong:** A developer sees `prisma/prisma#18532` (Int→BigInt widen generates invalid SQL) while researching this exact migration and concludes the widen is unsafe on MariaDB too, over-engineering a workaround (e.g., manually dropping and recreating the column, risking data loss) that isn't needed.
**Why it happens:** The issue title/summary doesn't always make the Postgres-specificity obvious at a glance; the underlying cause (`BIGSERIAL` pseudotype) is a Postgres concept with no MySQL/MariaDB analogue.
**How to avoid:** Confirmed this session via direct issue content review: the bug is specifically about `BIGSERIAL` (Postgres-only). MySQL/MariaDB's `AUTO_INCREMENT` is a plain column attribute, and `MODIFY COLUMN ... BIGINT ... AUTO_INCREMENT` is standard, valid, documented syntax. Still run `--create-only` and read the generated SQL (cheap insurance, matches project practice) but do not assume the fix requires abandoning Prisma's generated migration for this step.
**Warning signs:** If `prisma migrate dev --create-only` generates SQL containing anything other than `MODIFY COLUMN` for the three widened columns (e.g., a `DROP`/`CREATE` pair, or an attempt to use a MySQL pseudotype that doesn't exist), stop and hand-author the SQL directly rather than trusting the diff.

### Pitfall 2: Forgetting the `AUTO_INCREMENT` attribute when hand-editing the widen SQL
**What goes wrong:** If the widen migration is hand-authored or hand-corrected, a common mistake is writing `ALTER TABLE users MODIFY id BIGINT NOT NULL;` (dropping the `AUTO_INCREMENT` clause) — MySQL/MariaDB requires every attribute that was previously on the column to be re-stated in a `MODIFY COLUMN` statement, since it's not a partial patch; omitting `AUTO_INCREMENT` silently removes it from the column, breaking every future INSERT that relies on the DB generating the id.
**Why it happens:** `MODIFY COLUMN` syntax reads like "just change the type," but MySQL/MariaDB treats it as "redefine the column's complete definition."
**How to avoid:** Always include every attribute the column already has (`NOT NULL`, `AUTO_INCREMENT`, any default) in the `MODIFY COLUMN` statement. Verify post-migration with `SHOW CREATE TABLE users;` — confirm `AUTO_INCREMENT` is still present in the column definition, not just that the type is `bigint(20)`.
**Warning signs:** A subsequent `INSERT` without an explicit `id` value fails with "Field 'id' doesn't have a default value" — this indicates `AUTO_INCREMENT` was dropped during the widen.

### Pitfall 3: Assuming BigInt fields serialize like numbers in Fastify JSON responses
**What goes wrong:** Not a Phase 1 bug (no responses are serialized this phase), but a trap for whoever plans/implements Phase 2 first: a route handler returns `{ id: house.id, ... }` where `house.id` is a JS `bigint`, and Fastify's JSON serializer throws.
**Why it happens:** Prisma silently switches the JS representation from `number` to `bigint` the moment a column's Prisma type changes from `Int` to `BigInt` — nothing in the Prisma schema visually signals "this will now break JSON.stringify."
**How to avoid:** Not a Phase 1 fix (documented as a flag-forward in Pattern 3), but the planner should either (a) add a Prisma Client `result` extension that stringifies BigInt output fields globally, (b) add the `BigInt.prototype.toJSON` shim in `src/server.ts`/`app.ts` bootstrap, or (c) — the option this research leans toward given the project's own `public_id` design — simply never expose the internal `id` field in any API response schema; only `public_id` (a String) is user-facing. Raise this explicitly as a Phase 2 planning question.
**Warning signs:** `TypeError: Do not know how to serialize a BigInt` thrown from any route handler returning a model with a `BigInt` field, surfaced through Fastify's global error handler as a 500.

### Pitfall 4: Prisma v7 + MariaDB 10.11+ JSON-related introspection/Studio syntax error (carried forward, unchanged)
**What goes wrong:** Running `npx prisma studio` (or introspection-driven tooling) against this project's MariaDB instance may throw a SQL syntax error near a `CAST(... AS json)` clause.
**Why it happens:** An open, unfixed regression in Prisma's "JSON Protocol" engine (default since v7.0.0) that emits MySQL-8-specific casting syntax MariaDB's parser rejects. `[CITED: prisma/prisma GitHub issue #29023]`
**How to avoid:** Confirmed scoped to introspection/Studio, not `prisma migrate dev`/Client CRUD — does not block Phase 1's acceptance bar. Do not use `npm run prisma:studio` as a manual sanity-check during this phase; use `npx prisma migrate status` or a direct MariaDB client instead.
**Warning signs:** A syntax error mentioning `json) from (select` when running Prisma Studio or `prisma db pull`.

### Pitfall 5: MariaDB's `JSON` is `LONGTEXT`, not a binary JSON type (carried forward, unchanged)
**What goes wrong:** Assuming `events.snapshot` gets PostgreSQL-`jsonb`-like binary storage/indexed path queries.
**Why it happens:** MariaDB's `JSON` is an alias for `LONGTEXT COLLATE utf8mb4_bin` for MySQL syntax compatibility, not a first-class binary JSON type. `[CITED: MariaDB Server documentation — "JSON Data Type"]`
**How to avoid:** No action needed for Phase 1 — D-07 only requires storing/retrieving the snapshot verbatim. If a future phase needs to query inside `snapshot`, `JSON_EXTRACT`/`JSON_VALUE` work but operate over a `LONGTEXT`-backed column without a native binary type's storage/indexing advantages — an accepted, documented limitation.
**Warning signs:** N/A for this phase.

### Pitfall 6: Assuming `uuidv5(command_target_id)` needs only one argument
**What goes wrong:** A Phase 5/6 implementer calls `uuidv5(commandTargetId)` expecting it to work like a simple hash function, and hits a type error or unexpected output because `uuidv5` requires a namespace UUID as a second argument.
**Why it happens:** The requirement text ("`event_id = uuidv5(command_target_id [+ outcome])`") reads like a single-argument function; RFC 4122's actual `uuidv5(name, namespace)` signature isn't obvious from that shorthand.
**How to avoid:** Not a Phase 1 blocker (no code written), but flagged here so Phase 5 planning defines a fixed application namespace UUID constant up front (generate once via `uuidv4()`, hardcode as e.g. `EVENT_NAMESPACE` in `src/lib/ids.ts`) rather than discovering the signature mismatch mid-implementation.
**Warning signs:** A TypeScript compile error on `uuidv5(commandTargetId)` (wrong arity) once the `uuid` package is actually installed in Phase 5.

## Code Examples

### Full new-model skeleton respecting all locked conventions (revised for BigInt/NanoID)
```prisma
// Source: composed from Prisma Schema Reference + this project's existing RefreshToken pattern
model House {
  id        BigInt    @id @default(autoincrement())
  publicId  String    @unique @map("public_id") @db.VarChar(21)
  userId    BigInt    @map("user_id")
  name      String
  address   String?
  deletedAt DateTime? @map("deleted_at")
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")

  @@map("houses")
  @@index([userId])
}

model Room {
  id        BigInt    @id @default(autoincrement())
  publicId  String    @unique @map("public_id") @db.VarChar(21)
  houseId   BigInt    @map("house_id")
  userId    BigInt    @map("user_id")   // DATA-02 denorm
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
  id        BigInt    @id @default(autoincrement())
  publicId  String    @unique @map("public_id") @db.VarChar(21)
  userId    BigInt    @map("user_id")   // DATA-02 denorm — GET /commands/:id never joins
  status    String    @default("received")   // received|rejected|pending|done|partially_failed|failed|no_targets — TypeBox-validated
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")

  @@map("commands")
  @@index([userId])
}

model CommandTarget {
  id          BigInt    @id @default(autoincrement())   // no public_id — internal-only per D-11
  commandId   BigInt    @map("command_id")
  deviceId    BigInt    @map("device_id")
  status      String    @default("pending")            // pending|done|failed — CAS-transitioned in Phase 6
  deadlineAt  DateTime  @map("deadline_at")
  createdAt   DateTime  @default(now()) @map("created_at")

  @@map("command_targets")
  @@index([commandId])
  @@index([deviceId])
}
```

### Decimal precision for sensor readings (unchanged from prior research)
```prisma
// Source: Prisma Schema Reference — MySQL native type attributes
model SensorState {
  id          BigInt    @id @default(autoincrement())   // no public_id — internal-only per D-11
  deviceId    BigInt    @map("device_id")
  reading     Decimal   @db.Decimal(6, 2)   // e.g. -999.99..9999.99 — ample for temp/humidity/lux sensors
  unit        String
  lastEventAt DateTime? @map("last_event_at")
  lastEventId BigInt?   @map("last_event_id")            // references events.id, NOT events.event_id
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  @@map("sensor_states")
  @@index([deviceId])
}
```
`Decimal(6,2)` gives 4 integer digits + 2 fractional (range ±9999.99). `target_temp` fields (`ac_states`, `heater_states`) stay `Int` per D-02/D-03.

### The widen migration, fully worked (illustrative expected SQL)
```sql
-- <timestamp>_widen_pk_to_bigint/migration.sql
-- Verify this is what `prisma migrate dev --create-only` actually produces before applying.
ALTER TABLE `users` MODIFY COLUMN `id` BIGINT NOT NULL AUTO_INCREMENT;
ALTER TABLE `refresh_tokens` MODIFY COLUMN `id` BIGINT NOT NULL AUTO_INCREMENT;
ALTER TABLE `refresh_tokens` MODIFY COLUMN `user_id` BIGINT NOT NULL;
```
Post-apply verification: `SHOW CREATE TABLE users;` and `SHOW CREATE TABLE refresh_tokens;` should both show `bigint(20)` (or `bigint unsigned` depending on Prisma's exact emitted type) with `AUTO_INCREMENT` still present on the two `id` columns, and existing row counts/values unchanged (`SELECT COUNT(*), MAX(id) FROM users;` before and after should match on count and show `id` values numerically unchanged).

## State of the Art

| Old Approach (prior research pass) | Current Approach (this revision) | When Changed | Impact |
|--------------------------------------|-------------------------------------|---------------|--------|
| `String @db.Char(36) @default(uuid(7))` for all new PKs | `BigInt @default(autoincrement())` for all new PKs; NanoID `public_id` for external identity | CONTEXT.md revision, 2026-07-02 (this session) | Smaller keys/indexes on the hot `events` table; dissolves the `User.id`-Int-vs-Char(36) type mismatch that would otherwise complicate the `user_id` denorm columns; requires the Int→BigInt widen work this document researches |
| Single `event_id` (uuid v7) serving as both PK and idempotency key | Two columns: `id` (BigInt, ordering/PK) + `event_id` (uuidv5 String, idempotency only) | Same revision (D-12) | Ordering logic is now trivially correct on a plain autoincrement integer; idempotency logic is independent and unaffected by insertion order |
| `@default(uuid())` was the only uuid option historically (always v4); `uuid(7)` added in Prisma 5.18.0 (Aug 2024) | N/A — no `@default(uuid())`/`uuid(7)` used anywhere in the new schema | This revision drops the concern entirely | The former "v4-vs-v7 adapter spike" (ROADMAP success criterion 5 in the old plan) is fully obsolete — confirmed no `@default(uuid())` call exists in the revised design |
| Prisma's legacy Rust query engine → new "Client engine"/"JSON Protocol" (default in Prisma v7) | Unchanged this revision | Prisma v7.0.0 | Still relevant: the MariaDB introspection/Studio JSON-casting regression (Pitfall 4) persists regardless of id strategy |

**Deprecated/outdated:** The entire "uuid v7 storage spike (`BINARY(16)` vs `CHAR(36)`)" line item from `.planning/STATE.md`'s Todos and the old ROADMAP Wave 3 plan title is now dead — no internal id uses `@default(uuid())` anywhere in the revised schema. The planner should update the stale `01-03-PLAN.md` wave description in ROADMAP.md (still reads "uuid-v7 storage spike" in the Plans list even though the Success Criteria prose was already revised) to reflect the widen work instead — see Open Questions #1.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `nanoid` (5.1.16) and `uuid` (14.0.1) are the correct, standard npm package names/versions for NanoID generation and uuidv5 generation respectively — package names sourced from WebSearch/training knowledge, cross-checked against the npm registry this session (`npm view` confirms both resolve, current, no `postinstall` script) but not confirmed via Context7/official docs. | Standard Stack, Package Legitimacy Audit | Low — both are extremely well-established, high-download packages with no red flags found; risk is essentially "wrong version pinned," not "wrong/malicious package," and neither is installed in Phase 1 anyway — Phase 2/5 should re-verify at install time per the provenance rule. |
| A2 | MySQL/MariaDB's `ALTER TABLE ... MODIFY COLUMN ... BIGINT ... AUTO_INCREMENT` for widening an existing populated `INTEGER AUTO_INCREMENT` column is lossless and preserves the current auto-increment counter — based on general, long-standing, documented MySQL/MariaDB DDL behavior (not independently reproduced against this project's live `smart_house` database in this research session; the actual `prisma migrate dev --create-only` output was not generated/inspected this session since that requires editing the schema first, which is planning/execution work, not research). | Architecture Patterns Pattern 1b, Summary, Common Pitfalls 1–2 | Medium — if the live MariaDB version has some unusual constraint (e.g., a very old MariaDB version with different widen semantics), the plan's acceptance gate (`prisma migrate dev` exits 0) would catch this immediately since it's a hard gate on the actual command succeeding; the mitigation is already built into the phase's own acceptance bar, so a wrong assumption here fails loud and early, not silently. |
| A3 | Prisma issue #18532 (Int→BigInt invalid migration) is confirmed Postgres-only with no MySQL/MariaDB analogue — based on reading the issue's content via WebFetch this session (which explicitly names `BIGSERIAL`/Postgres), not on an exhaustive search of every open Prisma issue for a MySQL-specific equivalent. | Architecture Patterns Pattern 1b, Common Pitfalls Pitfall 1 | Low-Medium — mitigated the same way as A2: the phase's own acceptance gate (`prisma migrate dev --create-only`, hand-read the SQL, only then apply) directly tests this assumption before any data is touched; if a MySQL-specific issue does exist, hand-verification catches it before `migrate dev` (non-`--create-only`) runs against the live DB. |
| A4 | No Context7 or other MCP documentation-lookup tool was available this session (all search-provider flags — `brave_search`, `exa_search`, `tavily_search`, `ref_search`, `perplexity`, `jina`, `firecrawl` — are `false` in `.planning/config.json`); all Prisma-specific claims were verified via built-in WebSearch/WebFetch against official Prisma docs pages, the Prisma GitHub repo, MDN, and MariaDB's own documentation site, plus direct repo/registry inspection (`npm view`, reading migration SQL files, `npx prisma migrate status`). | Entire document | Low — the highest-stakes claims (the Postgres-specificity of #18532, the BigInt/JSON serialization behavior, the `refresh_tokens` already-correctly-named finding) were each corroborated by at least one direct primary-source fetch (GitHub issue content, MDN, or this repo's own files) rather than relying on WebSearch summaries alone. |

**If this table is empty:** N/A — see entries above; none of these carry HIGH risk given the phase's own acceptance gate independently re-verifies A2/A3 before any live-data-touching command runs.

## Open Questions

1. **ROADMAP.md's Wave 3 plan title still says "uuid-v7 storage spike"**
   - What we know: The Phase 1 Success Criteria prose in ROADMAP.md was already revised (confirmed this session — criteria 2–5 correctly describe BigInt/NanoID/public_id) as part of commit `aa45a85`, but the Plans/Wave breakdown line (`01-03-PLAN.md — Additive domain-schema migration apply + uuid-v7 storage spike + full acceptance gate (Wave 3)`) was not updated in the same commit and still references the obsolete spike.
   - What's unclear: Whether this is an oversight or intentionally left for the planner to reconcile.
   - Recommendation: The planner should update this line to reflect the actual Wave 3 work (e.g., "Additive domain-schema migration apply + Int→BigInt widen verification + full acceptance gate") when writing `01-03-PLAN.md`, and should not spend any effort on a uuid-v7 spike — it is fully superseded.

2. **Should the widen migration be its own micro-wave, or folded into Wave 2 (the rename)?**
   - What we know: ROADMAP's existing Wave 2 is scoped as "Hand-authored User→users rename migration (RENAME TABLE, human-verified) + apply + auth regression." The widen (Int→BigInt on the same two tables) is a second, independently-hand-verifiable operation on the same tables.
   - What's unclear: CONTEXT.md doesn't explicitly say whether rename+widen should be one migration/one wave or two.
   - Recommendation: This research recommends keeping them as two separate migration files (even if run back-to-back in the same wave) so hand-verification of each is a distinct, reviewable diff — but a single combined migration file (rename then widen, both hand-verified together) is also acceptable if the planner prefers fewer wave-boundary commits. Either way, do NOT combine with the additive (`CREATE TABLE`) migration — that one has zero widen/rename risk and shouldn't dilute review attention.

3. **Should `light_states`/`ac_states`/`heater_states`/`sensor_states` declare a `@@unique([deviceId])` (one state row per device, DB-enforced) or leave it a plain indexed column?** *(carried forward unresolved from prior research — still open)*
   - What we know: STATE-01 (Phase 2) creates exactly one state row per device at creation time and never creates a second one.
   - What's unclear: CONTEXT.md doesn't explicitly say whether the DB should enforce this 1:1 cardinality.
   - Recommendation: Lean toward `@@unique([deviceId])` — a *structural* integrity guarantee (one row per device), not a *value/range* constraint, so it doesn't conflict with D-01…D-07's "no enums/CHECK/min-max" scope. Planner should confirm with the user if any doubt remains.

4. **Should internal BigInt `id` fields ever appear in API response bodies, or exclusively `public_id`?** *(new question raised by this revision, see Pitfall 3)*
   - What we know: `public_id` exists specifically to provide non-enumerable external identity; internal `id` is BigInt, which requires explicit handling to avoid a JSON serialization crash.
   - What's unclear: Nothing in CONTEXT.md explicitly forbids exposing internal `id`, but nothing requires it either — Phase 1 doesn't write any response schemas, so this is deferred, not decided.
   - Recommendation: Raise to the user/planner at Phase 2 kickoff — if the answer is "never expose internal `id`," Pitfall 3's BigInt-serialization concern becomes moot for API responses (though it would still apply to any internal logging/debugging code that logs raw model objects). If internal `id` IS exposed anywhere, a global BigInt-to-string serialization strategy must be decided before the first route ships.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Build/run everything | ✓ | v24.18.0 | — |
| Prisma CLI | Schema authoring, migrations | ✓ | 7.8.0 | — |
| MariaDB (local dev instance) | `prisma migrate dev` target | ✓ | Reachable at `localhost:3306`, database `smart_house`; 2 existing migrations applied cleanly (`npx prisma migrate status` re-run this session: "Database schema is up to date!") | — |
| TypeScript compiler | `npm run build` | ✓ | 6.0.3 | — |
| `prisma.config.ts` | Prisma CLI config loading | ✓ (present, loads `DATABASE_URL` via `@prisma/config` + `dotenv/config`) | — | — |

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

This phase has **no runnable application logic** — per PROJECT.md's "Development Process" schema/infra exception, Phase 1 substitutes a **compile + migration smoke-check** for the red-test step. DATA-04's *runtime* behaviors are exercised in Phases 2/4/6; Phase 1 only lays the columns/indexes they depend on.

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DATA-01 | `prisma migrate dev` applies rename cleanly; `RENAME TABLE` (not DROP+CREATE) confirmed by reading generated SQL; existing auth tests still pass against renamed `users` table | smoke-check + manual SQL read | `npx prisma migrate dev --create-only` (read SQL) then `npx prisma migrate dev`, then `npm run build && npm test` | ❌ — no new test file; existing `src/test/routes/root.test.ts` (+ any auth-flow tests) is the regression guard |
| DATA-01/D-11 | `Int`→`BigInt` widen applies cleanly via `MODIFY COLUMN` (not DROP+CREATE); existing row data and `AUTO_INCREMENT` counter survive; `SHOW CREATE TABLE` confirms `AUTO_INCREMENT` still present post-widen | smoke-check + manual SQL/DB read | `npx prisma migrate dev --create-only` (read SQL) then apply; `SHOW CREATE TABLE users; SHOW CREATE TABLE refresh_tokens;` via any MariaDB client; `npm test` (existing auth regression) | ❌ — no new test file; manual DB inspection + existing auth suite is the guard |
| DATA-02 | Schema compiles with `user_id BigInt` columns present on Room/Device/Command (compile-time check only) | smoke-check | `npm run build` | ❌ — behavior tested in Phase 2 |
| DATA-03 | `deleted_at` columns present on User/House/Room/Device; existing auth flow (register/login/refresh/me/logout) still works post-migration | smoke-check + existing regression suite | `npm test` | ✅ (existing test suite covers login flow via `build(t)` — confirm during planning whether a dedicated `auth.test.ts` exists beyond `root.test.ts`) |
| DATA-04 | Unique index on `events.event_id` (String, separate from `id` PK), compound index on `(device_id, recorded_at)`, `last_event_at`/`last_event_id` (BigInt) columns present — structural only | smoke-check | `npx prisma migrate dev` (fails if index/column DDL is malformed) | ❌ — runtime behavior tested in Phase 4/6 |
| — | `public_id` column present, `@unique`, sized `VarChar(21)`, on House/Room/Device/Command only (NOT on CommandTarget/state tables/events) | smoke-check + schema read | `npm run build` (compile) + manual schema diff review | ❌ — generation logic tested in Phase 2 |

### Sampling Rate
- **Per task commit:** `npm run build` (fast compile check after each schema edit)
- **Per wave merge:** `npx prisma migrate dev --create-only` (read SQL) → `npx prisma migrate dev` → `npm run build && npm test` (full smoke-check)
- **Phase gate:** `prisma migrate dev` exits 0, `npm run build` compiles clean, `npm test` passes — exactly ROADMAP's stated acceptance bar (Success Criterion 6), no more, no less.

### Wave 0 Gaps
None — this phase does not add test files. The existing `src/test/routes/root.test.ts` (and any other existing auth test files) forms the complete regression guard needed for this phase's acceptance bar. As in the prior research pass: confirm during planning whether a test specifically exercising login (not just the root health-check) exists; if `root.test.ts` is the only test file, note that as a pre-existing gap, not one introduced by this phase.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No (Phase 1 scope) | Existing JWT/refresh-token flow untouched; only the underlying table is renamed/widened, not the auth logic. **Note:** JWT payloads that embed `user.id` will now embed a `bigint`-typed value at the application level (still serialized as a JSON number/string in the JWT itself, since `@fastify/jwt` payloads go through its own JSON encoding) — worth a Phase 2 smoke-check that login still round-trips correctly post-widen, covered by the existing auth regression suite. |
| V3 Session Management | No (Phase 1 scope) | Same as above. |
| V4 Access Control | Indirectly — schema only | `user_id` denormalization on Room/Device/Command (DATA-02), now BigInt, is the schema-level foundation for ownership-scoped access control enforced in later phases. |
| V5 Input Validation | Indirectly — schema only | TypeBox remains the standard for all future validation of these columns' values; the schema's deliberate avoidance of DB-level constraints (D-01…D-07) shifts 100% of value validation to TypeBox in later phases — a locked, explicit decision, not an oversight. |
| V6 Cryptography | No (Phase 1 scope) | No new secrets/credentials introduced. NanoID/uuidv5 are identifier-generation, not cryptographic-secret-generation, functions — `public_id` is a non-enumerable *identifier* (obscurity property), not a security boundary; ownership checks (`user_id` denorm) remain the actual access-control mechanism, not `public_id`'s unguessability. This distinction is worth stating explicitly so a future reader doesn't mistake `public_id` non-enumerability for an authorization control. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Destructive migration causing silent data loss on rename (DROP+CREATE instead of RENAME) | Tampering / Repudiation | Hand-verify the generated SQL emits `RENAME TABLE` before applying (Pattern 1) — DATA-01's explicit acceptance criterion. |
| Destructive/lossy migration on the Int→BigInt widen (e.g., accidental column drop+recreate, or losing `AUTO_INCREMENT`) | Tampering / Repudiation | Hand-verify the generated SQL emits `MODIFY COLUMN` with all original attributes preserved (Pattern 1b, Pitfall 2) — new to this revision, not present in the prior research pass since it only had a pure rename, not a type-widen, to worry about. |
| Enumerable sequential internal `id`s mistaken for a security boundary if ever exposed in place of `public_id` | Information Disclosure | `public_id` (NanoID) exists precisely to prevent internal-id enumeration in any user-facing surface; Phase 1 shapes the column so this protection is available from day one, but the *actual* mitigation only lands when routes are built (Phase 2+) to always return `public_id`, never `id`, in responses — flagged in Open Questions #4 as a decision the planner should make explicit rather than leave implicit. |
| Missing FK/relation integrity under `relationMode = "prisma"` allowing orphaned rows | Tampering (data integrity) | Already an accepted, documented trade-off in PROJECT.md — no new mitigation needed in Phase 1. |
| Soft-delete bypass (a query forgets to filter `deleted_at IS NULL`) | Elevation of Privilege | Phase 1 only adds the column; filtering discipline is Phase 2+ service-layer responsibility. |

## Sources

### Primary (HIGH confidence)
- `prisma/migrations/20260616152601_init/migration.sql`, `prisma/migrations/20260617121303_add_refresh_tokens/migration.sql` — read directly from this repo this session; ground-truth confirmation of current column types (`INTEGER`), no `FOREIGN KEY` constraints, and that `refresh_tokens` is already correctly named.
- `prisma/schema.prisma`, `.planning/CONTEXT.md`, `.planning/PROJECT.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md` — read directly this session; source of the locked D-11/D-12 decisions and phase requirements.
- `package.json` — read directly; confirms pinned `prisma`/`@prisma/client`/`@prisma/adapter-mariadb` versions.
- `npm view prisma version` / `npm view @prisma/client version` / `npm view @prisma/adapter-mariadb version` / `npm view nanoid version` / `npm view uuid version` — run directly this session against the live npm registry.
- `npx prisma migrate status`, `npx prisma --version` — run directly this session; confirms live DB connectivity and exact CLI/engine versions.
- `github.com/prisma/prisma/issues/18532` (fetched via WebFetch, full issue content) — confirms Postgres-only `BIGSERIAL` invalid-migration bug, no MySQL/MariaDB mention.

### Secondary (MEDIUM confidence)
- Prisma official docs — "Fields & types" (special-fields-and-types) page: BigInt → JS `bigint` representation.
- Prisma official docs — "Customizing Migrations" workflow page: `--create-only` flag, manual SQL editing.
- Prisma official docs — "Client Extensions: query component" page: `$extends` query-interception pattern used for Pattern 2.
- MDN — "TypeError: BigInt value can't be serialized in JSON" reference page.
- `uuid` npm package documentation / RFC 4122 §4.3 — `uuidv5(name, namespace)` signature and namespace-UUID requirement.
- `nanoid` package README (via WebSearch summary) — default alphabet/length collision-safety claims.
- `prisma/prisma` GitHub issue #29023 (open, unconfirmed) — Prisma v7 + MariaDB JSON-casting introspection/Studio bug (carried forward from prior research, re-cited not re-verified this session).
- MariaDB Server documentation — "JSON Data Type" page (carried forward, re-cited not re-verified this session).

### Tertiary (LOW confidence)
- WebSearch result summaries (not independently fetched in full) on: Prisma BigInt/JSON.stringify community discussions (prisma/studio#614, prisma/prisma#9793), general MySQL `ALTER TABLE MODIFY COLUMN` widen-safety commentary, NanoID collision-probability community explainers.

## Metadata

**Confidence breakdown:**
- Standard stack (BigInt PKs, no new packages installed this phase): HIGH — native Prisma schema-language feature, zero adapter caveats found, independently re-verified this session.
- Int→BigInt widen safety on MySQL/MariaDB: HIGH — the specific Postgres bug that would have raised concern is confirmed inapplicable via direct issue-content review; general MySQL DDL behavior for this operation is long-standing, documented, uncontroversial. MEDIUM only insofar as the actual `prisma migrate dev --create-only` output for THIS schema was not generated/inspected in this research session (that requires schema edits, which is plan/execution work).
- NanoID/uuidv5 generation seam design: HIGH for the architectural recommendation (Prisma `$extends` pattern is officially documented); MEDIUM for the exact package versions (`[ASSUMED]` per provenance rule since discovered via WebSearch, not Context7).
- MariaDB-adapter-specific caveats (JSON/Studio bug, `JSON`-as-`LONGTEXT`): MEDIUM — carried forward from prior research, sourced from GitHub issues and MariaDB's own docs, not re-fetched this session (no new information available, no contradicting information found).
- Pitfalls (general): HIGH — each pitfall traces to a specific, dated, sourced claim or a directly-observed repo fact, not general knowledge.

**Research date:** 2026-07-02
**Valid until:** 2026-08-01 (30 days — Prisma ships frequently; re-verify version-pinned claims and issue #18532/#29023 status if planning is delayed past this window)
