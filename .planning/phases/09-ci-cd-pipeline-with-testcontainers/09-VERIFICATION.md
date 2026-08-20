---
phase: 09-ci-cd-pipeline-with-testcontainers
verified: 2026-08-20T00:00:00Z
status: human_needed
score: 6/6 must-haves verified
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Push branch `feat/09-ci-cd-pipeline-with-testcontainers` (or open the PR) and watch the `.github/workflows/ci.yml` `test` job run on GitHub Actions for both a `push` event and a `pull_request` event."
    expected: "The `test` job appears in the GitHub Actions tab, runs to completion, and shows green (exit 0) on ubuntu-latest, mirroring the local `npm run test:ci` result (39/39 tests passing) verified in this session."
    why_human: "GitHub Actions execution cannot be observed from the local filesystem/git state. `git ls-remote --heads origin` confirms this branch has never been pushed (only `main`, `feat/02-entity-crud-multi-tenancy`, `feat/initial-setup` exist on origin), so CI-01's full acceptance bar — an actual green run on GitHub's Linux runners — is unobserved. This also confirms the pure-JS `@prisma/adapter-mariadb` driver adapter runs unmodified on the actual ubuntu-latest runner, not just under Docker Desktop on the executor's Windows machine."
  - test: "Confirm (or configure) a GitHub branch-protection rule that requires the `test` status check to pass before merging into `main`."
    expected: "A red `test` job actually blocks the merge button on a PR, not just shows a red X."
    why_human: "Branch protection / required-status-check configuration is a GitHub repository setting, not a file in this repo, so it cannot be verified by inspecting the codebase. The phase goal explicitly states 'a red suite fails the job and blocks merge' — the job-fails half is code-verified; the blocks-merge half depends on this GitHub setting."
---

# Phase 09: CI/CD Pipeline with Testcontainers Verification Report

**Phase Goal:** Stand up Continuous Integration for the repo — a GitHub Actions workflow that, on every push and pull_request, builds the project and runs the existing test suite against an ephemeral MySQL 8.0 provisioned by Testcontainers, with no GHA `services:` block and no standing database. A red suite fails the job and blocks merge. Local `npm test` behavior must remain unchanged.
**Verified:** 2026-08-20
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `.github/workflows/ci.yml` triggers on push + pull_request, ubuntu-latest, Node 22 w/ npm cache, `npm ci` → `npm run test:ci`; failing test → non-zero job (CI-01, D-01) | ✓ VERIFIED | File content read directly: `on: {push:, pull_request:}` (no branch filters), `runs-on: ubuntu-latest`, `actions/setup-node@v4` with `node-version: '22'`, `cache: npm`, steps `npm ci` then `npm run test:ci`. `run-with-container.ts` sets `process.exitCode` from the spawned `node --test` child's exit code (standard node:test non-zero-on-failure semantics), which GitHub Actions reads as job failure. The *actual GH-hosted run* is unobserved (see Human Verification #1) |
| 2 | CI tests run against `@testcontainers/mysql` ephemeral MySQL 8.0 with NO `services:` block; container reaches suite as `mysql://` DATABASE_URL from `getConnectionUri()` (CI-02, D-02, D-04) | ✓ VERIFIED | No `services:` key anywhere in `ci.yml`. `src/test/run-with-container.ts` line 13: `new MySqlContainer('mysql:8.0').start()`; line 17: `DATABASE_URL: container.getConnectionUri()` — no manual URL assembly. **Behaviorally confirmed**: I ran `npm run test:ci` myself this session (not from SUMMARY.md claims) — container booted, connected, ran the full suite, exited 0 |
| 3 | `prisma migrate deploy` applies the 3 committed migrations to the fresh container DB before any test runs; pure-JS driver-adapter client runs unmodified on Linux CI (D-05) | ✓ VERIFIED (migration behavior); ⚠ unobserved-on-Linux-CI folded into Human Verification #1 | `prisma/migrations/` contains exactly 3 migration folders (`20260616152601_init`, `20260617121303_add_refresh_tokens`, `20260707094526_add_domain_schema`) matching the plan's "3 committed migrations" claim. **Behaviorally confirmed**: my own `npm run test:ci` run's captured output shows all 3 migrations applied ("All migrations have been successfully applied") before any test executed. The adapter is pure-JS (no native binary) by design, but was only exercised via Docker Desktop on Windows this session, not the actual ubuntu-latest runner |
| 4 | `npm run test:ci` boots container, injects DATABASE_URL/JWT_SECRET/USE_TESTCONTAINER_DB into spawned child, applies migrations, spawns `node --test`, ALWAYS stops container in finally; exits with test child's status (D-06) | ✓ VERIFIED | Code: `testEnv` spread includes all three vars (lines 15-20); `container.stop()` lives inside a `finally` block (line 39-41), guaranteed to run by JS language semantics regardless of migrate/test outcome; `process.exitCode = exitCode` (line 43) propagates the child's code. **Behaviorally confirmed** end-to-end this session: `npm run test:ci` completed with `[exited with code 0]`, 39/39 tests passing, after applying migrations |
| 5 | Local `npm test` still loads `.env.testing` unchanged; container path entered only when USE_TESTCONTAINER_DB is set (CI-03, D-07) | ✓ VERIFIED | `src/test/env.ts` gates the `.env.testing` dotenv load + missing-file throw behind `if (!process.env.USE_TESTCONTAINER_DB)` — references only the flag, never `DATABASE_URL` presence, matching D-07's prohibition. **Behaviorally confirmed**: I ran `npm test` myself this session — 39/39 tests passed against `.env.testing`, unaffected by the phase's changes |
| 6 | `@testcontainers/mysql` (+ transitive `testcontainers`) is a devDependency, installed only after the blocking-human approval checkpoint (D-08) | ✓ VERIFIED | `package.json` places `@testcontainers/mysql: ^12.0.4` under `devDependencies` (not `dependencies`); `npm ls @testcontainers/mysql testcontainers` resolves both cleanly at `12.0.4`, no UNMET. Plan Task 1 is a `checkpoint:human-verify gate="blocking-human"` that must clear before Task 2's install; SUMMARY.md records it as approved prior to the Task 2 commit (`3b3cc1f`). Process compliance is not independently re-verifiable after the fact beyond this trail, but nothing in the repo contradicts it |

