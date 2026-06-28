# Domain Pitfalls

**Domain:** Multi-tenant smart-home event-driven platform (Fastify 5 + MariaDB projection + MongoDB events + RabbitMQ)
**Researched:** 2026-06-28
**Confidence:** HIGH — grounded in project codebase analysis (CONCERNS.md, PROJECT.md, REQUIREMENTS.md) and established patterns in event-driven IoT/CQRS systems.

> **⚠ 2026-06-28 UPDATE (b) — supersedes parts of this document.** The data model was refined after this doc was written. Where this document conflicts with the points below, the points below win (PROJECT.md / REQUIREMENTS.md are authoritative).
>
> - **No desired/reported twin.** Each device has a SINGLE current-state record, updated on report. "Desired"/pending lives on the `commands` table. All `desired_*` / `reported_*` columns and `sync_status` are removed.
> - **Current state via polymorphic morph** (`state_type` + `state_id` → per-type detail tables); no JSON; loose FK integrity acceptable (rebuildable projection).
> - **`user_id` denormalized on Room and Device** (no ownership joins; batched `IN`, no N+1). **Soft delete (`deleted_at`)** on User/House/Room/Device. **Atomic guarded updates** (single conditional `UPDATE … WHERE last_event_at < :incoming`); event idempotency via Mongo unique index.
> - **Pitfalls impact:** the **twin-drift** pitfall (desired never confirmed → stale) is now **MOOT** — there is no twin. **Dual-store consistency** still applies (the single-facet current-state projection is still synced from the event log) but is simpler. **New pitfalls to track:** (1) forgetting to filter `deleted_at` in a read → soft-deleted rows leak; (2) failing to set the denormalized `user_id` at create / treating it as mutable → ownership drift; (3) a soft-deleted user retaining a valid JWT until expiry → check `deleted_at` on auth.

---

## Superseded Pitfalls (From Previous Version — Now Moot)

The following pitfalls from the 2026-06-25 PITFALLS.md are **superseded** by the architectural pivot to event-driven / dual-store:

| Old Pitfall | Why It No Longer Applies |
|-------------|--------------------------|
| **Pitfall 5: Current-State / Event-History Split-Brain via `prisma.$transaction()`** | The new design explicitly drops DB transactions. Events are appended to MongoDB; the MariaDB projection is a derived view that can be rebuilt. The "wrap both in `$transaction`" remedy is moot — the stores are different databases. The split-brain risk still exists but is addressed differently (see Pitfall 1 below). |
| **Pitfall 3: Race Condition / `SELECT FOR UPDATE`** | Replaced by the at-least-once + idempotent consumer model (see Pitfall 4). Row-level DB locking is no longer the remedy; message ordering and idempotency keys are. |
| **Pitfall 12: `prisma.$transaction` for Multi-Row Inserts** | Bulk fan-out is now handled by publishing N messages to RabbitMQ; the atomicity contract is best-effort fan-out per the project's own requirement (CMD-04). The old `$transaction([...])` advice does not apply to cross-store operations. |
| **Pitfall 7: MariaDB Composite Index on Event Table** | The event table is now MongoDB, not MariaDB. MongoDB index strategy is addressed in Pitfall 11. The MariaDB composite-index advice still applies narrowly to the twin-state projection tables (noted in Pitfall 11). |

All other old pitfalls either remain valid in updated form or are subsumed into the new pitfalls below.

---

## Critical Pitfalls

Mistakes that cause rewrites, data loss, or security incidents.

---

### Pitfall 1: Dual-Store Consistency — Event Written to MongoDB but Projection Not Updated (or Vice Versa)

**What goes wrong:** The report consumer appends an event to MongoDB then updates the MariaDB twin-state projection in two separate awaits. A crash, connection timeout, or uncaught exception between them leaves the stores inconsistent: the event is recorded but the projection is stale, or (worse) the projection is updated but no event was ever written.

**Why it happens:** There is no cross-store transaction. Developers treat the two writes as sequential steps in the same function and assume they will both succeed. The "events are source of truth" principle is declared but not enforced — nothing prevents the projection write from happening first.

