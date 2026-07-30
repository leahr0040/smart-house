---
phase: 2
slug: entity-crud-multi-tenancy
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-07-30
---

# Phase 2 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| npm registry → build | Untrusted third-party packages enter the build (supply chain) | Package code/postinstall scripts |
| client → entity API (`/houses`, `/rooms`, `/devices`) | Untrusted JWT + body/params cross here; ownership and shape enforced server-side | JWT, public IDs, entity fields |
| service → DB | `relationMode="prisma"` — no DB-level RLS/FK cascade; the app layer is the sole ownership + cascade enforcement point | Owned entity rows, soft-delete flags |
| VARCHAR → union seam (`device_type`, `public_id`) | External identifier is the only exposed id; internal BigInt id never leaves the service | `public_id` (out), BigInt `id` (never) |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-2-SC | Tampering | npm installs (@sinclair/typebox, @fastify/type-provider-typebox@5, nanoid@3) | high | mitigate | Blocking-human legitimacy checkpoint at plan time; high-download, no-postinstall packages; switched to CJS-native `@sinclair/typebox` 0.34 | closed |
| T-2-01 | Information Disclosure | public_id generator | high | mitigate | `nanoid()` CSPRNG-backed, non-sequential, 21 chars — sole exposed id ([src/lib/nanoid.ts](../../../src/lib/nanoid.ts)) | closed |
| T-2-02 | Spoofing | Authentication of soft-deleted users | medium | mitigate | `readGuard` injects `deletedAt:null` into all reads ([src/lib/prisma.ts:30](../../../src/lib/prisma.ts#L30)) | closed |
| T-2-03 | Tampering | Prisma create hook transaction context | high | mitigate | `create` mints publicId via the `query()` continuation, staying inside `$transaction` ([src/lib/prisma.ts:83](../../../src/lib/prisma.ts#L83)) | closed |
| T-2-H01 | Info Disclosure / EoP | GET/PATCH/DELETE `/houses/:id` (IDOR/BOLA) | high | mitigate | Ownership-embedded `where:{publicId,userId}`; cross-tenant → 404 not 403 ([src/services/house.ts:29](../../../src/services/house.ts#L29)) | closed |
| T-2-H02 | Spoofing | All `/houses` routes without JWT | high | mitigate | `preHandler: fastify.authenticate` on every route ([src/routes/houses/index.ts](../../../src/routes/houses/index.ts)) | closed |
| T-2-H03 | Tampering | PATCH mass assignment (userId/deletedAt) | medium | mitigate | TypeBox body `additionalProperties:false`; service destructures whitelisted fields | closed |
| T-2-H04 | Information Disclosure | Internal BigInt id leakage | medium | mitigate | `HouseResponseSchema` `additionalProperties:false` + `toHouseResponse` builds publicId-only | closed |
| T-2-H05 | Tampering | Non-atomic cascade orphaning live children | high | mitigate | Cascade in one `$transaction` via direct `updateMany` ([src/services/house.ts:45](../../../src/services/house.ts#L45)) | closed |
| T-2-R01 | Elevation of Privilege | POST `/houses/:id/rooms` (nested-parent bypass) | high | mitigate | `createRoom` resolves parent via `findFirst {publicId,userId}` before insert ([src/services/room.ts:25](../../../src/services/room.ts#L25)) | closed |
| T-2-R02 | Info Disclosure / EoP | GET/PATCH/DELETE `/rooms/:id` (IDOR/BOLA) | high | mitigate | Ownership-embedded `where:{publicId,userId}`; cross-tenant → 404 ([src/services/room.ts:50](../../../src/services/room.ts#L50)) | closed |
| T-2-R03 | Spoofing | All room routes without JWT | high | mitigate | `preHandler: fastify.authenticate` on every route | closed |
| T-2-R04 | Tampering | PATCH re-parenting / mass assignment | medium | mitigate | Schema `additionalProperties:false`; no `house_id` in update; service destructures 3 fields | closed |
| T-2-R05 | Tampering | Non-atomic room→devices cascade | high | mitigate | Cascade in one `$transaction` via `updateMany` ([src/services/room.ts:66](../../../src/services/room.ts#L66)) | closed |
| T-2-R06 | Information Disclosure | Internal BigInt id leakage | medium | mitigate | `RoomResponseSchema` `additionalProperties:false` (no id/houseId) + field-by-field response | closed |
| T-2-D01 | Elevation of Privilege | POST `/rooms/:id/devices` (nested-parent bypass) | high | mitigate | `createDevice` resolves parent room via `findFirst {publicId,userId}` before insert ([src/services/device.ts:178](../../../src/services/device.ts#L178)) | closed |
| T-2-D02 | Info Disclosure / EoP | GET/PATCH/DELETE `/devices/:id` + list routes (IDOR/BOLA) | high | mitigate | Ownership-embedded `where:{publicId,userId}` on every query and parent resolve; cross-tenant → 404 | closed |
| T-2-D03 | Spoofing | All device routes without JWT | high | mitigate | `preHandler: fastify.authenticate` on every route | closed |
| T-2-D04 | Tampering | Mass assignment — device_type change, re-parenting, client-supplied state | high | mitigate | PATCH omits `deviceType` + `additionalProperties:false`; state set solely by eager-create transaction | closed |
| T-2-D05 | Tampering | Non-atomic eager state row | medium | mitigate | 3-step create in one `$transaction` via typed `deviceStateConfig` ([src/services/device.ts:231](../../../src/services/device.ts#L231)) | closed |
| T-2-D06 | Information Disclosure | Internal BigInt id / state_id leakage | medium | mitigate | `DeviceResponseSchema` `additionalProperties:false` (no id/stateId) + field-by-field response | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above `workflow.security_block_on` (high) count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|

No accepted risks.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-30 | 21 | 21 | 0 | gsd-secure-phase (L1 grep verification) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-30
