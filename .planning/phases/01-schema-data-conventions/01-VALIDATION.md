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

> **Schema/infra exception:** Phase 1 has no runnable application logic to test red (per ROADMAP notes). The acceptance bar is a compile + migration smoke-check: `prisma migrate dev` exits 0, `npm run build` compiles clean, `npm test` passes existing auth tests. Per-task verify is a compile/migration assertion, not a TDD-red test. The planner refines this map during planning.

---

## Wave 0 Requirements

- [ ] `prisma migrate dev` applies cleanly (rename + new tables) — DATA-01…DATA-04
- [ ] `npx prisma generate` regenerates the client to `src/generated/prisma/`
- [ ] Existing auth tests (`npm test`) stay green — regression guard

*Framework already present — no new test framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Generated rename migration emits `RENAME TABLE` (not DROP+CREATE) | DATA-01 | Data-loss risk — must be hand-verified in migration SQL before applying | Run `prisma migrate dev --create-only`; open the generated `.sql`; confirm `RENAME TABLE ` present for `User` → `users`, no `DROP TABLE`/`CREATE TABLE` on existing tables |
| Adapter emits uuid **v7** (not v4) for `@default(uuid(7))` | DATA-02 | Runtime generator behavior; not compile-checkable | After a smoke insert, confirm generated PK sorts time-ordered / has version nibble `7` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