**Consequences:** `GET /devices/:id/state` returns stale desired/reported values while the event log shows a more recent change. If the projection write happened without the event write, there is no audit trail — the state changed silently with no history. Projection rebuild from the event log (EVENT-06) then produces a different result than the live projection, which is the clearest symptom of this failure.

**Prevention:**
- Establish a strict write order invariant in the report consumer: **append to MongoDB first, update MariaDB projection second, always.** If the projection update fails, the event is still durable; the projection can be rebuilt. If the event append fails, abort and do not touch the projection — let the message be nacked for retry.
- The report consumer should be structured as: `try { await appendEvent(mongo, event); } catch { nack(msg); return; } await upsertProjection(prisma, state); // failure here is tolerable — projection is rebuildable`
- Implement the projection rebuild path (EVENT-06) early, not as a future nice-to-have. Run it in staging against a known event log and verify it produces the same projection as the live system. This is your consistency smoke test.
- Add a `last_event_id` column (MongoDB ObjectId as string) to the twin-state projection row. On each upsert, store the event id that caused the update. A background reconciliation job can scan for projection rows whose `last_event_id` does not match the latest event for that device in MongoDB.

**Warning signs:**
- Report consumer has `await mongo.insertOne(event)` and `await prisma.update(projection)` in the same try block with no ordered abort logic.
- No projection rebuild script exists or has never been tested.
- `GET /device/:id` and the latest MongoDB event for that device disagree on state.

**Phase:** Messaging/report-consumer phase (MSG-04). The write-order contract must be codified in the consumer before it processes its first real message.

---

### Pitfall 2: Cross-Tenant Ownership Leakage via MongoDB Queries Without Prior MariaDB Resolution

**What goes wrong:** An event-history route queries MongoDB directly with a `deviceId` supplied by the caller without first verifying in MariaDB that the caller owns that device. Any authenticated user can read any device's event history by guessing or enumerating device IDs.

**Why it happens:** MongoDB has no concept of the user → house → room → device ownership chain. Ownership lives entirely in MariaDB. Developers reach for a Mongo query directly because "I already have the deviceId," skipping the ownership step. The existing CONCERNS.md flags this in general: "No Authorization Checks — Endpoints have no ownership verification." With MongoDB in the picture, this gap is now cross-store.

**Consequences:** Complete event-history exposure across tenants. Because events contain state snapshots, a leak exposes not just the fact of ownership but every device reading, command, and behavior pattern — a much richer data leak than leaking a room name.

**Prevention:**
- Enforce a non-negotiable two-step contract on all event-history endpoints: (1) resolve the requested `deviceId(s)` to `ownedDeviceIds` using a MariaDB ownership query (`Device findFirst({ where: { id, room: { house: { userId } } } })`); (2) use only the verified `ownedDeviceIds` in the MongoDB query. Never pass caller-supplied IDs directly to Mongo.
- For bulk queries (e.g. "all events for a room"), resolve the full owned device set in MariaDB first, then query MongoDB with `deviceId: { $in: ownedDeviceIds }`.
- Write an integration test that proves a second user's `deviceId` returns 404 (not 403 — do not confirm existence) from the event-history endpoint when queried by a different user.
- This two-step pattern should be a named service function (`resolveOwnedDeviceIds(userId, ...ids)`), not inline logic in route handlers.

**Warning signs:**
- Event-history route accepts `deviceId` as a path param and queries MongoDB in the same handler without a Prisma lookup first.
- Service functions accept `deviceId` with no `userId` parameter.
- No cross-tenant 404 test cases for `/events` endpoints.

**Phase:** Event-history phase (EVENT-03). Must be established before any event query endpoint ships. Also enforce in the command handler for CMD-02 (selector resolution).

---

### Pitfall 3: Device Identity Spoofing on the Reports Queue

**What goes wrong:** The reports queue accepts a message claiming to be from `deviceId: "abc123"`. There is no per-device credential on the message. Any process with RabbitMQ connection credentials can publish a fabricated report for any device, updating its twin state and inserting forged events.

