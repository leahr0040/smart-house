# Phase 1: Schema & Data Conventions - Context

**Gathered:** 2026-07-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Lock the **complete Prisma schema** — all new domain tables (House, Room, Device, Command, CommandTarget, the four per-type state detail tables) plus the append-only `events` table — and apply every data convention uniformly, before a single entity record is created. Acceptance bar is a **compile + migration smoke-check** (`prisma migrate dev` exits 0, `npm run build` compiles clean, `npm test` passes existing auth tests) — this phase has no runtime application logic. Delivers DATA-01…DATA-04.

</domain>

<decisions>
## Implementation Decisions

Almost all of Phase 1 was already locked by the planning docs (see Canonical References). The decisions below fill the gaps those docs left open.

### Per-type state detail columns
The four morph detail tables carry these state columns. **No DB-level enums, CHECK constraints, or min/max** — every value/range/vocabulary rule is enforced in the TypeBox app layer (consistent with the action-registry philosophy in PROJECT.md).

- **D-01 `light_states`:** `is_on` (Boolean), `brightness` (Int) — no 0–100 DB constraint; TypeBox validates the range.
- **D-02 `ac_states`:** `is_on` (Boolean), `target_temp` (Int), `mode` (String — plain column, e.g. cool/heat/fan/auto validated in TypeBox, **not** a DB enum).
- **D-03 `heater_states`:** `is_on` (Boolean), `target_temp` (Int).
- **D-04 `sensor_states`:** `reading` (Decimal), `unit` (String).
- **D-05:** Every detail table also carries `last_event_at` (DateTime, nullable) and `last_event_id` (uuid v7, nullable) for the tuple guard, plus the morph back-link to the owning device. Rows are created eagerly at device creation with defaults (STATE-01 — delivered in Phase 2, but the columns/defaults are shaped here).

### Enum representation (no native DB enums)
- **D-06:** Represent `Command.status` (`received`/`rejected`/`pending`/`done`/`partially_failed`/`failed`/`no_targets`), `events.entity_type` (`device`/`command`), `events.device_type`, `events.event_kind`, `events.source`, and `ac_states.mode` as **plain `String` columns validated in TypeBox**, not Prisma/MySQL native enums. Rationale: simpler migrations (adding a value never requires an `ALTER TYPE`), and it matches the user's explicit "no DB enums/limits" preference and the code-first action vocabulary. ROADMAP success criteria that say "enum: device | command" are satisfied by an app-validated string domain.

### Event snapshot format
- **D-07:** `events.snapshot` is a **native MariaDB JSON column** holding the effect/report payload verbatim (uniform across device types; ideal for the future AI "intent → effects" mining). The project's "no JSON column" rule is **scoped to the queryable current-state detail tables only** — the append-only audit log is explicitly exempt.

### Entity metadata (non-state columns)
Beyond `name` and the structural FKs / `user_id` denorm / `deleted_at` already locked:
- **D-08 House:** `address` (String, optional). (Timezone stays v2 — HOUSE-06.)
- **D-09 Room:** `floor` (Int, default 0) and `room_type` (String, optional free-text label — not a DB enum).
- **D-10 Device:** `manufacturer` (String, optional) and `model` (String, optional) — hardware metadata for future AI/analytics and real-hardware v2; zero runtime cost now. `device_type` is a validated `String` (per D-06).

### Claude's Discretion
- **uuid v7 storage format** (`BINARY(16)` vs `CHAR(36)`): explicitly a **research spike** (ROADMAP success criterion 5), left to the phase researcher — must also confirm the Prisma MariaDB adapter emits v7 (not v4) for `@default(uuid())`. Whatever is chosen must be applied consistently to `event_id`/`last_event_id` and carried into the Phase 7 cursor-comparison decision.
- **Per-device limits/config surface:** user chose **not** to model limits as DB columns/enums in v1. No separate config table and no min/max columns — limits live in the TypeBox action registry (`src/lib/device-actions.ts`). Registry-seamed for a v2 DB-backed source if dynamic device types ever land.
- Exact Prisma decimal precision for `sensor_states.reading` / `ac`/`heater` `target_temp` — pick sensible defaults (e.g. `Decimal(6,2)` for readings, `Int` for temps as decided).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Planning specs (authoritative for Phase 1)
- `.planning/PROJECT.md` — Constraints & Key Decisions: snake_case `@map`/`@@map`, uuid v7 PKs, `user_id` denorm, soft-delete, polymorphic morph, `events` table as source of truth, hand-authored `ALTER TABLE … RENAME`.
- `.planning/REQUIREMENTS.md` §Data Conventions — DATA-01…DATA-04 (the requirements this phase delivers); §Event History EVENT-01 for the full `events` row shape; §Device State STATE-01 for eager state-row lifecycle.
- `.planning/ROADMAP.md` §"Phase 1: Schema & Data Conventions" — Goal, the six Success Criteria (the acceptance contract), and the structure-first schema/infra exception notes.
- `.planning/STATE.md` §Architecture Constraints — `events` table schema, tuple guard, CAS transitions, RabbitMQ topology (context for later phases).

### Codebase maps
- `.planning/codebase/CONVENTIONS.md` — existing naming/`@map` conventions to extend.
- `.planning/codebase/STRUCTURE.md`, `.planning/codebase/ARCHITECTURE.md` — service-layer + Prisma-singleton patterns.

### Existing schema
- `prisma/schema.prisma` — current `User` / `RefreshToken` models (the rename targets).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `prisma/schema.prisma`: `RefreshToken` already uses `@@map("refresh_tokens")` and `@map` on columns — the snake_case convention to replicate on all new models. **`User` has no `@@map`** (table is still `User`), so the hand-authored `ALTER TABLE … RENAME` migration to `users` targets the `User` table; verify whether the live `RefreshToken` table also needs a rename or is already `refresh_tokens`.
- `src/lib/prisma.ts`: the singleton `prisma` client — the only DB access seam; new state/service stubs import from here.

### Established Patterns
- `datasource db` uses `provider = "mysql"` with `relationMode = "prisma"` — **relations are emulated, no real FK constraints** (aligns with the "loose FK integrity is fine for a rebuildable projection" decision). New morph back-links and denormalized `user_id` fit this cleanly.
- Prisma client generates to `src/generated/prisma/` (never hand-edit); regenerate after schema changes.

### Integration Points
- New models extend the same `schema.prisma`; the rename migration must be hand-verified to emit `RENAME TABLE` (not DROP+CREATE) so existing auth data survives.
- Existing auth tests (`npm test`) are the regression guard — they must stay green after the rename + additions.

</code_context>

<specifics>
## Specific Ideas

- User's explicit steer: **"don't add limits like enums or min/max to the DB."** This is the load-bearing convention for this phase — state/status/type columns are plainly typed strings/ints/decimals/bools; all constraint logic is app-layer TypeBox. Applied uniformly (D-01…D-07).
- Event snapshot as native JSON is a deliberate, scoped exception to the otherwise-strict "no JSON" rule.

</specifics>

<deferred>
## Deferred Ideas

- **Per-device limits/config as DB columns or a config table** — deferred; limits stay in the TypeBox action registry for v1. Revisit only if dynamic/admin/per-tenant device types become a requirement (v2).
- **House timezone** — v2 (HOUSE-06); `address` only in v1.
- **Additional room/device metadata beyond the chosen fields** — add per real need; not modeled speculatively.

</deferred>

---

*Phase: 1-Schema & Data Conventions*
*Context gathered: 2026-07-01*
