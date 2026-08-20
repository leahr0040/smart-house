# Phase 1: Schema & Data Conventions - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-01
**Phase:** 1-Schema & Data Conventions
**Areas discussed:** Per-type state fields, Event snapshot format, Entity metadata fields

---

## Gray-area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Per-type state fields | Actual columns per detail table | ✓ |
| Event snapshot format | events.snapshot column type | ✓ |
| Device limits/config location | Where per-device limits live | |
| Entity metadata fields | Non-state columns on House/Room/Device | ✓ |

**Notes:** Device limits/config intentionally not discussed — folded into the state-fields answer (user chose no DB-level limits).

---

## Per-type state fields

| Option | Description | Selected |
|--------|-------------|----------|
| Use these defaults | light(is_on, brightness), ac(is_on, target_temp, mode), heater(is_on, target_temp), sensor(reading, unit) | ✓ |
| These + more fields | Baseline plus extra columns | |
| Let me redefine | Specify from scratch | |

**User's choice:** Defaults — **"but don't add limits like enums or min/max to the db."**
**Notes:** Load-bearing steer. State columns are plainly typed (bool/int/decimal/string); `mode` and all vocabularies are strings, not DB enums; range checks (e.g. brightness 0–100) live in TypeBox. Extended by inference to `Command.status`/`events.entity_type`/etc. — plain string columns, no native DB enums.

---

## Event snapshot format

| Option | Description | Selected |
|--------|-------------|----------|
| JSON column | Native MariaDB JSON holding effect/report payload verbatim | ✓ |
| LONGTEXT (stringified) | Serialized JSON as opaque LONGTEXT | |
| Typed columns | Discrete typed columns on events | |

**User's choice:** JSON column.
**Notes:** The "no JSON" rule is scoped to the queryable current-state tables; the append-only audit log is exempt. Chosen for uniformity across device types and future AI mining.

---

## Entity metadata fields

| Option | Description | Selected |
|--------|-------------|----------|
| Name-only + structural | Only name + FKs | |
| Add a few fields | User-specified extras | ✓ |

**User's choice:** Add fields — user asked for suggestions. Follow-up multiSelect offered four; **all four selected:**

| Suggested field | Selected |
|-----------------|----------|
| Room.floor (Int) | ✓ |
| House.address (String?) | ✓ |
| Device.manufacturer + model (String?) | ✓ |
| Room.room_type (String?) | ✓ |

**Notes:** All optional except name; all plain typed columns, no DB enums. Timezone stays v2 (HOUSE-06).

---

## Claude's Discretion

- uuid v7 storage format (`BINARY(16)` vs `CHAR(36)`) — deferred to the phase researcher's spike; must also confirm the adapter emits v7 not v4.
- Decimal precision for `reading` / temp columns — sensible defaults at planner discretion.
- Per-device limits/config surface — kept in the TypeBox action registry, no DB modeling in v1.

## Deferred Ideas

- Per-device limits/config as DB columns/table — v2, only if dynamic device types land.
- House timezone — v2 (HOUSE-06).
- Speculative extra room/device metadata — add per real need.
