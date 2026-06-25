# Feature Landscape

**Domain:** Multi-tenant smart-home device-state and telemetry platform (API-only, v1)
**Researched:** 2026-06-25
**Confidence:** HIGH (domain well-understood from comparable platforms: Home Assistant, AWS IoT, Azure IoT Hub, Google Home API, Apple HomeKit, SmartThings, OpenHAB, Tuya Cloud)

---

## Table Stakes

Features users/consumers expect from any device-state platform. Missing any of these leaves the platform feeling half-built or unusable.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| User → House → Room → Device hierarchy | Every home-automation platform models this containment tree; clients navigate by it | Med | Must be multi-tenant from day one — retrofitting ownership scoping is expensive |
| CRUD for houses | Users manage multiple properties; basic lifecycle needed | Low | Soft-delete or hard-delete — decide once and stay consistent |
| CRUD for rooms | Rooms are the organizational unit clients query most often | Low | Rooms belong to exactly one house |
| CRUD for devices | Devices are the core entity; must support add, rename, remove, re-assign to room | Med | Device type is immutable after creation (type determines valid state shape) |
| Device type catalog | Clients need to know what device types exist and what state fields each type carries | Low | Even a hard-coded enum list ships this feature; a DB-backed catalog is a differentiator |
| Current-state read (single device) | The atomic query — "what state is this device in right now?" | Low | Must be O(1) / single-row lookup, not derived from event log |
| Current-state read (room scope) | Clients display a room view — all device states for a room in one call | Low | Avoids N+1 calls from the client |
| Current-state read (house scope) | Dashboard view — full snapshot of the house in one call | Med | Should return nested structure: house → rooms → devices → state |
| Command a device (state-change request) | The write path — "turn this AC on", "set thermostat to 22°C" | Med | Validated against device type's allowed state shape; recorded as an event |
| Report device telemetry / sensor reading | Device pushes a reading (temperature sensor, motion sensor); updates current state | Med | Different actor than a command (device vs. user); must be distinguishable in the event log |
| Per-device-type state validation | Each device type has a fixed set of valid state fields and value constraints | Med | Enforced in code (TypeBox enums), not as DB columns — keeps history table uniform |
| Append-only event log | Every state change and sensor reading recorded immutably | Med | The audit trail and AI training corpus; never edit or delete rows |
| Event log query — by device | "Show me every event for device X" | Low | Paginated; default descending (newest first) |
| Event log query — by time range | "What happened between T1 and T2?" | Low | Must support both absolute timestamps |
| Event log query — by room | Aggregate history for all devices in a room | Med | Requires join; can be slow on large data — index on (room_id, timestamp) |
| Multi-tenancy enforcement | No user sees or modifies another user's data | Med | Row-level: every house/room/device/event row carries an owner user_id that is always checked |
| 404 for owned-but-not-found vs. 403 for not-owned | Leaking ownership by returning 403 vs 404 is a security anti-pattern | Low | Return 404 in both cases (attacker cannot distinguish existence) |
| Consistent error shape | Existing `{ error, message, statusCode }` shape must extend to all new routes | Low | Already implemented in the global error handler |
| TypeBox schemas for all new routes | Project standard; input validation and serialization are required | Low | All new route schemas must use TypeBox + `Static<typeof schema>` |

---

## Differentiators

