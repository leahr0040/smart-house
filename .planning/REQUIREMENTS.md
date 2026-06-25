# Requirements: Smart House

**Defined:** 2026-06-25
**Core Value:** The system always reflects the true current state of the house AND preserves a complete, queryable history of every event.

## v1 Requirements

Requirements for the smart-home data-platform milestone. Each maps to roadmap phases. Built on the existing Fastify 5 + Prisma + MariaDB auth API.

### Houses

- [ ] **HOUSE-01**: User can create a house
- [ ] **HOUSE-02**: User can list and view their own houses
- [ ] **HOUSE-03**: User can update a house they own
- [ ] **HOUSE-04**: User can delete a house they own
- [ ] **HOUSE-05**: A user can only access houses they own (cross-tenant access returns 404)

### Rooms

- [ ] **ROOM-01**: User can create a room in a house they own
- [ ] **ROOM-02**: User can list rooms in a house they own
- [ ] **ROOM-03**: User can update a room they own
- [ ] **ROOM-04**: User can delete a room they own

### Devices

- [ ] **DEV-01**: User can add a device of a known type (light, AC, heater, sensor) to a room
- [ ] **DEV-02**: User can list and view devices by room and by house
- [ ] **DEV-03**: User can update device metadata (e.g. name)
- [ ] **DEV-04**: User can remove a device (soft-delete)
- [ ] **DEV-05**: Device state values are validated per device type in code (TypeBox schema per type)

### State

- [ ] **STATE-01**: User can issue a command that changes a device's state (e.g. turn AC on, set target temp)
- [ ] **STATE-02**: A device/sensor can report its state or reading (ingest)
- [ ] **STATE-03**: User can read the current state of a single device
- [ ] **STATE-04**: User can read current state for all devices in a room
- [ ] **STATE-05**: User can read a full current-state snapshot of a house

### History

- [ ] **EVENT-01**: Every command and report is recorded as an immutable event (source, timestamp, full state snapshot)
- [ ] **EVENT-02**: User can query a device's event history
- [ ] **EVENT-03**: User can filter event history by time range
- [ ] **EVENT-04**: Event history queries use cursor pagination

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### History & Devices

- **EVENT-05**: Event retention policy (e.g. configurable age-based purge)
- **EVENT-06**: Filter event history by room and by event type
- **DEV-06**: Device presence tracking (`last_seen_at`)
- **HOUSE-06**: Per-house timezone for history rendering

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| AI automation-suggestion engine | Future milestone; v1 builds the clean data foundation it will consume |
| Real hardware / protocol integration (MQTT, Zigbee, Home Assistant) | v1 uses simulated API clients; no physical outbound control |
| WebSocket / SSE live streaming | Polling/REST is sufficient for v1 |
| Web UI / dashboard | API-only for v1; consumed by clients and a future frontend |
| OAuth / social login | Email/password auth already shipped and sufficient |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| (populated during roadmap creation) | — | Pending |

**Coverage:**
- v1 requirements: 23 total
- Mapped to phases: 0 (pending roadmap)
- Unmapped: 23 ⚠️

---
*Requirements defined: 2026-06-25*
*Last updated: 2026-06-25 after initial definition*
