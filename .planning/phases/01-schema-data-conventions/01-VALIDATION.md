---
phase: 1
slug: schema-data-conventions
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-02
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> **Revised id strategy:** BigInt autoincrement internal PKs + NanoID `public_id` on user-facing entities; `events` carries BigInt `id` (ordering) + deterministic `event_id` uuidv5 (idempotency).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node built-in test runner (`node:test` + `node:assert`) |
| **Config file** | none — `package.json` scripts drive build + test |
| **Quick run command** | `npm run build` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm run build`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** `prisma migrate dev` exits 0, `npm run build` clean, `npm test` green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | DATA-01 | — | N/A (schema-only phase) | compile | `npm run build` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

> **Schema/infra exception:** Phase 1 has no runnable application logic to test red (per ROADMAP notes). Acceptance = compile + migration smoke-check: `prisma migrate dev` exits 0, `npm run build` clean, `npm test` (existing auth) green. Per-task verify is a compile/migration/grep assertion, not a TDD-red test. The planner refines this map during planning.

---

## Wave 0 Requirements

- [ ] `prisma migrate dev` applies cleanly (rename + Int→BigInt widen + additive tables) — DATA-01…DATA-04
- [ ] `npx prisma generate` regenerates the client to `src/generated/prisma/`
- [ ] Existing auth tests (`npm test`) stay green — regression guard

*Framework already present — no new test framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `User` → `users` rename emits `RENAME TABLE` (not DROP+CREATE) | DATA-01 | Data-loss risk — hand-verify migration SQL before applying | `prisma migrate dev --create-only`; open generated `.sql`; confirm `RENAME TABLE`, no `DROP TABLE`/`CREATE TABLE` on existing tables |
| `User.id`/`RefreshToken.id`/`refresh_tokens.user_id` widen Int→BigInt via `MODIFY COLUMN` (not DROP+CREATE) | DATA-02 | Data-loss risk — lossless widen must be hand-confirmed in SQL | In the same/second create-only migration, confirm `MODIFY ... BIGINT ... AUTO_INCREMENT` on the PKs and `MODIFY ... BIGINT` on `user_id`; no table re-create |
| `public_id` column shape (NanoID) | DATA-02 | Generator lands in Phase 2; Phase 1 only shapes the column | Confirm `public_id String @unique @db.VarChar(21)` on House/Room/Device/Command; absent on CommandTarget, state tables, events |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
