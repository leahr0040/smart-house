---
phase: 2
reviewers: [opencode]
reviewed_at: 2026-07-12T21:22:12Z
plans_reviewed: [02-01-PLAN.md, 02-02-PLAN.md, 02-03-PLAN.md, 02-04-PLAN.md]
note: >-
  Claude was skipped (this review ran inside Claude Code — self-review excluded for
  independence). gemini, codex, coderabbit, qwen, cursor, and antigravity CLIs are not
  installed, so opencode was the only available independent reviewer.
---

# Cross-AI Plan Review — Phase 2

## OpenCode Review

# Cross-AI Plan Review: Phase 2 — Entity CRUD & Multi-Tenancy

## 1. Overall Summary

Four extremely well-researched, mutually consistent plans. The research phase did heavy lifting (Pitfall 1 — the `base`-escape from `$transaction` — is the single most important finding in the entire milestone), and every plan correctly works around it. The cascade soft-delete, eager state-row creation, TypeBox integration, and ownership-embedded queries are all sound against the actual codebase. The main gaps are test-verification mechanics and one Node-version compatibility detail. **Risk level: LOW.**

---

## 2. Plan-by-Plan Analysis

### 02-01-PLAN.md — Toolchain & public_id seam

**Strengths**

- Pitfall 1 correctly identified and mitigated. The plan explicitly forbids reaching for `base` inside the create hook and mandates `query()` continuation — confirmed usable via `src/lib/prisma.ts:67-68` (softDelete already demonstrates the wrong pattern; plan avoids it).
- ESM/`require(esm)` risk empirically verified, not just theorized. The plan correctly pins `engines.node >=22.12.0` — this is **essential** because `package.json:31-32` shows this project is `module: commonjs` (tsconfig line 5) and both `nanoid` 5.x and `typebox` 1.x are pure ESM.
- `modelConfig` exhaustiveness understood: `src/lib/prisma.ts:8-21` is `Record<Prisma.ModelName, {softDelete: boolean}>` — widening to include `publicId` **will** require all 12 models to get a value or `tsc` fails. Plan correctly calls this out.
- `house_id` in migration confirmed: `prisma/migrations/20260707094526_add_domain_schema/migration.sql:42` — `house_id BIGINT NOT NULL` already present. Plan is correct that no new migration is needed.
- Blocking-human package-legitimacy gate for `nanoid` and `typebox` is appropriate: neither existed in `package.json` before, and `typebox` was published only 5 days before this review. The override rationale (same maintainer as `@sinclair/typebox`, 4M+/week downloads) is well-documented.

**Concerns**

| Severity | Issue | Evidence |
|----------|-------|----------|
| **MEDIUM** | `typebox` (unscoped 1.x) — published 2026-07-08, only 5 days old. Research provides strong same-maintainer evidence, but this is an extremely new dependency for a critical validation layer. If a regression surfaces in the 1.x line, there's no project history to lean on. | `02-RESEARCH.md:122` — publication date noted. Fallback to `@sinclair/typebox` 0.x is documented but would require the different `@fastify/type-provider-typebox` peer range. |
| **LOW** | `prisma migrate reset --force --skip-seed` in Task 2 is destructive (drops and recreates the dev DB). Plan says "DEV DB ONLY" but does not warn the operator about data loss. | `02-01-PLAN.md:110` — the fallback command. |
| **LOW** | `createTestUser` fixture resolves `userId` via a second `prisma.user.findUnique` by email after the register call. The register response already returns `{ user: { id: Number(user.id) } }` (anti-pattern at `src/routes/auth/index.ts:50`). The fixture could extract `user.id` directly from the register response payload, avoiding the extra query. Minor — not wrong, just a wasted round-trip. | Plan says "userId resolved via a direct prisma.user lookup by email" — works, but redundant. |

---

### 02-02-PLAN.md — House CRUD slice

**Strengths**

