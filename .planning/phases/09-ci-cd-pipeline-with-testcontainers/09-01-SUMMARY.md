---
phase: 09-ci-cd-pipeline-with-testcontainers
plan: 01
subsystem: infra
tags: [github-actions, testcontainers, mysql, prisma, ci]

# Dependency graph
requires: []
provides:
  - GitHub Actions CI workflow running the suite on push + pull_request
  - Ephemeral MySQL 8.0 via @testcontainers/mysql (no GHA services block)
  - USE_TESTCONTAINER_DB env-gated bypass of .env.testing loading
affects: [any future phase — CI now runs its tests automatically on push/PR]

# Tech tracking
tech-stack:
  added: ["@testcontainers/mysql@^12.0.4 (devDependency, pulls in testcontainers@^12 transitively)"]
  patterns:
    - "Spawn-based test runner (not --test-global-setup) so env vars land in the child process env before any test module imports env.ts"
    - "Env-flag gate (not DATABASE_URL-presence gate) to keep a truncating test suite from ever pointing at a real database"

key-files:
  created:
    - .github/workflows/ci.yml
    - src/test/run-with-container.ts
  modified:
    - src/test/env.ts
    - package.json

key-decisions:
  - "@testcontainers/mysql chosen over @testcontainers/mariadb — engine is MySQL 8.0, not MariaDB, despite the @prisma/adapter-mariadb package name (D-04 research note)"
  - "USE_TESTCONTAINER_DB gates the .env.testing bypass, never DATABASE_URL presence, so a stray dev-shell DATABASE_URL is still overridden locally (D-07)"
  - "prisma migrate deploy spawn uses npx.cmd + shell:true on Windows (ENOENT otherwise); node --test spawn stays shell:false so node expands the ** glob"

patterns-established:
  - "Ephemeral-DB CI pattern: MySqlContainer('mysql:8.0').start() → getConnectionUri() → prisma migrate deploy → node --test → container.stop() in finally, exit code propagated via process.exitCode"

requirements-completed: [CI-01, CI-02, CI-03]

coverage:
  - id: D1
    description: "GitHub Actions workflow (.github/workflows/ci.yml) triggers on push + pull_request, runs on ubuntu-latest, Node 22 with npm cache, npm ci then npm run test:ci, no services block"
    requirement: "CI-01"
    verification:
      - kind: other
        ref: "npm run test:ci — local run of the exact command the workflow invokes; exit 0"
        status: pass
    human_judgment: true
    rationale: "Workflow file structure and the command it runs are verified locally, but CI-01's actual acceptance bar (job runs green on GitHub Actions after push, and a red suite blocks merge) requires observing a real push/PR run on GitHub, which has not happened yet from this session."
  - id: D2
    description: "run-with-container.ts boots an ephemeral MySQL 8.0 container, applies the 3 committed migrations via prisma migrate deploy, runs the full node --test suite against it, and always stops the container"
    requirement: "CI-02"
    verification:
      - kind: integration
        ref: "npm run test:ci — 39/39 tests pass, container boots, migrations applied, container stops, process exits 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Local npm test is unchanged — still loads .env.testing, container path only entered when USE_TESTCONTAINER_DB is set"
    requirement: "CI-03"
    verification:
      - kind: integration
        ref: "npm test — 39/39 tests pass, .env.testing injected as before"
        status: pass
    human_judgment: false
  - id: D4
    description: "@testcontainers/mysql (+ transitive testcontainers) installed as a devDependency only after the blocking-human legitimacy checkpoint (Task 1) was approved"
    verification:
      - kind: other
        ref: "npm ls @testcontainers/mysql — resolves 12.0.4 under devDependencies, no UNMET"
        status: pass
    human_judgment: false

duration: ~2h active (spread across two sessions, 2026-08-03 and 2026-08-20 — see Issues Encountered)
completed: 2026-08-20
status: complete
---

# Phase 09: CI/CD Pipeline with Testcontainers Summary

**GitHub Actions workflow runs the existing suite on push/PR against an ephemeral `@testcontainers/mysql` 8.0 container — no standing DB, no GHA services block.**