**Why it happens:** The project defers the "device identity/auth" open decision (noted in PROJECT.md). In the meantime, the report consumer trusts the `deviceId` field in the message body at face value.

**Consequences:** An attacker with internal network access (or a compromised simulated device worker) can forge reports: set any device to any state, flood the event history with garbage, or produce a false audit trail. For a smart-home system this could mean forged "door locked" events while the door is open.

**Prevention:**
- Resolve this open decision in the messaging phase. The minimum viable protection: the report consumer validates that the `deviceId` in the message body exists in MariaDB and is not soft-deleted, before processing the report. This prevents reporting for non-existent or deleted devices but does not prevent a legitimate-looking spoof.
- For stronger protection (recommended for v1 despite hardware being simulated): assign each device a shared secret at provisioning time. The simulated worker signs its reports with this secret; the consumer verifies. This is the same contract real hardware will need in v2, so it costs nothing extra to design it now.
- Regardless of auth level chosen, the consumer must never trust a `deviceId` that does not exist in the MariaDB device registry.

**Warning signs:**
- Report consumer calls `mongodb.insertOne(event)` without a prior `prisma.device.findFirst({ where: { id: event.deviceId } })` existence check.
- Simulated worker publishes reports using a hardcoded `deviceId` string with no credential.

**Phase:** Messaging phase (MSG-03, MSG-04). The open decision on device identity must be resolved before the report consumer is implemented.

---

### Pitfall 4: Idempotency Failure — Duplicate Reports Produce Duplicate Events

**What goes wrong:** RabbitMQ delivers messages at-least-once. A report message is processed successfully (event appended, projection updated), but the consumer crashes before sending the ack. RabbitMQ redelivers the message. The consumer processes it again, appending a second identical event and potentially double-updating the projection. The event log now has two identical events for the same state change.

**Why it happens:** At-least-once delivery is a fundamental RabbitMQ guarantee. Without explicit deduplication, every consumer restart or network hiccup is a potential duplicate.

**Consequences:** The event history contains duplicate entries. Projection rebuild (EVENT-06) produces incorrect state if it replays duplicates. The AI consumer trained on history sees phantom state changes that never happened. Command completion tracking (CMD-05) may double-count completions.

**Prevention:**
- Every event document must carry a deterministic idempotency key (`idem_key`) derived from the message content: e.g. `sha256(deviceId + commandId + eventKind + reportedAt)`. Before inserting, check MongoDB for an existing document with the same `idem_key` (unique index). If it exists, skip the insert and ack the message — the message was already processed.
- The unique index on `idem_key` in MongoDB makes the duplicate check a single indexed lookup, not a full scan.
- For the MariaDB projection upsert, "last-write-wins by event timestamp" is naturally idempotent: only apply the upsert if the incoming event's `recorded_at` is newer than the current projection's `last_event_at`. Stale redeliveries are ignored.
- Test by manually redelivering a message to the consumer and verifying exactly one event exists in MongoDB.

**Warning signs:**
- Event documents have no unique identifier derived from message content — only MongoDB's auto-generated `_id`.
- No `idem_key` unique index on the events collection.
- Consumer has no "already processed" check before insert.

**Phase:** Messaging phase (MSG-04). Idempotency must be in the consumer from the first message it processes — retrofitting it after duplicate events exist requires a deduplication migration.

---

### Pitfall 5: Poison Message / Retry Storm — Malformed Report Crashes Consumer, Blocks Queue

**What goes wrong:** A malformed report message (missing required fields, invalid `deviceId`, schema violation) is consumed, throws a validation error, is nacked with `requeue: true`, immediately redelivered, throws again — in a tight loop. The consumer spends all its time reprocessing one bad message, starving all valid messages behind it.

**Why it happens:** Nacking with `requeue: true` is the simplest error path but creates an infinite retry loop for non-transient errors. Malformed messages are permanently malformed — retrying them never helps.