**Score:** 6/6 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `.github/workflows/ci.yml` | GHA workflow, push+PR triggers, no services block | ✓ VERIFIED | Matches spec exactly; substantive (not a stub), wired (the only CI entrypoint) |
| `src/test/run-with-container.ts` | Testcontainers runner | ✓ VERIFIED | Compiles clean (`npm run build` exit 0); `dist/src/test/run-with-container.js` produced; not picked up by the `*.test.js` glob (confirmed by listing `dist/src/test/**/*.test.js`) |
| `src/test/env.ts` (modified) | USE_TESTCONTAINER_DB guard | ✓ VERIFIED | Guard present, correctly scoped, `override:true` and the missing-file throw preserved inside the guarded block |
| `package.json` (modified) | `test:ci` script + devDependency | ✓ VERIFIED | `scripts.test` byte-identical to pre-phase value (`tsc && node --test --test-concurrency=1 dist/src/test/**/*.test.js`); `scripts.test:ci` = `tsc && node dist/src/test/run-with-container.js`; devDependency present |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `run-with-container.ts` | `src/test/env.ts` | `USE_TESTCONTAINER_DB` env var set in spawned child | ✓ WIRED | Confirmed by code + live run (env.ts's guard skipped, container DATABASE_URL used) |
| `run-with-container.ts` | `@testcontainers/mysql` | `MySqlContainer('mysql:8.0')`, `getConnectionUri()` | ✓ WIRED | Confirmed by code + live run (container booted, URL consumed directly, no manual reassembly) |
| `run-with-container.ts` | `prisma migrate deploy` | spawned via npx with repo-root cwd (no override) | ✓ WIRED | No `cwd` override in either spawn call; live run applied all 3 migrations successfully from default cwd |
| `run-with-container.ts` | container lifecycle | `container.stop()` inside `finally` | ✓ WIRED | Live run completed and exited cleanly (code 0) after the full container → migrate → test cycle |
| `.github/workflows/ci.yml` | `npm run test:ci` | `run: npm run test:ci` step | ✓ WIRED | Direct string match; this is the sole test-invoking step in the job |

### Behavioral Spot-Checks / Live Runs

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Local test suite unaffected by phase changes (CI-03) | `npm test` | 39/39 pass, exit 0, `.env.testing` injected as before (~92s) | ✓ PASS |
| Full Testcontainers CI path (CI-02, D-05, D-06) | `npm run test:ci` | Container booted → 3 migrations applied → 39/39 tests pass → container stopped → exit 0 (~240s) | ✓ PASS |

Both commands were executed directly by the verifier in this session — not inferred from SUMMARY.md's claims.

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| CI-01 | ROADMAP.md Phase 9 (not present in REQUIREMENTS.md — see note) | Suite runs on push + PR | ✓ SATISFIED (workflow shape + local-equivalent command); actual GH-hosted green run unobserved | See Human Verification #1 |
| CI-02 | ROADMAP.md Phase 9 | Ephemeral DB via Testcontainers, not a GHA service container | ✓ SATISFIED | Behaviorally verified this session |
| CI-03 | ROADMAP.md Phase 9 | Local `npm test` behavior preserved | ✓ SATISFIED | Behaviorally verified this session |

**Note on REQUIREMENTS.md:** `CI-01`/`CI-02`/`CI-03` do not appear anywhere in `.planning/REQUIREMENTS.md` (confirmed via search — zero matches). That file's traceability table only tracks the v1 feature-milestone requirement families (`HOUSE-*`, `ROOM-*`, `DEV-*`, `STATE-*`, `CMD-*`, `MSG-*`, `EVENT-*`, `DATA-*`, `TEST-*`). Phase 9 is an infrastructure phase whose requirements are defined and tracked directly in `.planning/ROADMAP.md`'s Phase 9 section (`**Requirements**: CI-01, CI-02, CI-03`) instead. This is consistent with the project's structure (REQUIREMENTS.md = the milestone's feature scope) rather than a missing-traceability gap, so it is reported here as informational, not a finding.

