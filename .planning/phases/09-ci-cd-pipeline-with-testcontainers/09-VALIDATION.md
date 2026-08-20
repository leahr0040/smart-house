---
phase: 9
slug: ci-cd-pipeline-with-testcontainers
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-02
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` (`node --test`), TypeScript compiled to `dist/` via `tsc` |
| **Config file** | none — driven by `package.json` scripts + `src/test/run-with-container.ts` |
| **Quick run command** | `npm test` (existing suite against local `.env.testing` — verifies test content still passes) |
| **Full suite command** | `npm run test:ci` (Testcontainers MySQL 8.0 → `prisma migrate deploy` → `node --test` → container stop — the phase deliverable) |
| **Estimated runtime** | `npm test` ~existing; `npm run test:ci` ~+15–30s for container boot + migrate |

*Requires Docker running locally for `test:ci`. CI (`ubuntu-latest`) has Docker preinstalled.*

---

## Sampling Rate

- **After every task commit:** Run `npm test` (fast — confirms the suite itself is still green).
- **After the phase wave:** Run `npm run test:ci` locally (Docker required) — the true acceptance signal.
- **Before `/gsd-verify-work`:** `npm run test:ci` green locally AND the pushed `ci.yml` job green on GitHub Actions.
- **Max feedback latency:** ~90 seconds (local `test:ci`).

---

## Per-Task Verification Map

*Task IDs are assigned by the planner in `09-01-PLAN.md`. The phase acceptance signal is a single observable: a green `npm run test:ci` end-to-end (and the same workflow green on GHA). Rows below map each requirement to its automated check; the executor updates Status.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 09-01-xx | 01 | 1 | CI-02 | — | Ephemeral Testcontainers MySQL 8.0 boots (same engine as dev/prod); `getConnectionUri()` yields the `mysql://` URL; migrations apply | integration | `npm run test:ci` | ❌ W0 | ⬜ pending |
| 09-01-xx | 01 | 1 | CI-03 | — | `npm test` still loads `.env.testing`; container path only via `USE_TESTCONTAINER_DB` | integration | `npm test` | ✅ | ⬜ pending |
| 09-01-xx | 01 | 1 | CI-01 | — | `ci.yml` runs suite on push + PR; red suite → non-zero job | manual (CI) | GHA run of `.github/workflows/ci.yml` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `@testcontainers/mysql` devDependency installed (behind the CLAUDE.md blocking human-approval gate) — without it `test:ci` cannot compile/run.
- [ ] Docker available in the execution environment for local `test:ci` runs.

*Existing `node:test` infrastructure covers all test content; this phase adds only the CI provisioning path.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Workflow triggers on push + PR and blocks merge on red | CI-01 | GitHub Actions execution cannot be exercised by the local `node:test` runner | Push the branch / open a PR; confirm the `test` job runs and that an intentionally-failing test produces a red (non-zero) job. |

*All other phase behaviors are covered by the automated `npm run test:ci` signal.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (`@testcontainers/mysql` install)
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