**Consequences:** The reports queue backs up. Twin state stops updating for all devices. Commands appear to hang indefinitely (CMD-05 shows all devices as "pending"). If the consumer crashes, RabbitMQ requeues everything, and on restart the poison message is the first thing processed again.

**Prevention:**
- Distinguish transient errors (DB connection refused, Mongo timeout) from permanent errors (schema validation failure, device not found). For permanent errors: nack with `requeue: false` to send the message to the Dead Letter Queue (DLQ). For transient errors: nack with `requeue: true`, but enforce a per-message retry limit using a `x-death` header count (RabbitMQ populates this automatically on DLQ routing).
- MSG-01 already requires a DLQ in the topology. Wire it: `x-dead-letter-exchange` on the reports queue pointing to a `reports.dlq` queue. Consume the DLQ separately for alerting and manual inspection.
- Add an exponential backoff for transient retries (RabbitMQ does not backoff by default). Use a delayed retry pattern: nack to DLQ with a TTL, which re-routes back to the main queue after a delay.
- Set a maximum retry count (3–5 attempts via `x-death` inspection). After max retries, park the message in a permanent dead-letter store (could be a separate MongoDB collection `failed_messages`) for manual review.
- Emit a metric/log on every DLQ routing event. A spike in DLQ entries is an early warning of a systemic problem.

**Warning signs:**
- Consumer has a single `catch` block that nacks with `requeue: true` for all error types.
- No DLQ is configured despite MSG-01 requiring one.
- CPU on the consumer process is 100% with zero throughput.
- RabbitMQ management UI shows the same message being delivered hundreds of times.

**Phase:** Messaging phase (MSG-01, MSG-05). DLQ topology and the nack/ack strategy must be designed before the consumer processes real messages.

---

### Pitfall 6: Message Ordering — Out-of-Order Reports Corrupt Twin State

**What goes wrong:** Device D sends report R1 ("turned on") then report R2 ("turned off"). Due to network jitter or parallel consumer instances, R2 is processed before R1. The projection is updated to "off" then overwritten with "on." The device is incorrectly shown as "on" even though the last actual report said "off." The event log records both in insertion order, which is not arrival order.

**Why it happens:** RabbitMQ FIFO ordering is guaranteed only within a single queue and a single consumer. If there are multiple consumer instances, or if messages are published to different queues/partitions, ordering is not guaranteed. Even with one consumer, nack+requeue can alter effective ordering.

**Consequences:** Twin state (desired/reported/sync_status) is wrong. The system tells the user their light is on when it is off. Commands based on current state ("if off, turn on") make incorrect decisions.

**Prevention:**
- For per-device ordering, include a monotonic sequence number (`seq`) in every device report. The consumer only applies a report to the projection if `seq > currentProjection.last_seq`. Out-of-order messages with a lower seq are acknowledged but their projection update is skipped (the event is still recorded for history).
- Do not run multiple parallel consumers against the same reports queue unless you implement consumer-group partitioning by `deviceId` (i.e. route all reports for a device to the same consumer instance). For v1 with a simulated worker, a single consumer instance is fine and simplest.
- The `recorded_at` (server insertion timestamp) in MongoDB will be in processing order, not device-clock order. Store both `reported_at` (device-claimed) and `recorded_at` (server time). Use `recorded_at` as the canonical event ordering key.

**Warning signs:**
- Twin state projection has no `last_seq` or `last_event_at` column to guard against stale overwrites.
- Multiple consumer processes are running against the same queue without partitioning.
- Events in MongoDB have `reported_at` values that are non-monotonic for the same device.

**Phase:** Messaging phase (MSG-04). The sequence/timestamp guard must be in the projection upsert logic before the first report is processed.

---

## Moderate Pitfalls

---

### Pitfall 7: Desired-vs-Reported Twin Drift — Commands That Are Never Confirmed

**What goes wrong:** A command sets `desired_state = "on"` for a device. The effect is published to RabbitMQ. The simulated worker never processes it (worker is down, message is lost, DLQ is not monitored). The device is permanently `sync_status = "pending"` — desired and reported diverge forever. The user sees the device as "syncing" indefinitely with no explanation.

