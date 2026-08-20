---
phase: 2
slug: entity-crud-multi-tenancy
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-09
validated: 2026-07-30
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in test runner (`node:test` + `node:assert`) |
| **Config file** | none — `tsconfig.json` compiles TS → `dist/`; tests run against compiled JS |
| **Test database** | dedicated `smart_house_testing` DB via `.env.testing` (hard-fails if absent); truncated between tests, `--test-concurrency=1` |
| **Quick run command** | `npm run build && node --test dist/src/test/routes/<file>.test.js` |
| **Full suite command** | `npm test` (build then `node --test dist/src/test/**/*.test.js`) |
| **Measured runtime** | ~45s full suite (39 tests) |

---

## Sampling Rate

- **After every task commit:** Run `npm run build && node --test dist/src/test/<changed-file>.test.js`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~45 seconds

---

## Per-Requirement Verification Map

> Every ownership-scoped route carries a second-user 404 test (TEST-01), a 401 test (TEST-08), and a soft-delete-exclusion test (TEST-05). Device creation carries an eager-state-row invariant test (STATE-01).

| Requirement | Plan | Secure Behavior | Test Type | Automated Command | Status |
|-------------|------|-----------------|-----------|-------------------|--------|
| HOUSE-01 | 02 | Create house → 201, `publicId` present, no `id` | integration | `node --test dist/src/test/routes/houses.test.js` | ✅ green |
| HOUSE-02 | 02 | List/view own houses only | integration | `node --test dist/src/test/routes/houses.test.js` | ✅ green |
| HOUSE-03 | 02 | PATCH owned house, omitted fields untouched | integration | `node --test dist/src/test/routes/houses.test.js` | ✅ green |
| HOUSE-04 | 02 | DELETE cascades soft-delete to rooms/devices/state atomically | integration | `node --test dist/src/test/routes/houses.test.js` | ✅ green |
| HOUSE-05 / TEST-01 | 02 | Cross-tenant GET/PATCH/DELETE → 404 not 403, row unmutated | integration | `node --test dist/src/test/routes/houses.test.js` | ✅ green |
| ROOM-01 | 03 | Nested create verifies parent-house ownership; bypass → 404 | integration | `node --test dist/src/test/routes/rooms.test.js` | ✅ green |
| ROOM-02 | 03 | List rooms in owned house | integration | `node --test dist/src/test/routes/rooms.test.js` | ✅ green |
| ROOM-03 | 03 | PATCH owned room, omitted fields untouched | integration | `node --test dist/src/test/routes/rooms.test.js` | ✅ green |
| ROOM-04 | 03 | DELETE cascades soft-delete to devices/state atomically | integration | `node --test dist/src/test/routes/rooms.test.js` | ✅ green |
| DEV-01 | 04 | Add device of each of 4 types to owned room | integration | `node --test dist/src/test/routes/devices.test.js` | ✅ green |
| DEV-02 | 04 | List/view devices by room and by house | integration | `node --test dist/src/test/routes/devices.test.js` | ✅ green |
| DEV-03 | 04 | PATCH device metadata; `device_type` immutable | integration | `node --test dist/src/test/routes/devices.test.js` | ✅ green |
| DEV-04 | 04 | DELETE cascades soft-delete to per-type state | integration | `node --test dist/src/test/routes/devices.test.js` | ✅ green |
| DEV-05 | 04 | Unknown `device_type` → 400 (TypeBox union-literal) | integration | `node --test dist/src/test/routes/devices.test.js` | ✅ green |
| STATE-01 | 04 | Eager per-type state row w/ defaults in same nested create | integration | `node --test dist/src/test/routes/devices.test.js` | ✅ green |
| TEST-05 | 01/02/03/04 | Soft-deleted user can't log in; soft-deleted rows excluded from reads | integration | `npm test` (auth + all CRUD files) | ✅ green |
| TEST-08 | 02/03/04 | Every new endpoint → 401 for missing *and* invalid token | integration | `npm test` (all CRUD files) | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*Full suite: 39/39 green, exit 0 (verified 2026-07-30).*

---

## Wave 0 Requirements

- [x] TypeBox + `@fastify/type-provider-typebox` installed
- [x] `nanoid` installed (public_id minting)
- [x] `prisma generate` + dev-DB re-apply so generated `Device` type includes `house_id`
- [x] Per-entity test files scaffolded (houses / rooms / devices) with `build(t)` + `app.inject()` fixtures, including a shared second-user fixture (`createTwoTestUsers`)

*Existing infrastructure (`node:test`, `src/test/helper.ts` `build(t)`) covers the harness; the above were the phase-specific additions — all landed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `public_id` create-hook (21-char CSPRNG minting, distinctness, tx-safety) | T-2-01 | Direct TDD tests were written green then dropped at user request ("no need publicid tests"). Covered **indirectly**: every `seedHouse`/`seedRoom`/`seedDevice` and every create test asserts a valid `publicId` and no `id` leak. | Confirmed manually during 02-01 execution: 21-char ids, distinct per row, minting inside `$transaction`, skipped for models without a `public_id` column. |

*All phase requirement IDs have automated verification via `app.inject()`; the single manual entry above is a non-requirement implementation detail exercised indirectly by every seed.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 45s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-07-30 — 18/18 requirement IDs COVERED by passing live-DB integration tests.

---

## Validation Audit 2026-07-30

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

Reconstructed the Per-Requirement Verification Map from the four SUMMARY files and 02-VERIFICATION.md (the original file was an unfilled draft template). Cross-referenced against the running suite: `npm test` → **39/39 pass, exit 0**. No auditor spawn required — every requirement was already COVERED.
