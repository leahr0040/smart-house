# Domain Pitfalls

**Domain:** Multi-tenant smart-home device-state & telemetry platform (Fastify 5 + Prisma + MariaDB)
**Researched:** 2026-06-25
**Confidence:** HIGH — drawn from project codebase analysis (CONCERNS.md, ARCHITECTURE.md), established patterns in IoT/telemetry systems, and MariaDB-specific constraints.

---

## Critical Pitfalls

Mistakes that cause rewrites, data loss, or security incidents.

---

### Pitfall 1: Cross-Tenant Data Leakage via Missing Ownership Checks

**What goes wrong:** A route fetches a device, room, or house by primary key (e.g. `GET /devices/:id`) without asserting that the record belongs to `request.user.id`. Any authenticated user can read or mutate any other user's data by guessing or incrementing IDs.

**Why it happens:** The service layer is pure — it takes an ID and returns a record. Developers write the service first, add the route, and forget that "authenticated" is not the same as "authorized". The existing CONCERNS.md already flags this: "No Authorization Checks — Endpoints have no ownership verification."

**Consequences:** Complete data exposure across all tenants. Because the hierarchy is deep (User → House → Room → Device → Event), a leak at any level cascades: access to a `deviceId` implies access to all its events.

**Prevention:**
- Build a single `assertOwnership(userId, entityId, entityType)` service helper — or inline the ownership join — before any mutation or read. Use Prisma's `findFirst({ where: { id, house: { userId } } })` pattern to do the ownership check and the fetch in one query.
- Never expose internal auto-increment IDs in the API. Use UUIDs (Prisma `@default(uuid())`). This closes the enumeration attack even if a check is missed.
- Add an integration test per route that proves a second user cannot access the first user's resource; treat this as a security regression gate.

**Warning signs:**
- Service functions accept only `id` with no `userId` parameter.
- Routes call `prisma.device.findUnique({ where: { id } })` without a `userId` join.
- No 403 test cases in the test suite.

**Phase:** Address in the house/room/device CRUD phase (Phase 1 entity modeling). Every new route must be ownership-verified before merge.

---

### Pitfall 2: Event Log Becomes a De Facto Audit Log Without a Retention Strategy

**What goes wrong:** The append-only `DeviceEvent` table grows unboundedly. A single active home with sensors reporting every 30 seconds accumulates ~2,900 rows/device/day. With 10 devices that is ~1 million rows/year. No retention policy means queries slow down, disk fills, and backups balloon — before the product reaches production scale.

**Why it happens:** Append-only is the right semantic choice, but "immutable" is conflated with "keep forever". The team ships Phase 1 without a plan, and by Phase 3 the table is already large enough that adding indexes is a painful online operation.

**Consequences:** Time-range queries degrade from milliseconds to seconds as the table crosses 10M rows without a covering index. Disk fills silently on a VPS. Migrations on a large table without `ALTER TABLE ... ALGORITHM=INPLACE` lock the table for minutes.

**Prevention:**
- Define retention policy at design time, not after the fact. Even v1 should have a `retentionDays` config per device type (or a global default: 90 days for sensor readings, indefinite for explicit commands).
- Add a `deviceEvents` table design with a composite index `(deviceId, recordedAt DESC)` from day one — this is the primary query pattern (latest N events for a device, or events in a time range).
- Add a background cleanup job (a simple cron or Fastify lifecycle hook) that hard-deletes rows older than the retention window. Use `DELETE ... LIMIT 1000` batches to avoid long-running transactions.
- Consider MariaDB table partitioning by month on `recordedAt` if event volume is expected to exceed 10M rows. Partition pruning makes time-range queries and bulk deletes orders of magnitude faster. This requires the partition key to be part of every unique/primary key — plan the schema with this in mind.

**Warning signs:**
- `DeviceEvent` table has no `recordedAt` index.
- No row count monitoring or alerting.
- Migration files contain unbounded `DELETE FROM device_events WHERE ...` without LIMIT.