**Why it happens:** The async confirmation path (effect → worker → report → consumer → projection) has multiple failure points. There is no timeout or watchdog on the desired state. The command-handler publishes and forgets.

**Consequences:** The user's UI (future frontend) shows incorrect sync state. Bulk commands ("turn off all lights") appear to hang. Command status (CMD-05) never transitions from "pending" to "done." Over time, a growing number of devices are stuck in "pending."

**Prevention:**
- Every desired-state update should record a `desired_at` timestamp and a `command_id`. A background watchdog (or a cron job in Fastify lifecycle) scans for devices where `sync_status = 'pending'` AND `desired_at < now - timeout` (e.g. 60 seconds). These are flagged as `sync_status = 'timeout'` or `'failed'`.
- The command status endpoint (CMD-05) should reflect this: per-device completion rolls up "pending," "done," "timeout," and "failed."
- For v1 with a simulated worker, the timeout can be generous (30–60 seconds). The key is that the "forever pending" state is not a valid terminal state.
- Do not conflate "command published" with "command delivered." Use RabbitMQ publisher confirms (mandatory delivery acknowledgment from the broker) to verify the effect was actually enqueued. If the broker rejects the publish, the command handler must surface a 500, not silently succeed.

**Warning signs:**
- `sync_status` column has no `timeout` or `failed` value, only `pending` and `synced`.
- Command handler does not use publisher confirms (fire-and-forget publish).
- Devices accumulate `sync_status = 'pending'` in the DB with no recovery path.

**Phase:** Messaging phase (MSG-02) for publisher confirms; command-status phase (CMD-05) for the watchdog and timeout states.

---

### Pitfall 8: Projection Lag — Stale State Reads During High Throughput

**What goes wrong:** Under load, the report consumer falls behind. A user queries `GET /devices/:id/state` and receives the projection from 30 seconds ago even though the device has sent 10 reports since then. The API presents stale data as if it were current.

**Why it happens:** The projection is updated asynchronously by the consumer. If the consumer queue depth grows (slow DB writes, high report rate), the projection age increases. The API has no way to know if its projection is fresh.

**Consequences:** Users see devices in states they are no longer in. Automation logic built on top of the API makes decisions based on stale data. The "system always reflects the true current state" core value is violated.

**Prevention:**
- Add a `projection_updated_at` timestamp to each projection row. Expose it in the `GET /device/:id/state` response. This lets clients know how fresh the data is and decide whether to retry.
- For v1 with a simulated worker and low throughput, this is a monitoring concern, not an architectural one. The key is visibility.
- If lag becomes a problem at scale, the fix is consumer throughput: batch projection upserts, use a connection pool sized to the consumer concurrency, and monitor queue depth in RabbitMQ management UI.
- Do not attempt to make state queries "consistent" by reading from MongoDB at query time — this defeats the purpose of the projection and reintroduces the query-time ownership-join problem across stores.

**Warning signs:**
- RabbitMQ queue depth for reports is growing rather than staying near zero.
- `projection_updated_at` is consistently many seconds behind `recorded_at` in MongoDB.
- Consumer process has high DB write latency.

**Phase:** Observability concern for the messaging phase; add `projection_updated_at` during projection schema design (STATE-02).

---

### Pitfall 9: Lost Unacked Messages on Consumer Restart

**What goes wrong:** The report consumer holds 50 unacked messages (being processed) and crashes. RabbitMQ requeues all of them. On restart, the consumer processes them again. Without idempotency (Pitfall 4), this produces 50 duplicate events. Even with idempotency, the reprocessing spike can cause a thundering-herd effect on the DB.

**Why it happens:** RabbitMQ's `prefetch` (QoS) setting controls how many unacked messages the consumer holds. The default is unlimited, meaning a single consumer can hold thousands of in-flight messages — all of which requeue on crash.

