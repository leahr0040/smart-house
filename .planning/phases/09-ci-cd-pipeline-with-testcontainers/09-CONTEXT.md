# Phase 9: CI/CD Pipeline with Testcontainers - Context

**Gathered:** 2026-08-02
**Status:** Ready for planning
**Source:** Interactive design session (functions as discuss-phase)

<domain>
## Phase Boundary

Stand up **Continuous Integration** for the repo: a GitHub Actions workflow that, on every `push` and `pull_request`, builds the project and runs the **existing** test suite against an **ephemeral MySQL provisioned by Testcontainers** — no GHA `services:` block, no standing database. A red suite fails the job.

In scope: `.github/workflows/ci.yml`; a `test:ci` npm script + a small Node runner that boots the container, injects `DATABASE_URL`, applies migrations, and spawns `node --test`; a one-line guard in `src/test/env.ts`; adding `@testcontainers/mysql` as a devDependency (CI-01, CI-02, CI-03).

**Not in scope:** CD / deployment (no deploy target exists yet), Node-version matrix builds, extra caching beyond `actions/setup-node`, any change to test *content* or to local `npm test` behavior, RabbitMQ/second-container work (that is Phase 8's concern, not this phase).

This phase wraps the Phase 2 test suite; it does not depend on Phases 3–8 and can land before them.
</domain>

<decisions>
## Implementation Decisions

Locked with the user during the design session. **The engine is MySQL 8.0** — verified 2026-08-03 against the live dev DB: `SELECT VERSION()` → `8.0.46`, `MySQL Community Server - GPL`, `collation_server = utf8mb4_0900_ai_ci` (a collation MariaDB does not have). `provider = "mysql"`, connected through `@prisma/adapter-mariadb`, which is Prisma's single driver adapter for the MySQL/MariaDB family (it wraps the `mariadb` npm client, which speaks to MySQL servers too). The package name is not the engine; do not infer MariaDB from it.

### CI provider & triggers
- **D-01 (GitHub Actions, single job):** One workflow `.github/workflows/ci.yml`, one `test` job on `ubuntu-latest`, triggered on `push` and `pull_request`. Steps: `actions/checkout@v4` → `actions/setup-node@v4` (Node `22`, `cache: npm`) → `npm ci` → `npm run test:ci`. A non-zero exit fails the job (blocks merge).
- **D-02 (no `services:` block):** Testcontainers *is* the database. Docker is preinstalled and running on `ubuntu-latest`, so `@testcontainers/mysql` works with no runner setup.

### Test DB provisioning
- **D-03 (Testcontainers ephemeral MySQL):** A `test:ci` runner (`src/test/run-with-container.ts`, compiled to `dist/`) starts `new MySqlContainer('mysql:8.0')` — matching the MySQL 8.0 engine used in dev — then hands the suite a connection string. New npm script: `"test:ci": "tsc && node dist/src/test/run-with-container.js"`. `npm test` is **untouched**.
- **D-04 (use `getConnectionUri()`):** `MySqlContainer.getConnectionUri()` builds its URL from `new URL("", "mysql://")`, so the scheme is already exactly what `@prisma/adapter-mariadb` expects. One call, no manual assembly. *(Superseded: this decision previously mandated hand-building the URL from the getters to dodge a `mariadb://` scheme — that scheme only comes from the MariaDB module, which this phase no longer uses.)*
- **D-05 (`prisma migrate deploy` before tests):** The runner runs `prisma migrate deploy` against the fresh container DB (env `DATABASE_URL` set) to apply the 3 committed migrations. `relationMode="prisma"` ⇒ no shadow DB needed. The committed driver-adapter client (`src/generated/prisma`) is pure-JS (no query-engine binary) and runs unmodified on Linux CI.
- **D-06 (runner spawns `node --test`, always tears down):** After migrations, spawn `node --test --test-concurrency=1 "dist/src/test/**/*.test.js"` with the augmented env inherited (`node` expands the glob itself — no shell needed). Container `.stop()` runs in a `finally`; the process exits with the child's status. Teardown-on-failure is the one non-trivial bit of logic.

### Safety — never point the truncating suite at a real DB
- **D-07 (bypass the `.env.testing` guard only via an explicit flag):** `src/test/env.ts` currently loads `.env.testing` with `override:true` and throws if it is missing — this is a *data-loss guard* (the suite `TRUNCATE`s every table). The change is a single guard: skip the `.env.testing` load **only** when `process.env.USE_TESTCONTAINER_DB` is set (the runner sets it alongside `DATABASE_URL`). Do **not** key the bypass on "is `DATABASE_URL` set" — a stray `DATABASE_URL` in a dev shell must still be overridden by `.env.testing` locally. Local `npm test` therefore behaves exactly as today.

### Dependencies
- **D-08 (package install is a gated devDependency):** `@testcontainers/mysql` (pulls in `testcontainers`). Per CLAUDE.md the install is behind a blocking human-approval checkpoint — the plan must call it out as `user_setup` / a stop-and-ask, not silently install.

### Claude's Discretion (researcher/planner to confirm)
- Whether `prisma migrate deploy` is invoked as `npx prisma …` vs `node_modules/.bin/prisma`, and confirming its Linux migration-engine binary fetches cleanly under `npm ci`.
- The `mysql:8.0` image tag (pin to a more specific patch tag/digest if flakiness warrants).
- Whether MySQL 8.0's default `caching_sha2_password` auth plugin needs anything from the `mariadb` client the adapter wraps (expected: no — dev already connects to MySQL 8.0 through this same adapter).
- Node version pin (`22` chosen to match `engines`; `24` acceptable) and whether an explicit Docker readiness step is ever needed on GHA (expected: no).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Planning specs (authoritative for Phase 9)
- `.planning/ROADMAP.md` §"Phase 9: CI/CD Pipeline with Testcontainers" — Goal, the 6 Success Criteria (the acceptance contract), CI-01/02/03, and the explicit out-of-scope list (CD, matrix, extra caching).

### Existing code (integration points — read before writing)
- `src/test/env.ts` — the `.env.testing` loader + truncation guard being relaxed (D-07). The only file whose behavior changes.
- `src/test/helper.ts` / `src/test/helpers/fixtures.ts` — `build(t)` + `app.inject()` harness; `resetDb()` TRUNCATEs all tables; `closeDb()` must run in `after` (Prisma pool keeps the event loop alive). Explains *why* the DB must be disposable.
- `src/lib/env.ts` — zod-validated env (`DATABASE_URL`, `JWT_SECRET` required); read at import.
- `src/lib/prisma.ts` — `new PrismaClient({ adapter: new PrismaMariaDb(env.DATABASE_URL) })` at import; pure-JS driver adapter (no query-engine binary → Linux-portable committed client). `PrismaMariaDb` is the adapter class name, **not** a statement about the engine — the engine is MySQL 8.0.
- `package.json` — `scripts.test` (`tsc && node --test --test-concurrency=1 dist/src/test/**/*.test.js`), `engines.node >=22`, `prisma` + `@prisma/adapter-mariadb` deps.
- `prisma/schema.prisma` — `provider = "mysql"`, `relationMode = "prisma"`, generator output `../src/generated/prisma`.
- `prisma/migrations/` — 3 committed migrations `prisma migrate deploy` must apply.

### Prior-phase precedent
- `.planning/ROADMAP.md` §"Phase 8" + STATE.md — Phase 8 already plans **two-container** Testcontainers (DB + RabbitMQ) for E2E with a shared suite-level fixture and between-test reset. Phase 9's single-container CI pattern should stay compatible with (not duplicate/conflict with) that future work; Phase 8's DB container must be the same `@testcontainers/mysql` / `mysql:8.0` this phase settles on.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`node --test` glob support** — the current `npm test` already relies on `node` expanding `dist/src/test/**/*.test.js`; the runner reuses the same invocation, so no test-file changes.
- **Driver-adapter client is platform-agnostic** — `@prisma/adapter-mariadb` needs no native query engine, so the committed `src/generated/prisma` runs as-is on the Linux CI runner (only the migration-engine binary is fetched per-platform, by `prisma migrate deploy`).
- **`resetDb()` / `closeDb()`** already isolate tests via TRUNCATE + pool disconnect — a fresh container per CI run means no cross-run pollution and no seed cleanup needed.

### Established Patterns
- **Env read at import time** — `src/lib/env.ts` and `src/lib/prisma.ts` both read `process.env` / build the client at module load. Therefore `DATABASE_URL` **must** be in the environment before any test file imports `env.ts`; a spawn-with-env runner (D-06) guarantees ordering more robustly than node's experimental `--test-global-setup` (rejected: env-inheritance across process isolation is fragile).
- **TypeScript-first tooling** — everything compiles through `tsc` to `dist/`; the runner is TS at `src/test/run-with-container.ts` → `dist/src/test/run-with-container.js`. It ends in `.ts`, not `.test.ts`, so `node --test`'s `*.test.js` glob never picks it up as a test.

### Integration Points
- The only behavioral seam is `src/test/env.ts` (D-07). Everything else is additive (new workflow, new runner, package.json script + dep).
</code_context>

<specifics>
## Specific Ideas

- Runner env block: `{ ...process.env, DATABASE_URL: <mysql url>, JWT_SECRET: 'ci-test-secret', USE_TESTCONTAINER_DB: '1' }`.
- `.github/workflows/ci.yml` uses `actions/checkout@v4` + `actions/setup-node@v4` with `cache: npm`; no `services:` block.
- The runner is the phase's own runnable check — a green `npm run test:ci` (container boots → migrations apply → suite passes → container stops) is the acceptance signal. No separate unit test for the runner.
</specifics>

<deferred>
## Deferred Ideas

- **CD / deployment** — no host/registry/Dockerfile exists; add a deploy job only when there is a real target.
- **Node-version matrix** — single Node 22 for now; add a matrix if multi-version support becomes a requirement.
- **Extra caching** (Docker layer cache, Prisma engine cache) — rely on `actions/setup-node` npm cache only until CI time is a problem.
- **Reusing the runner for local `npm test`** — kept separate; local stays on `.env.testing`, container path is CI-only (opt-in via the flag).

None of the above are blockers; the discussion stayed within phase scope.
</deferred>

---

*Phase: 09-ci-cd-pipeline-with-testcontainers*
*Context gathered: 2026-08-02 via interactive design session*
