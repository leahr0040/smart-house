---
phase: 2
slug: entity-crud-multi-tenancy
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-09
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in test runner (`node:test` + `node:assert`) |
| **Config file** | none — `tsconfig.json` compiles TS → `dist/`; tests run against compiled JS |
| **Quick run command** | `npm run build && node --test dist/src/test/routes/<file>.test.js` |
| **Full suite command** | `npm test` (build then `node --test dist/src/test/**/*.test.js`) |
| **Estimated runtime** | ~10–30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm run build && node --test dist/src/test/<changed-file>.test.js`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~30 seconds

---

## Per-Task Verification Map

> Filled by the planner/executor. Every ownership-sensitive route gets a second-user 404 row; every new endpoint gets a 401 row; device creation gets an eager-state-row invariant row.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 2-01-01 | 01 | 1 | REQ-TBD | T-2-01 / — | {expected secure behavior} | unit | `{command}` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] TypeBox + `@fastify/type-provider-typebox` installed (validation-schema tests cannot compile without it)
- [ ] `nanoid` installed (public_id minting)
- [ ] `prisma generate` + dev-DB re-apply so generated `Device` type includes `house_id`
- [ ] Per-entity test files scaffolded (houses / rooms / devices) with `build(t)` + `app.inject()` fixtures, including a shared second-user fixture

*Existing infrastructure (`node:test`, `src/test/helper.ts` `build(t)`) covers the harness; the above are the phase-specific additions.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| {behavior} | REQ-XX | {reason} | {steps} |

*Target: all phase behaviors have automated verification via `app.inject()`.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