**Prevention:**
- Set `channel.prefetch(1)` (or a small number like 5–10) on the consumer channel. This limits the number of in-flight messages per consumer, bounding the requeue blast radius on crash.
- Combined with idempotency (Pitfall 4), reprocessing is safe — just slower during the recovery burst.
- For v1, `prefetch(1)` is the correct default: simplest to reason about, correct ordering per device within a single consumer, and minimal requeue blast.

**Warning signs:**
- RabbitMQ channel has no QoS / `prefetch` setting (defaults to unlimited).
- On consumer restart, a sudden spike of DB writes and Mongo inserts occurs simultaneously.

**Phase:** Messaging phase (MSG-04) — set prefetch in the consumer channel initialization.

---

### Pitfall 10: MongoDB Event Schema Decisions That Block Future AI

**What goes wrong:** Events are stored with an opaque `payload: {}` blob, no `event_kind` field, no `device_type` denormalization, and numeric sensor readings stored only as strings. The AI milestone requires aggregating "all temperature readings over 30 days for device X" and finds it cannot do this without parsing strings and joining across collections.

**Why it happens:** v1 optimizes for write simplicity. The team defers AI concerns, then discovers the schema cannot support aggregation queries without a full ETL migration of all historical events.

**Consequences:** The AI milestone requires either a schema migration of existing event documents (expensive at scale) or a separate ETL pipeline to normalize history. Either breaks the "events are immutable" invariant or adds significant operational complexity.

**Prevention:**
- The EVENT-01 required fields (`source`, `event_kind`, `device_id`, `device_type`, `command_id`, snapshot, `recorded_at`) are already correct. Do not skip any of them for convenience.
- For numeric sensor readings, store both `numeric_value: number` and the canonical string in the snapshot. MongoDB's `$avg`, `$sum`, and time-series aggregations require native numeric fields.
- Use MongoDB time-series collections for sensor telemetry if the collection will receive high-frequency writes. Time-series collections have built-in bucketing, automatic `_id` optimization for time-range queries, and columnar compression. Decide this at collection-creation time — it cannot be changed after data is written.
- Add a `schema_version: 1` field to every event document from day one. When the schema evolves, increment the version and write a migration script. The AI consumer can branch on `schema_version`.
- Denormalize `device_type` on the event document (it is a slowly-changing dimension). Every AI query pattern starts with "for devices of type X" — avoiding a join to MariaDB on every analytics query is critical.

**Warning signs:**
- Event documents have no `event_kind` field.
- Sensor readings are stored as `"state": "23.5"` (string) with no numeric field.
- Event collection is created as a regular collection when high-frequency sensor writes are expected.
- Two event documents for the same device type have structurally different payloads.

**Phase:** Event-history phase (EVENT-01). Schema decisions cannot be changed after events are written without a migration of every document.

---

### Pitfall 11: Timestamp and Timezone Chaos Across Three Stores

**What goes wrong:** Events are recorded at `recorded_at` (server UTC from Node.js `Date.now()`). MariaDB projection stores `updated_at` in `DATETIME` with no timezone context. Device reports include `reported_at` from the device clock (unknown timezone, possibly system local time). API query params accept bare date strings without timezone offset. Time-range queries miss events at timezone boundaries or return wrong results.

**Why it happens:** Three stores with three different timestamp conventions. Node.js `new Date()` is UTC. MariaDB `DATETIME` has no TZ. MongoDB's `Date` is always UTC. Device clocks may be misconfigured.

**Prevention:**
- Store all timestamps as UTC everywhere. In MongoDB, use native `Date` (always UTC). In MariaDB, use `DATETIME(3)` — not `TIMESTAMP` (2038 problem) and not bare `DATETIME` (no millisecond precision for high-frequency reports).
- Always store both `recorded_at` (server time, authoritative) and `reported_at` (device-claimed time, untrusted) on every event. Use `recorded_at` as the canonical sort and range key.
- Sanitize device-reported timestamps: reject any `reported_at` more than 5 minutes in the past or any time in the future. Replace with `recorded_at` if the device clock is implausible.
- API time-range filter params must require an explicit UTC offset (ISO 8601 with `+HH:MM` or `Z`). Reject bare date strings at the TypeBox schema validation level.
- This pitfall from the old PITFALLS.md (Pitfall 6) remains fully valid; the only change is that the canonical store for events is now MongoDB, so the `recorded_at` field lives there rather than in MariaDB.