### Anti-Patterns Found

None. Scanned `.github/workflows/ci.yml`, `src/test/run-with-container.ts`, `src/test/env.ts`, and `package.json` for `TODO|FIXME|XXX|HACK|PLACEHOLDER` and stub-return patterns — zero matches in all four files.

### Documentation Drift (informational, not a code gap)

`.planning/ROADMAP.md`'s Phase 9 section (Success Criteria #2, #4, #6, and the phase Goal text, lines ~262-282) still says `@testcontainers/mariadb` / "MariaDB" in several places, predating the engine-name correction (commit `c451287`, "docs: correct database engine to MySQL 8.0, not MariaDB") that the actual `09-01-PLAN.md` and delivered code correctly follow (`@testcontainers/mysql`, MySQL 8.0). The delivered code matches `CLAUDE.md`'s authoritative engine documentation and the plan's explicit prohibition ("Do NOT use `@testcontainers/mariadb`"). This is a stale-text issue in `ROADMAP.md` only — not a functional gap — but should be fixed so the roadmap record doesn't contradict what was actually built. Not blocking; flagged for cleanup.

### Human Verification Required

1. **Push the branch and observe an actual green GitHub Actions run.**
   Test: Push `feat/09-ci-cd-pipeline-with-testcontainers` (or open a PR against `main`) and watch the `test` job in the Actions tab.
   Expected: The job runs on `ubuntu-latest` for both the `push` and (on PR) `pull_request` events and finishes green, matching the 39/39 pass, exit-0 result already reproduced locally this session.
   Why human: Cannot be observed from local git/filesystem state. `git ls-remote --heads origin` confirms this branch has never been pushed.

2. **Confirm branch protection actually blocks merge on a red job.**
   Test: Check (or set) a required-status-check branch-protection rule on `main` for the `test` job.
   Expected: A red `test` job prevents the PR merge button from being usable, not just shows a warning.
   Why human: Branch protection is a GitHub repository setting, not a file in this repo — the phase goal's "blocks merge" clause depends on it.

### Gaps Summary

No gaps. All 6 must-have truths are verified against the actual codebase, including two live, verifier-run executions of both `npm test` and `npm run test:ci` (not SUMMARY.md claims) — the ephemeral-MySQL CI path genuinely boots a container, migrates it, and runs the full 39-test suite green, and the local path is unaffected. The only open items are the two human-verification checks above, both of which concern GitHub-side state (an unpushed branch, and repository branch-protection settings) that cannot be observed from the codebase. These are exactly the CI-01 "full acceptance bar" caveat the phase's own SUMMARY.md flagged as still outstanding.

---

*Verified: 2026-08-20*
*Verifier: Claude (gsd-verifier)*