- Cascade pattern correct: `tx.device.updateMany` / `tx.room.updateMany` / `tx.house.updateMany` — confirmed consistent with Pitfall 1 at `src/lib/prisma.ts:43-53` (softDelete reaches for `base`, which would escape `$transaction`).
- Mass-assignment defense via `additionalProperties:false` on TypeBox schemas + explicit destructuring in the service layer. This is two layers deep.
- `prefixOverride = ''` correctly addresses `@fastify/autoload`'s default behavior — without it, `src/routes/houses/index.ts` would be mounted at `/houses/houses`.
- BigInt-safe response construction: never `reply.send(rawRow)`, never spread Prisma objects, never include `id`. Correct departure from the anti-pattern at `src/routes/auth/index.ts:50/65/78`.

**Concerns**

| Severity | Issue | Evidence |
|----------|-------|----------|
| **MEDIUM** | Cascade verification test (Task 2, item 9): says "assert via direct prisma reads that the rooms and devices are now soft-deleted." But `src/lib/prisma.ts:29-36` (`readGuard`) auto-injects `deletedAt: null` into every `findFirst`/`findMany` call on soft-deletable models. A naive `prisma.device.findMany({ where: { houseId } })` will return **nothing** after the cascade (they all have `deletedAt` set), not verifying they ARE deleted vs. simply not found. The test must use `prismaRaw` (line 74) or pass an explicit `{ deletedAt: { not: null } }` filter to escape the guard. This is not specified. | `src/lib/prisma.ts:33-35` — `readGuard` skips injection only if `deletedAt` is already in the `where` clause. The plan says "using the deletedAt escape hatch or a fresh query" — vague. |
| **LOW** | POST create status code is ambiguous: plan says "201/200" but doesn't commit to either. Standard REST convention (and the existing auth route at `src/routes/auth/index.ts:35-51` which returns 200 on creation) suggests 200. Not a blocker, but could cause false test failure if the assertion checks `res.statusCode === 201`. | `02-02-PLAN.md` tests Task 2, item 1. |

---

### 02-03-PLAN.md — Room CRUD slice

**Strengths**

- Parent-ownership verification in `createRoom` is correct: resolves house via `findFirst({ where: { publicId: housePublicId, userId } })` **before** the room insert — prevents creating a room in another user's house.
- `updateRoom` correctly excludes `house_id` from the update payload (both schema and service-level). D-05 enforced.
- Cascade is the same correct `updateMany` pattern as house. Consistent.

**Concerns**

| Severity | Issue | Evidence |
|----------|-------|----------|
| **MEDIUM** | Same cascade-verification gap as 02-02: test says "assert via direct prisma reads that the devices are now soft-deleted" — but `readGuard` auto-filters soft-deleted rows. | `src/lib/prisma.ts:29-36` |
| **LOW** | `listRooms` does an ownership check on the house first (`findFirst`), then queries rooms by both `houseId` AND `userId`. The second `userId` filter is redundant (the house check already verified it), but consistent with defense-in-depth per DATA-02. Not an issue, just slightly duplicative. | `02-03-PLAN.md` Task 3 implementation. |

---

### 02-04-PLAN.md — Device CRUD slice

**Strengths**

- Eager state-row creation (`STATE-01`) correctly uses a 3-step `$transaction`: device stub → state row (needs `device.id`) → morph-pointer update (needs `state.id`). This is the most architecturally significant piece of the phase and is correctly designed.
- `deviceStateConfig` is an exhaustive `Record<DeviceType, ...>` — adding a fifth device type would cause a `tsc` error. Consistent with the `modelConfig` idiom at `src/lib/prisma.ts:8-21` and CLAUDE.md's "explicit over magic."
- Device-type immutability enforced at TWO layers: (1) `PatchDeviceSchema` intentionally omits `deviceType`, and (2) `additionalProperties:false` rejects it with 400 if sent anyway. Defense-in-depth done right.
- By-house device list queries `houseId` directly — confirmed from `prisma/schema.prisma:77` (`houseId @map("house_id")`) — never joins through rooms.
- Leaf delete (`deleteDevice`) correctly uses `prisma.device.delete()` directly (the extension intercepts to soft-delete) because it has no children.