Features that raise the platform above a basic CRUD API toward production-grade IoT infrastructure. Not expected by default but valued once discovered.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| DB-backed device-type catalog | Types are rows, not hard-coded enums; new types added without code changes | High | Requires a `device_types` table + type-config storage (JSON schema per type); v1 can ship with code-level enums and migrate later |
| Dual-origin tracking (command vs. report) | Event records distinguish whether a change was user-commanded or device-reported; enables insight like "AC turned on 3 min after temp rose above 25°C" | Low (data model) | Add an `origin` enum field (`COMMAND \| REPORT`) and `actor_id` (user or device) to the event row |
| Device online/offline presence tracking | Track whether a device is actively reporting; surface "last seen" timestamp | Med | Requires a `last_seen_at` field on Device and a reporting heartbeat endpoint |
| Bulk state snapshot endpoint | `GET /houses/:id/snapshot` returns full nested state in one payload | Med | Reduces client round-trips; critical for dashboard rendering performance |
| Cursor-based pagination on event log | Stable pagination for high-volume telemetry (offset pagination breaks when new events arrive) | Med | Use `created_at + id` composite cursor; return `nextCursor` in response |
| Event log query — by event type | Filter history by what kind of change occurred (state change vs. telemetry reading vs. command) | Low | Enum column on event row; trivial to add at design time, painful to add retroactively |
| Device metadata / custom labels | Users can attach a display name, icon slug, or notes to a device | Low | A `metadata` JSON column on Device suffices; free-form client-controlled bag |
| Room ordering / position index | Rooms within a house have a client-defined sort order | Low | An `order_index` integer on Room; clients control the sort |
| Timezone / locale per house | House has a timezone string; event timestamps are stored as UTC, displayed in house TZ | Low | Critical for AI rules later ("turn lights off at sunset" requires local time) |
| Idempotency on commands | Re-sending the same command with the same idempotency key returns the original event without creating a duplicate | High | Optional in v1 but protects against network-retry duplicate state changes |
| Soft-delete for devices | Deactivated devices preserve their event history; hard-delete loses data | Low | Add `deleted_at` nullable field; filter out in queries unless explicitly requested |

---

## Anti-Features

Features to explicitly NOT build in v1. Each has a clear reason and a designed-for substitute.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Real hardware protocol integration (MQTT, Zigbee, Z-Wave, HomeKit HAP, Matter) | Protocol adapters are a separate engineering surface; adds 3rd-party SDKs, connection management, device pairing flows, and firmware quirks to a v1 API scope | Expose clean REST endpoints that a future protocol adapter or simulator can call; keep the API agnostic of transport |
| AI automation-rule engine | No training data yet; rules logic is speculative without usage patterns | Design the event model to be AI-readable (origin, actor, timestamp precision, device-type semantics) — the corpus is the deliverable for v1 |
| Push / real-time event streaming (WebSocket, SSE) | Adds connection management, back-pressure, fan-out complexity | HTTP long-poll or client polling is sufficient for v1; the event log is the source of truth |
| Web UI / dashboard | Out of scope per project requirements; API-only | Ensure response shapes are flat and renderable without transformation |
| Device sharing / collaborative access (multiple users per house) | Multi-owner authorization is a separate access-control problem | Single-owner model (user_id on house) is sufficient; add a `collaborators` table later |
| Device grouping / scenes / macros | Powerful but speculative; requires understanding actual usage patterns first | Individual device commands are sufficient; scenes can be emulated client-side by issuing multiple commands |
| Scheduling / time-based automation | Requires cron infrastructure and is AI automation territory | Record time context in events; let AI suggest schedules later |
| Notification / alert delivery (push, email, SMS) | Notification provider integration (FCM, APNS, SendGrid) is a separate service concern | Events in the history log are the notification source of truth; a future notification service reads from them |
| Historical data aggregation / analytics endpoints | Aggregations over large telemetry tables are slow without time-series infrastructure (TimescaleDB, InfluxDB) | Return raw paginated events; clients aggregate or a future analytics service does |
| Device firmware OTA update management | Entirely separate domain; requires device identity certificates, binary delivery, rollback | Irrelevant for simulated devices; design device_id as a stable UUID to allow attachment later |
| OAuth / third-party login | Existing email/password auth is sufficient for v1 | —  |

---

## Feature Dependencies