**Phase:** Index and retention strategy in the event-history phase (Phase 2). Partitioning decision should be made during schema design, not after rows accumulate.

---

### Pitfall 3: Race Condition on Concurrent State Updates (Lost Update Problem)

**What goes wrong:** Two concurrent requests arrive for the same device — one from a user command ("turn AC on") and one from a sensor report ("temperature is 23°C"). Both read the current `DeviceState` record, both compute an update, and one silently overwrites the other's write. The winner is determined by timing, not intent.

**Why it happens:** Prisma's `update()` is not atomic when you read-then-write across two fields. The existing `RefreshToken` single-use race is flagged in CONCERNS.md as the same class of bug.

**Consequences:** A device appears to be in a state it never actually reached. The event log records both changes, but the current-state snapshot is wrong. An AI consumer trained on the history sees contradictory ground truth.

**Prevention:**
- Use `prisma.$transaction()` with `SELECT ... FOR UPDATE` (or Prisma's `$executeRaw` for a row lock) when updating current state. Alternatively, use optimistic concurrency: add a `version` integer column to `DeviceState`, increment it on every write, and reject the update if `version` does not match what was read.
- Separate current-state writes from event-log appends inside the transaction: write the event first (append-only, never fails due to conflict), then update the snapshot.
- For sensor telemetry specifically, consider "last-write-wins by timestamp": only update `DeviceState` if `event.recordedAt > currentState.lastUpdatedAt`. This is race-tolerant for most IoT use cases.

**Warning signs:**
- Device state update is a `findUnique` followed by an `update` without a transaction.
- No `version` or `updatedAt` column on `DeviceState`.
- Tests do not cover concurrent update scenarios.

**Phase:** Address during the command/record interaction design phase (before any state mutation routes ship). The transaction pattern must be in the service layer from the first write.

---

### Pitfall 4: Over-Rigid Device State Modeling (Enum Hell vs. Unvalidated JSON)

**What goes wrong:** Two failure modes pull in opposite directions:
1. **Enum hell**: A single `status` enum column (e.g. `ON | OFF | COOLING | HEATING`) is added for every device type. Adding a new device type (e.g. a robot vacuum with states `DOCKED | CLEANING | RETURNING | ERROR`) requires a migration. The schema becomes a graveyard of device-type-specific columns.
2. **Unvalidated JSON blob**: The opposite — all state is stored as a `JSON` or `TEXT` column with zero validation. The AI consumer later receives inconsistent shapes (`{ "on": true }` vs `{ "power": "on" }` vs `{ "state": 1 }`) and cannot reason about history.

**Why it happens:** Enum hell happens when developers default to SQL idioms. Unvalidated JSON happens when developers over-index on flexibility and skip validation.

**Consequences:** Either path leads to a schema rewrite. Enum hell means migrations for every new device type. Unvalidated JSON means the event history is unanalyzable — the AI milestone requires a pre-processing step to normalize years of inconsistent data.

**Prevention:**
The project has already made the right decision: "flexible storage + code-level enum validation per device type." Execute it correctly:
- Store state in a `VARCHAR` or `TEXT` column, not a native `JSON` column (MariaDB JSON support is less mature; TEXT is more portable for simple values, or use `JSON` only if you need server-side JSON path queries).
- Define a TypeBox discriminated union or per-type validator map in code (e.g. `DEVICE_STATE_VALIDATORS[deviceType]`). Every inbound state value passes through this before any DB write.
- For compound state (e.g. AC: `{ mode: 'cool', targetTemp: 22, fanSpeed: 'auto' }`), store as a JSON string but validate the shape against a typed schema before storing. Use a stable, versioned schema identifier alongside the value (a `stateSchemaVersion` column) so the AI consumer knows which shape to expect.
- Never store raw user-provided strings as state without normalizing to a canonical form first (e.g. always lowercase, always a known key).

**Warning signs:**
- `DeviceState` has more than 2 device-type-specific columns.
- State is stored as raw request body JSON without a validation pass.
- Two event rows for the same device type have structurally different JSON shapes.

**Phase:** Lock the state storage contract and validation architecture in the device modeling phase (Phase 1). Changing the storage shape after events are recorded requires a data migration of every historical row.

---

### Pitfall 5: Current-State / Event-History Divergence (Split-Brain)

**What goes wrong:** The `DeviceState` snapshot (current state) and the `DeviceEvent` log (history) are written in separate, non-atomic operations. A crash, exception, or timeout between the two writes leaves them inconsistent: the event is recorded but state is not updated (or vice versa).

**Why it happens:** Developers write the event append first ("that's the important part"), then update the state, and do not wrap both in a transaction.

**Consequences:** `GET /devices/:id/state` returns stale data while the event log shows a more recent change. An AI model trained on history predicts behavior that does not match the live system. Debugging requires cross-referencing two tables.

**Prevention:**
- Always write both the `DeviceEvent` insert and the `DeviceState` upsert inside a single `prisma.$transaction()`. If either fails, both roll back.
- The `DeviceState` table is a materialized view of the latest event — treat it as a projection. On startup or after a detected inconsistency, it should be rebuildable by replaying the latest event per device from `DeviceEvent`. Document this invariant.
- Add a consistency check endpoint (internal/admin) that verifies `DeviceState.value === lastEvent.newValue` for all devices. Run it in CI against a seeded database.

**Warning signs:**
- Service function has two separate `await prisma...` calls (one insert, one update) outside a transaction.
- No single source of truth documented — developers are unsure which table "wins" on conflict.

**Phase:** Phase 2 (command & record interaction). The transaction boundary must be established before any state-mutation endpoint ships.

---

## Moderate Pitfalls

---

### Pitfall 6: Timestamp / Timezone Chaos in Event Timelines

**What goes wrong:** Events are stored with server-side `new Date()` (UTC), device-reported timestamps (unknown timezone, possibly local time), and client query parameters in ISO 8601 with timezone offsets — all mixed together. Time-range queries return wrong results or miss events at timezone boundaries. The AI consumer gets an event timeline with unexplained 1–13 hour gaps.

**Why it happens:** Node.js `new Date()` is UTC. MariaDB `DATETIME` columns have no timezone awareness by default. Client code in a +2 timezone sends `?from=2024-01-01T00:00:00` and expects local midnight, but gets UTC midnight results.

**Prevention:**
- Store all timestamps as UTC in the database. Use MariaDB `DATETIME(3)` (millisecond precision) or `BIGINT` (Unix milliseconds) — not `TIMESTAMP`, which has a 2038 problem and MariaDB-specific auto-update behavior.
- Never trust device-reported timestamps without sanitization: clamp to `[now - 10 minutes, now + 1 minute]` to reject obviously wrong clock values.
- Accept only ISO 8601 with explicit timezone offset in API query params. Reject bare date strings without offset.
- Add a `recordedAt` (DB insertion time, always server UTC) alongside any `reportedAt` (device-claimed time) column. Use `recordedAt` as the canonical ordering key.

**Warning signs:**
- `TIMESTAMP` columns in the Prisma schema instead of `DateTime`.
- No timezone offset required in time-range query params.
- Two events from the same device have timestamps that go backwards.

**Phase:** Phase 2 schema design. The timestamp column types cannot be changed cheaply after the table has data.

---

### Pitfall 7: Missing Composite Index for Time-Range Queries

**What goes wrong:** The primary event query pattern is "give me all events for device X in the last 24 hours." Without a composite index on `(deviceId, recordedAt)`, MariaDB performs a full table scan or uses only one column's index. At 1M rows, a 24-hour window query takes seconds.

**Why it happens:** Prisma does not generate indexes automatically beyond primary keys and `@unique`. Developers add `@@index([deviceId])` alone and discover the `recordedAt` filter is still slow.

**Prevention:**
- Add `@@index([deviceId, recordedAt])` in `schema.prisma` from the first migration. The query planner uses this for both equality on `deviceId` and range on `recordedAt`.
- For the "latest N events" pattern, the index on `(deviceId, recordedAt DESC)` (MariaDB supports descending key parts in InnoDB) avoids a filesort.
- Add `@@index([houseId, recordedAt])` for house-level timeline queries (cross-device history for a home).
- Test query performance with 100K rows in CI using `EXPLAIN` to verify index usage before the table grows.

**Warning signs:**
- `schema.prisma` has `@@index([deviceId])` but no compound index with `recordedAt`.
- `EXPLAIN` on the time-range query shows `type: ALL` (full scan).

**Phase:** Phase 2 schema design. Adding an index later on a multi-million-row table is an online DDL operation that locks MariaDB for the duration unless `ALGORITHM=INPLACE` is used.

---

### Pitfall 8: Schema Decisions That Block Future AI Analysis

**What goes wrong:** The event history is stored in a way that makes bulk analytics impractical:
- State values are stored as opaque strings with no type metadata (cannot aggregate numeric sensor readings).
- Device type is not denormalized onto the event row (every AI query requires a join through Device → Room → House).
- There is no way to distinguish "commanded state change" from "sensor-reported reading" from the event log alone.

**Why it happens:** The v1 team defers AI concerns and optimizes purely for write simplicity.

**Consequences:** The AI milestone requires either a schema migration of existing event rows or a separate ETL pipeline to normalize the history. Either is expensive.

**Prevention:**
- Add an `eventKind` column to `DeviceEvent` from day one: `COMMAND` (user-initiated), `REPORT` (device-initiated), `SYSTEM` (housekeeping). This is a two-row enum, cheap to add now.
- Store `deviceType` on the event row (denormalized). It is a slowly-changing dimension; storing it on the event avoids a join on every analytics query.
- For numeric sensor values (temperature, humidity, etc.), store both a typed `numericValue DECIMAL(10,4)` and the canonical string in `stateValue`. The AI can aggregate numeric columns directly without parsing strings.
- Use a consistent `metadata JSON` column for AI-facing annotations rather than ad-hoc columns — but define the schema for this metadata in TypeBox from the start.

**Warning signs:**
- `DeviceEvent` has no `eventKind` or `deviceType` column.
- All state values are stored in a single opaque string column regardless of type.
- An AI feature requires a 3-table JOIN on the hot path.

**Phase:** Phase 2 event schema design. These columns are cheap to add now; they require a full table migration later.

---

### Pitfall 9: Authorization Gaps in the Nested Hierarchy

**What goes wrong:** The route checks that a house belongs to the user, but does not check that a room belongs to that house, or that a device belongs to that room. An attacker constructs a request that pairs a valid `houseId` they own with a `roomId` from another user's house.

**Why it happens:** Authorization is checked at the top level but not propagated down the hierarchy. Each level of the tree needs its own ownership join.

**Prevention:**
- Write a single service helper `resolveDevice(userId, deviceId)` that traverses the full chain: `Device → Room → House → User` in one Prisma query with nested `where` clauses. This is the only correct way to assert ownership of a leaf node.
- Never accept `roomId` or `houseId` as a query parameter without also verifying the caller owns it. Treat all IDs as untrusted input.

**Warning signs:**
- Service functions accept `houseId` as a parameter but do not join through to `userId`.
- Routes check `house.userId === request.user.id` but accept `roomId` from the body without a corresponding check.

**Phase:** Phase 1 CRUD. Establish the ownership helper before the first entity route ships; every subsequent route calls it.

---

## Minor Pitfalls

---

### Pitfall 10: Soft-Deleting Devices Without Preserving Event History

**What goes wrong:** A device is deleted (hard delete), and `ON DELETE CASCADE` removes all its `DeviceEvent` rows. The event history for a room or house suddenly has gaps. An AI trying to learn patterns from historical data loses context.

**Prevention:**
- Use soft deletes on `Device` (add `deletedAt DATETIME NULL`). Filter `deletedAt IS NULL` in normal queries, but never delete the row.
- Set Prisma relation mode to `NoAction` for `DeviceEvent → Device` to prevent cascade deletes at the ORM level.
- Events should reference `deviceId` for relational integrity, but treat events as independent of the device's lifecycle.

**Phase:** Phase 1 schema design (add `deletedAt` to Device from the start).

---

### Pitfall 11: Logging Device State in Plain Text (Sensitive Values)

**What goes wrong:** A device state like `{ "pin": "1234" }` or `{ "password": "abc" }` for a smart lock or alarm is stored in plain text in the event log and emitted in logs. Log aggregators or anyone with DB read access sees security credentials.

**Prevention:**
- Define a per-device-type "sensitive fields" list. Strip or hash sensitive fields before writing to `DeviceEvent.stateValue`.
- Never log full state values in Fastify request/response logging for device command endpoints. Use `redact` in Fastify logger config.

**Phase:** Phase 1 device type definitions (define the sensitive-field list alongside the validation schema for each device type).

---

### Pitfall 12: Prisma `$transaction` Not Used for Multi-Row Inserts

**What goes wrong:** A single user action (e.g. "reset all devices in room") triggers N separate `prisma.deviceEvent.create()` calls. If the process crashes mid-loop, some devices are updated and others are not. The house is in a partially-updated state with no way to detect which devices were affected.

**Prevention:**
- Use `prisma.$transaction([...operations])` for any bulk write that must succeed or fail atomically.
- For large bulk operations (N > 100), use `createMany` inside a transaction rather than N individual creates.

**Phase:** Any bulk command route (Phase 2+).

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|----------------|------------|
| House/Room/Device CRUD | Cross-tenant data leakage (Pitfall 1) | UUID PKs + ownership join on every read/write |
| House/Room/Device CRUD | Nested hierarchy authorization gap (Pitfall 9) | Single `resolveDevice(userId, deviceId)` traversal helper |
| Device modeling | Over-rigid enums or unvalidated JSON (Pitfall 4) | TypeBox validator map keyed by `deviceType` |
| Device modeling | Soft-delete missing on device (Pitfall 10) | `deletedAt` column from day one |
| Event schema design | Timestamps / timezone chaos (Pitfall 6) | `DATETIME(3)` UTC + `recordedAt` server time |
| Event schema design | Missing composite index (Pitfall 7) | `@@index([deviceId, recordedAt])` in first migration |
| Event schema design | AI-hostile schema (Pitfall 8) | `eventKind`, `deviceType`, `numericValue` columns |
| Command & record | Current-state / event-history split-brain (Pitfall 5) | `prisma.$transaction()` for every state mutation |
| Command & record | Race condition on concurrent updates (Pitfall 3) | Optimistic concurrency or `SELECT FOR UPDATE` |
| Event log (ongoing) | Unbounded table growth (Pitfall 2) | Retention policy + composite index in Phase 2 |
| Bulk commands | Partial write on multi-device operations (Pitfall 12) | `$transaction` for all multi-row writes |

---

## Sources

- Project codebase analysis: `.planning/codebase/CONCERNS.md` (existing race condition, authorization, and index gaps)
- Project architecture: `.planning/codebase/ARCHITECTURE.md` (service layer patterns, Prisma singleton)
- Project requirements: `.planning/PROJECT.md` (multi-tenant, append-only event history, AI future consumer)
- Domain knowledge: IoT telemetry system design patterns, MariaDB InnoDB index behavior, Prisma transaction semantics

*Confidence: HIGH for pitfalls 1–9 (directly grounded in codebase analysis and well-established domain patterns). MEDIUM for pitfalls 10–12 (likely to matter but depend on feature choices not yet fully specified).*
