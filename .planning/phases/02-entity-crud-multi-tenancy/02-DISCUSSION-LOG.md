# Phase 2: Entity CRUD & Multi-Tenancy - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-08
**Phase:** 2-Entity CRUD & Multi-Tenancy
**Areas discussed:** URL structure & nesting, List response shape, Identifier in URLs, Update semantics & mutability, Soft-delete cascade

---

## URL structure & nesting

| Option | Description | Selected |
|--------|-------------|----------|
| Shallow nesting | Create/list under parent; act on item by its own id. POST /houses/:houseId/rooms, GET/PATCH/DELETE /rooms/:id; devices with two list views (by room, by house). | ✓ |
| Fully nested | Every path carries full ancestry (/houses/:h/rooms/:r/devices/:d). | |
| Fully flat | Everything top-level, parent id in body/query. | |

**User's choice:** Shallow nesting
**Notes:** Full ancestry is redundant because ownership is enforced by the denormalized `user_id`.

---

## List response shape

| Option | Description | Selected |
|--------|-------------|----------|
| Bare array, no pagination | Return [ ...items ] directly. Simplest, YAGNI. | |
| Envelope, no pagination | { data: [...] } for forward compatibility. | |
| Envelope + pagination now | { data: [...], nextCursor } cursor-paginated, consistent with Phase 7. | ✓ |

**User's choice:** Envelope + pagination now
**Notes:** Chosen for consistency with the Phase 7 event-history read pattern. Cursor key `(created_at, id)` flagged as a researcher/planner detail (CRUD collections have no `recorded_at`).

---

## Identifier in URLs

| Option | Description | Selected |
|--------|-------------|----------|
| public_id everywhere | NanoID public_id in paths and responses; internal BigInt id never exposed. | ✓ |
| Internal BigInt id | Numeric PK in URLs; enumerable, leaks counts. | |
| public_id in URLs, both in responses | URLs use public_id; responses include both. | |

**User's choice:** public_id everywhere
**Notes:** Realizes PROJECT.md's non-enumerable-external-id design; sidesteps BigInt-JSON serialization. Nested paths carry the parent's public_id; services resolve `{ publicId, userId }`.

---

## Update semantics & mutability

### Update verb
| Option | Description | Selected |
|--------|-------------|----------|
| PATCH, partial | Only changed fields; omitted untouched. | ✓ |
| PUT, full replace | Complete resource; missing fields reset. | |

**User's choice:** PATCH, partial

### Re-parenting
| Option | Description | Selected |
|--------|-------------|----------|
| No re-parenting in v1 | house_id/room_id fixed at creation; device_type immutable; move = delete + recreate. | ✓ |
| Allow re-parenting | Update may move device/room to another owned parent with ownership re-check. | |

**User's choice:** No re-parenting in v1
**Notes:** device_type is immutable after creation (state_type/state_id + eager state row bound to it).

---

## Soft-delete cascade

| Option | Description | Selected |
|--------|-------------|----------|
| Cascade soft-delete | Deleting a house/room soft-deletes children in one transaction. Children vanish from every read including direct GET /devices/:id. | ✓ |
| No cascade (target only) | Only the target row deleted; children stay live and reachable via top-level routes (orphan). | |
| Block if non-empty | 409 unless children deleted first. | |

**User's choice:** Cascade soft-delete
**Notes:** Chosen because shallow nesting exposes items at top level, so a non-cascading delete leaves live-looking orphans. Cascade builds on the Phase 1 `$extends` `deleteMany` soft-delete seam; house→device must route through room ids (devices carry no house_id). Compatible with Phase 7's readable soft-deleted-device history.

---

## Claude's Discretion

- NanoID `public_id` generation seam (client extension vs per-service) — deferred from Phase 1; add the `nanoid` dependency.
- TypeBox introduction (`@sinclair/typebox` + Fastify type-provider) — mandated standard, not yet installed (`zod` is the current validator dep).
- Field validation limits (name lengths, floor range, brightness 0–100, target_temp bounds, ac mode vocabulary, sensor unit) — all TypeBox app-layer, no DB constraints.
- Eager state-row creation-time default values.
- Cursor encoding + page size for list pagination.
- BigInt serialization — confirm no internal id leaks into any response schema.

## Deferred Ideas

- Setting initial device state at creation (defaults-only in v1).
- Re-parenting rooms/devices (move = delete + recreate).
- Filtering/search on list endpoints.
- Migrating legacy auth schemas to TypeBox (only when next touched).