```
House CRUD
  └─→ Room CRUD (rooms belong to houses)
        └─→ Device CRUD (devices belong to rooms)
              ├─→ Device-type catalog (device type must exist before device creation)
              ├─→ Current-state read (device must exist; state row is created with device)
              ├─→ Command device (state-change write path; requires device + type validation)
              │       └─→ Event log append (every command creates an event row)
              └─→ Report telemetry (sensor-push write path; requires device)
                      └─→ Event log append (every report creates an event row)

Event log append
  └─→ Event log queries (by device / by room / by time range / by event type)

Multi-tenancy enforcement
  └─→ (crosses ALL of the above — ownership check on every read and write)
```

Key ordering constraints:
- The device-type catalog (even as a code enum) must be defined before Device CRUD, because device creation validates the type.
- Current state storage must be designed alongside Device CRUD — a current-state row should be created atomically with the device row (or default-initialized), so there is never a device without a state record.
- Event log schema must be stable before any write path (command or report) is implemented, because retrofitting additional columns onto millions of event rows is expensive.
- Dual-origin tracking (`origin`, `actor_id`) costs almost nothing at schema design time but is very expensive to add retroactively — include it from day one even in v1.
- Timezone on House is cheap to add now; needed before any time-based query or AI rule touches the data.

---

## MVP Recommendation

Prioritize (implement in this order):

1. **Device-type catalog** (code-level enum + TypeBox schemas) — gates everything else; define all initial types (light, AC, heater, sensor) with their state shapes
2. **House / Room / Device CRUD** — the skeleton; enforce multi-tenancy throughout
3. **Current-state representation** — design the state storage model (one `device_states` row per device, flexible JSON value, updated in-place); initialize on device creation
4. **Event log schema** — append-only `device_events` table with `origin`, `actor_id`, `device_type`, `state_snapshot`, `timestamp`; designed before any write path
5. **Command endpoint** (`POST /devices/:id/command`) — validates state change, updates current state, appends event
6. **Report endpoint** (`POST /devices/:id/report`) — same write path as command but `origin = REPORT`; for simulated sensors
7. **Current-state queries** — single device, room scope, house scope
8. **Event log queries** — by device, by time range, with cursor pagination

Defer to a second iteration within this milestone:
- **Bulk house snapshot** — not required for correctness; add after single-device queries work
- **Device online/offline presence** — valuable but not blocking; add `last_seen_at` to Device and populate from report endpoint
- **Event log query by room / by event type** — useful but filter-on-client is acceptable at low volume

Defer to a future milestone:
- DB-backed device-type catalog (upgrade from enum to rows)
- Real hardware protocol adapters
- AI rule engine
- Notification delivery

---

## Notes for AI-Readiness (Without Building AI Now)

These data-model decisions cost nothing in v1 but are required for a future AI automation-suggestion component:

1. **`origin` field on events** — distinguishes user intent (`COMMAND`) from environmental fact (`REPORT`); AI needs this to learn causality
2. **`actor_id` on events** — records which user issued a command; AI uses this to learn per-user preferences
3. **`device_type` denormalized onto events** — future AI queries filter by type without joining Device
4. **`state_snapshot` on events** — stores the full state at the time of the event, not just the diff; AI training needs the complete picture at each time point
5. **UTC timestamps with millisecond precision** — required for sequence reconstruction; `DateTime` stored as UTC, house TZ stored separately
6. **Consistent state shape per device type** — the AI feature map is the device-type state schema; if the shape changes, historical events become incoherent
7. **Never delete events** — AI training corpus must be complete and immutable; soft-delete devices, never hard-delete events

---

## Sources

- Project context: `.planning/PROJECT.md`, `.planning/codebase/ARCHITECTURE.md`
- Domain reference: Home Assistant entity model, AWS IoT Device Shadow, Azure IoT Hub Device Twin, Google Home API, Apple HomeKit Accessory Protocol, Tuya Cloud API, SmartThings API
- Confidence: HIGH — patterns are consistent across all major platforms; no conflicting signals