## Performance

- **Duration:** ~2h active work (interrupted between sessions; see Issues Encountered)
- **Started:** 2026-08-03T21:41:53+03:00
- **Completed:** 2026-08-20T10:49:53+03:00
- **Tasks:** 4 (1 checkpoint + 3 implementation)
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- `.github/workflows/ci.yml`: `test` job on `ubuntu-latest`, triggers on push + pull_request, Node 22 with npm cache, `npm ci` → `npm run test:ci`, no `services:` block
- `src/test/run-with-container.ts`: boots `MySqlContainer('mysql:8.0')`, takes `DATABASE_URL` from `getConnectionUri()`, runs `prisma migrate deploy` then the full `node --test` suite, always stops the container in a `finally`, propagates the child's exit code
- `src/test/env.ts` USE_TESTCONTAINER_DB guard: the `.env.testing` load is skipped only when the runner sets the flag — local `npm test` behavior is byte-for-byte unchanged
- `@testcontainers/mysql` devDependency installed after a blocking-human supply-chain checkpoint confirmed the package's legitimacy

## Task Commits

Each task was committed atomically:

1. **Task 1: Package legitimacy checkpoint** — human-verify checkpoint, approved (no code commit)
2. **Task 2: Install @testcontainers/mysql + add test:ci script** — `3b3cc1f`
3. **Task 3: USE_TESTCONTAINER_DB guard in src/test/env.ts (D-07)** — `23e5158`
4. **Task 4: run-with-container.ts runner + ci.yml** — `9193e42`

## Files Created/Modified
- `.github/workflows/ci.yml` - GitHub Actions CI workflow (push + pull_request, no services block)
- `src/test/run-with-container.ts` - Testcontainers-backed test runner used by `npm run test:ci`
- `src/test/env.ts` - USE_TESTCONTAINER_DB guard around the `.env.testing` load
- `package.json` - `@testcontainers/mysql` devDependency + `test:ci` script

## Decisions Made
- `@testcontainers/mysql` over `@testcontainers/mariadb`: the running engine is MySQL 8.0 — `@prisma/adapter-mariadb` is Prisma's shared driver adapter name for the whole MySQL/MariaDB family, not evidence of engine choice.
- Gate keyed on `USE_TESTCONTAINER_DB` only, never on `DATABASE_URL` presence, so a stray dev-shell `DATABASE_URL` can never redirect the truncating suite at a real database.
- Windows-safe spawn for `prisma migrate deploy` (`npx.cmd` + `shell:true`); `node --test` spawn kept `shell:false` so Node expands the `**` glob identically to the existing `test` script.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

Execution was interrupted after Task 3 (2026-08-03): Task 4's files (`ci.yml`, `run-with-container.ts`) were created and staged but the session ended before they were committed, verified, or summarized — no `SUMMARY.md` existed and `STATE.md`/`ROADMAP.md` tracking was left stale. Resumed on 2026-08-20 via `/gsd-execute-phase`'s safe-resume gate, which detected the committed-but-unsummarized state and stopped before dispatching a new executor (avoiding risk of re-triggering the Task 1 approval gate or duplicating Task 2/3 work). Closed out manually: inspected the staged files (compiled clean, matched acceptance criteria), ran `npm run test:ci` end-to-end (Docker required — user started Docker Desktop mid-session), confirmed local `npm test` unaffected, then committed Task 4 and wrote this summary.

## User Setup Required

None - no external service configuration required. (Docker must be running locally to execute `npm run test:ci`; no CI-side secrets are needed since JWT_SECRET is a hardcoded non-production placeholder and the DB is fully ephemeral.)

## Next Phase Readiness
- CI now runs automatically on push/PR against every future phase's changes — no per-phase CI setup needed.
- Outstanding: push this branch (or open the PR) to observe the workflow actually go green on GitHub Actions — CI-01's full acceptance bar (a real GitHub Actions run) is still unobserved from this local session.

---
*Phase: 09-ci-cd-pipeline-with-testcontainers*
*Completed: 2026-08-20*