**Concerns**

| Severity | Issue | Evidence |
|----------|-------|----------|
| **MEDIUM** | Same cascade-verification gap (identical to 02-02/02-03): the test asserts children ARE soft-deleted after a room delete, but `readGuard` hides them. | `src/lib/prisma.ts:33-35` |
| **LOW** | AcState and HeaterState both have `isOn: Boolean @default(false)` at the schema level (`prisma/schema.prisma:137/152`). The `deviceStateConfig` doesn't explicitly set `isOn` — it relies on Prisma's schema default. This is correct behavior (Prisma inserts the default), but it would be clearer to be explicit for all four state models' defaults. | `02-04-PLAN.md` Task 1 config. |
| **LOW** | The plan correctly creates the state row default for heater as `targetTemp: 20`, ac as `targetTemp: 22, mode: 'auto'`, and sensor as `reading: 0, unit: ''`. The `reading` column is `@db.Decimal(6,2)` (`prisma/schema.prisma:166`) — `0` is a valid Decimal value, and Prisma will handle the JS `number` → Decimal conversion. | `02-04-PLAN.md` Task 1. Confirmed OK. |

---

## 3. Cross-Cutting Concerns

| Issue | Plans Affected | Severity | Detail |
|-------|---------------|----------|--------|
| **Cascade verification test gap** | 02-02, 02-03, 02-04 | MEDIUM | All three plans say "assert via direct prisma reads that children are now soft-deleted" but `src/lib/prisma.ts:33-35` (`readGuard`) auto-injects `deletedAt: null`. A naive `prisma.room.findFirst` after cascade will return nothing, masking whether the row is soft-deleted or the id doesn't exist. **Fix**: The test must use `prismaRaw` (the un-extended client at `src/lib/prisma.ts:74`) or pass an explicit `{ deletedAt: { not: null } }` condition. |
| **`typebox` 1.x dependency age** | 02-01 | MEDIUM | The unscoped `typebox` package was published 2026-07-08 (5 days old). Strong evidence supports its legitimacy, but it's very new. The fallback (`@sinclair/typebox` 0.x) is documented and would be safer with zero behavioral difference for the schemas this phase writes. |
| **`prefixOverride = ''` fragility** | 02-02, 02-03, 02-04 | LOW | Three route files export `prefixOverride = ''` to bypass autoload's directory prefixing. If any dev removes it in a future edit, routes silently register at wrong paths (`/houses/houses/...`). Not a present bug, but worth documenting in the code adjacent to the export. |
| **State-row default consistency** | 02-04 | LOW | `light` and `heater` both rely on schema-level `@default(false)` for `isOn`, which is implicit. The plan is correct (Prisma handles it), but making defaults explicit in `deviceStateConfig` would be more readable and less error-prone if the schema later changes default values. |

---

## 4. Suggestions

1. **Fix cascade test verification** (MEDIUM): In all three slice plans (02-02/03/04), specify that the cascade test must use `prismaRaw` (from `src/lib/prisma.ts:74`) to query children after cascade, because `prisma`'s `readGuard` will auto-exclude the soft-deleted rows. Example:
   ```typescript
   const deleted = await prismaRaw.device.findFirst({ where: { id: device.id } })
   assert.ok(deleted?.deletedAt) // soft-deleted — row exists with a timestamp
   ```

2. **Consider `@sinclair/typebox` over `typebox`** (LOW-MEDIUM): Unless there's a specific feature in TypeBox 1.x the phase needs, the LTS `@sinclair/typebox` 0.x would be the safer dependency choice — it supports CJS natively (no `require(esm)` issue), is more battle-tested, and the schemas in Phase 2 (basic `Type.Object`, `Type.Partial`, `Type.Union` of literals) don't need JSON Schema 2020-12 features. This eliminates the Node version floor entirely, though `>=22.12.0` is already easy to meet.