**Warning signs:**
- MongoDB event documents store `recorded_at` as a string instead of a native `Date`.
- MariaDB projection uses `TIMESTAMP` columns.
- API accepts `?from=2024-01-01` without a timezone offset.
- Two events from the same device have `reported_at` values that go backwards in time.

**Phase:** Event-history phase and messaging phase — establish the timestamp contract in the event schema before any messages are processed.

---

### Pitfall 12: Command Selector Resolution Leaking Cross-Tenant Device IDs

**What goes wrong:** A command is issued with a room-level selector (`roomId: "xyz"`). The command handler queries all devices in that room without verifying the room belongs to the requesting user. Effects are published for devices the user does not own.

**Why it happens:** Selector resolution is a multi-step fan-out (room → devices, house → all rooms → all devices). Each step is a DB query. Developers write the fan-out logic and forget that every intermediate entity must be ownership-verified.

**Consequences:** A user can trigger commands on another user's devices. In an IoT context this is not just a data leak — it is physical actuation of someone else's property.

**Prevention:**
- Selector resolution (CMD-02) must always anchor to `userId`. The query pattern: `Device.findMany({ where: { room: { id: roomId, house: { userId } } } })`. Never `Device.findMany({ where: { roomId } })` without the ownership chain.
- The `resolveOwnedDeviceIds(userId, selector)` service function described in Pitfall 2 should be the single code path for all selector types (explicit ids, room, house, type filter).
- Test with a cross-tenant selector: user A issues a command with user B's `roomId`. The resolved device set must be empty (no error, just zero devices), resulting in a 400 (no valid targets) or an empty fan-out per product decision.

**Warning signs:**
- Command handler queries devices by `roomId` without joining through `house.userId`.
- Selector resolution is inline in the route handler rather than a shared service function.
- No cross-tenant command test case.

**Phase:** Commands phase (CMD-02). Must be correct before any command is dispatched.

---

## Minor Pitfalls

---

### Pitfall 13: Soft-Deleting Devices Without Preserving Event History

**What goes wrong:** A device is hard-deleted. MongoDB events referencing that `deviceId` become orphaned — no corresponding device record exists. Event-history queries that join back to MariaDB for metadata (name, type, location) fail silently or return nulls. The AI consumer loses context for historical readings.

**Prevention:**
- Use soft deletes on `Device` (add `deleted_at DATETIME NULL` in MariaDB). Normal queries filter `deleted_at IS NULL`; event-history queries do not filter by `deleted_at` so orphaned-device history remains accessible.
- MongoDB events must store enough denormalized context (`device_type`, optionally `room_id`, `house_id`) so they are useful even after the device record is gone from MariaDB.
- Never cascade-delete events on device removal.

**Phase:** Device entity phase (DEV-04 soft delete). Add `deleted_at` from the first device migration.

---

### Pitfall 14: RabbitMQ Topology Not Provisioned on Boot

**What goes wrong:** The app starts without the effects exchange, reports queue, or DLQ existing in RabbitMQ. The first publish attempt throws a channel error (AMQP `406 PRECONDITION_FAILED` or `404 NOT_FOUND`). The app appears to start cleanly but silently drops all messages.

**Prevention:**
- MSG-01 requires boot-time topology provisioning. Use `assertExchange` and `assertQueue` with `durable: true` on every app start. These calls are idempotent — safe to call on every boot even if the topology already exists.
- Assert the DLQ binding before asserting the main queue so the DLQ target exists before the main queue references it.
- Add a topology health check to the Fastify startup sequence: if topology provisioning fails, do not start the HTTP server. Fail fast.

**Warning signs:**
- `channel.publish()` is called before any `assertExchange()`.
- App starts successfully but the first command produces no visible effect.
- RabbitMQ management UI shows no matching exchange or queue.

**Phase:** Messaging infrastructure phase (MSG-01).

---

### Pitfall 15: Logging Device State Values in Plain Text

**What goes wrong:** A device state like `{ "pin": "1234" }` for a smart lock appears in Fastify request logs, RabbitMQ message debug logs, or MongoDB documents. Log aggregators expose security credentials.

**Prevention:**
- Define a per-device-type sensitive field list alongside the TypeBox validator. Strip or redact sensitive fields before writing to MongoDB events and before logging.
- Configure the Fastify logger `redact` option for device-command endpoint request/response bodies.
- Never log full RabbitMQ message payloads at `info` level — log only the `deviceId` and `eventKind`.

**Phase:** Device-type definition phase (DEV-05 TypeBox schemas). Define the sensitive-field list alongside the validation schema for each device type.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|----------------|------------|
| House/Room/Device CRUD | Cross-tenant data leakage (Pitfall 2, 12) | `resolveOwnedDeviceIds(userId, ...)` — single shared helper, called everywhere |
| Device modeling | Soft-delete missing (Pitfall 13) | `deleted_at` column from first device migration |
| Device modeling | AI-hostile schema (Pitfall 10) | `event_kind`, `device_type`, `numeric_value` on every event doc from day one |
| Messaging infra | Topology not provisioned (Pitfall 14) | `assertExchange` + `assertQueue` on boot; fail-fast if missing |
| Messaging infra | Poison messages / retry storm (Pitfall 5) | DLQ binding + permanent-vs-transient error distinction in consumer |
| Messaging infra | Unacked message blast on restart (Pitfall 9) | `channel.prefetch(1)` on consumer channel |
| Report consumer | Dual-store consistency (Pitfall 1) | Mongo write first, Prisma upsert second; nack on Mongo failure |
| Report consumer | Duplicate event on redelivery (Pitfall 4) | Idempotency key (`idem_key`) with MongoDB unique index |
| Report consumer | Out-of-order reports (Pitfall 6) | Sequence number or `last_event_at` guard on projection upsert |
| Report consumer | Device spoofing (Pitfall 3) | Validate `deviceId` exists in MariaDB before processing |
| Command handler | Cross-tenant selector resolution (Pitfall 12) | All selector resolution anchored to `userId` in the DB query |
| Command handler | Commands never confirmed (Pitfall 7) | Publisher confirms + `sync_status: 'timeout'` watchdog |
| Event history | Cross-tenant Mongo query (Pitfall 2) | Two-step: resolve owned IDs in MariaDB, then query Mongo |
| Event schema | Timestamp chaos (Pitfall 11) | `recorded_at` (server UTC) + `reported_at` (device, untrusted); `DATETIME(3)` in MariaDB |
| Event schema | AI-blocking schema (Pitfall 10) | Time-series collection decision at creation time; `numeric_value`; `schema_version` |
| State projection | Projection lag visibility (Pitfall 8) | `projection_updated_at` on projection row; expose in state API response |

---

## Sources

- Project architecture: `.planning/PROJECT.md` (event-driven, dual-store, no DB transactions, multi-tenant from day one)
- Project requirements: `.planning/REQUIREMENTS.md` (MSG-01–05, EVENT-01–06, CMD-01–05, STATE-01–05)
- Project codebase analysis: `.planning/codebase/CONCERNS.md` (no authorization checks, existing fragile areas)
- Domain knowledge: CQRS/event-sourcing projection patterns, RabbitMQ at-least-once delivery semantics, MongoDB time-series collection constraints, IoT device identity and spoofing threat models, dual-write consistency patterns without cross-store transactions

*Confidence: HIGH for Pitfalls 1–6 (directly follow from the architecture's explicit design choices and are well-established failure modes in event-driven systems). HIGH for Pitfalls 7–12 (grounded in specific requirements and IoT/messaging domain patterns). MEDIUM for Pitfalls 13–15 (likely to matter but lower severity / more straightforward to prevent).*