3. **Commit to 201 for POST create** (LOW): The plans say "201/200" ambiguously. Pick 201 (Created) for all POST endpoints — it's the standard, and using 200 for POST makes it harder to distinguish from GET in client code. The existing auth routes use 200, but that's legacy to avoid copying.

4. **Add a GET /houses/:id 401 test** (LOW): The plans correctly include 401 tests for every non-existent-route, but the 401 tests should cover **both** missing token and invalid token cases. The plans only mention "no Authorization header." Also test with a garbage token like `Bearer definitelyfake`.

5. **Minor doc risk**: `prefixOverride` is a `@fastify/autoload` feature documented in `02-RESEARCH.md` but not in the code itself. Consider adding a one-line comment above each `export const prefixOverride = ''` explaining why it's needed, so future editors don't remove it thinking it's dead code.

---

## 5. Risk Assessment

**Overall risk: LOW**

The plans are structurally sound, thoroughly researched, and correctly address the project's key risks:

| Risk | Mitigation | Residual |
|------|-----------|----------|
| Transaction-unsafe cascade (Pitfall 1) | Direct `updateMany` inside `$transaction` — correctly specified in all 3 cascade plans | None |
| Mass assignment/data leakage | `additionalProperties:false` + explicit destructuring + no raw-row spread | Low (defense-in-depth) |
| IDOR / BOLA (cross-tenant access) | `where: { publicId, userId }` on every query; 404 not 403 | None |
| ESM dependency from CJS build | `engines.node >=22.12.0` + empirically verified `require(esm)` | Low (Node version floor) |
| Soft-delete user can authenticate | `src/services/refresh-token.ts:35` checks `user.deletedAt`; `readGuard` injects `deletedAt: null` on login | None (already correct, only missing a test) |

The **only real gap** that could produce a false-positive test pass: the cascade-verification tests in all three slice plans (02-02/03/04) need to use `prismaRaw` or an explicit `deletedAt` filter. If they use the regular extended `prisma`, they'll pass when they *should* be verifying soft-deletion. This is a test-correctness issue, not an implementation bug, but it means the cascade tests wouldn't actually validate what they claim to.

---

## Consensus Summary

Only one independent reviewer (opencode) was available this run — Claude was excluded as self, and no other CLI is installed — so there is no cross-reviewer consensus to synthesize. The single review's verdict:

### Top Concerns (single-reviewer, source-grounded)

1. **[MEDIUM] Cascade-verification test gap** (02-02, 02-03, 02-04) — tests read children back through the extended `prisma` client, whose `readGuard` (`src/lib/prisma.ts:33-35`) auto-filters `deletedAt: null`. A soft-deleted row will be invisible, so the assertion passes whether the row was cascaded or never existed. Fix: query via `prismaRaw` (`src/lib/prisma.ts:74`) or an explicit `{ deletedAt: { not: null } }` filter. **This is the one finding worth acting on before execution.**
2. **[MEDIUM] `typebox` 1.x is 5 days old** (02-01) — new dependency in the validation layer; `@sinclair/typebox` 0.x is a documented, battle-tested, CJS-native fallback that also drops the Node `>=22.12.0` floor.
3. **[LOW] POST status ambiguity (201 vs 200)** — commit to one to avoid false test failures.

### Strengths Confirmed Against Source

Pitfall 1 (`$transaction` `base`-escape) avoided in all cascade plans; multi-tenant isolation via `where: { publicId, userId }` returning 404; mass-assignment defense-in-depth; eager 3-step state-row transaction; exhaustive typed `Record` configs.

**Overall: LOW risk.** No implementation-level blockers; the cascade test-correctness gap is the single item to fold into planning.
