# Phase 9 Research: CI/CD Pipeline with Testcontainers

**Researched:** 2026-08-02
**Revised:** 2026-08-03 — engine corrected from MariaDB to **MySQL 8.0**; see §Engine Correction
**Domain:** GitHub Actions CI + Testcontainers-provisioned ephemeral MySQL + Prisma 7 `migrate deploy`
**Confidence:** HIGH

## Engine Correction (2026-08-03)

The original research inferred the database engine from the dependency name `@prisma/adapter-mariadb` and concluded MariaDB. **That was wrong.** The engine is **MySQL 8.0**.

Verified against the live dev database, 2026-08-03 [VERIFIED]:

| Probe | Result |
|-------|--------|
| `SELECT VERSION()` | `8.0.46` |
| `@@version_comment` | `MySQL Community Server - GPL` |
| `@@character_set_server` / `@@collation_server` | `utf8mb4` / `utf8mb4_0900_ai_ci` |

The server collation is independent proof of the family: `utf8mb4_0900_ai_ci` was introduced in MySQL 8.0 and **does not exist in MariaDB at any version**. A MariaDB container could not reproduce this server's defaults.

A second confirmation surfaced while probing: the raw `mariadb` npm client (v3.4.5, the one the adapter wraps) **rejects** the project's own `mysql://` DATABASE_URL — its connection-string parser demands a `mariadb://` scheme. `PrismaMariaDb` parses the URL itself and passes components to the client, which is why the app works. So the `mysql://`-vs-`mariadb://` distinction that motivated the original D-04 is real, but it lives at the raw-client layer, not at the adapter layer where D-04 placed it.

`@prisma/adapter-mariadb` is Prisma's single driver adapter for the entire MySQL/MariaDB family — it wraps the `mariadb` npm client, which speaks to MySQL servers as well. Neither the package name nor the `PrismaMariaDb` class in `src/lib/prisma.ts` says anything about the engine. `provider = "mysql"` in `schema.prisma` and the `mysql://` URL scheme were always literally correct.

Consequences, all folded into the sections below:
- Container module is `@testcontainers/mysql` (`MySqlContainer`), image `mysql:8.0` — **not** `@testcontainers/mariadb` / `mariadb:11`. CI must exercise the same engine as dev/prod.
- **D-04 is void.** It existed only to dodge `MariaDbContainer.getConnectionUri()`'s `mariadb://` scheme. `MySqlContainer.getConnectionUri()` builds its URL from `new URL("", "mysql://")` [VERIFIED: testcontainers-node `packages/modules/mysql/src/mysql-container.ts`], so `DATABASE_URL = container.getConnectionUri()` is one correct call. The manual getter assembly is dead weight.
- The Package Legitimacy Audit was re-run against `@testcontainers/mysql`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01 (GitHub Actions, single job):** One workflow `.github/workflows/ci.yml`, one `test` job on `ubuntu-latest`, triggered on `push` and `pull_request`. Steps: `actions/checkout@v4` → `actions/setup-node@v4` (Node `22`, `cache: npm`) → `npm ci` → `npm run test:ci`. A non-zero exit fails the job (blocks merge).
- **D-02 (no `services:` block):** Testcontainers *is* the database. Docker is preinstalled and running on `ubuntu-latest`, so `@testcontainers/mysql` works with no runner setup.
- **D-03 (Testcontainers ephemeral MySQL):** A `test:ci` runner (`src/test/run-with-container.ts`, compiled to `dist/`) starts `new MySqlContainer('mysql:8.0')`, then hands the suite a connection string. New npm script: `"test:ci": "tsc && node dist/src/test/run-with-container.js"`. `npm test` is **untouched**.
- **D-04 (use `getConnectionUri()`) — REVISED 2026-08-03:** `MySqlContainer.getConnectionUri()` already emits a `mysql://` URL; use it directly. *(Originally: hand-build the URL from the getters to avoid a `mariadb://` scheme. That hazard belonged to the MariaDB module and does not exist here — see §Engine Correction.)*
- **D-05 (`prisma migrate deploy` before tests):** The runner runs `prisma migrate deploy` against the fresh container DB (env `DATABASE_URL` set) to apply the 3 committed migrations. `relationMode="prisma"` ⇒ no shadow DB needed. The committed driver-adapter client (`src/generated/prisma`) is pure-JS (no query-engine binary) and runs unmodified on Linux CI.
- **D-06 (runner spawns `node --test`, always tears down):** After migrations, spawn `node --test --test-concurrency=1 "dist/src/test/**/*.test.js"` with the augmented env inherited (`node` expands the glob itself — no shell needed). Container `.stop()` runs in a `finally`; the process exits with the child's status. Teardown-on-failure is the one non-trivial bit of logic.
- **D-07 (bypass the `.env.testing` guard only via an explicit flag):** `src/test/env.ts` currently loads `.env.testing` with `override:true` and throws if it is missing. The change is a single guard: skip the `.env.testing` load **only** when `process.env.USE_TESTCONTAINER_DB` is set. Do **not** key the bypass on "is `DATABASE_URL` set."
- **D-08 (package install is a gated devDependency):** `@testcontainers/mysql` (pulls in `testcontainers`). Per CLAUDE.md the install is behind a blocking human-approval checkpoint — the plan must call it out as `user_setup` / a stop-and-ask, not silently install.

### Claude's Discretion
- Whether `prisma migrate deploy` is invoked as `npx prisma …` vs `node_modules/.bin/prisma`, and confirming its Linux migration-engine binary fetches cleanly under `npm ci`.
- The `mysql:8.0` image tag (pin to a more specific patch tag/digest if flakiness warrants).
- Node version pin (`22` chosen to match `engines`; `24` acceptable) and whether an explicit Docker readiness step is ever needed on GHA (expected: no).

### Deferred Ideas (OUT OF SCOPE)
- **CD / deployment** — no host/registry/Dockerfile exists; add a deploy job only when there is a real target.
- **Node-version matrix** — single Node 22 for now; add a matrix if multi-version support becomes a requirement.
- **Extra caching** (Docker layer cache, Prisma engine cache) — rely on `actions/setup-node` npm cache only until CI time is a problem.
- **Reusing the runner for local `npm test`** — kept separate; local stays on `.env.testing`, container path is CI-only (opt-in via the flag).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CI-01 | Suite runs on push + PR | §GitHub Actions Specifics — workflow trigger config confirmed, Docker available with zero setup |
| CI-02 | Ephemeral DB via Testcontainers, not a GHA service container | §`@testcontainers/mysql` API — confirmed getters, defaults, wait strategy; §Landmines — image tag stability |
| CI-03 | Local `npm test` behavior preserved | §Env Ordering / Test Runner — guard design confirmed safe against stray `DATABASE_URL`; verified `prisma.config.ts` also loads dotenv, doesn't break the guard |
</phase_requirements>

## Summary

The locked design in CONTEXT.md is directionally correct and is confirmed workable end-to-end. `@testcontainers/mysql`'s `MySqlContainer` defaults to database/username/user-password/root-password all `"test"`, with a built-in wait strategy — no explicit `.withDatabase()/.withUsername()/.withUserPassword()` calls are required, though setting them explicitly is more legible. `getPort()` is a convenience wrapper around `getMappedPort(3306)`, but the runner needs none of the getters: `getConnectionUri()` composes the URL via `new URL("", "mysql://")` and returns exactly the `mysql://` string `@prisma/adapter-mariadb` expects [VERIFIED: testcontainers-node `packages/modules/mysql/src/mysql-container.ts`]. One important correction to the CONTEXT.md discretion notes: this repo runs **Prisma 7**, which reads its datasource URL from `prisma.config.ts` (`datasource.url: env('DATABASE_URL')`), not from `prisma/schema.prisma` (which has no `url` field at all) — `migrate deploy` therefore depends on `prisma.config.ts` being present and correct, and that file's own `import 'dotenv/config'` is a second, independent source of env loading that CI must be aware of (verified harmless because `.env`/`.env.*` are gitignored and never exist on the runner). Verified locally: `@prisma/engines` (a dependency of `prisma`) ships a `postinstall` script that downloads a **native, platform-specific `schema-engine` binary** — the query engine is WASM/driver-adapter based in Prisma 7, but the migration/schema engine is still a native binary fetched automatically by `npm ci` for whatever platform it runs on (Linux on `ubuntu-latest`), no manual step needed. `relationMode="prisma"` is unrelated to the shadow-database question — Prisma's own docs state `migrate deploy` **never** needs a shadow database, on any relation mode; `relationMode="prisma"` instead means no DB-level FK constraints get emitted, which is what already lets `fixtures.ts` `TRUNCATE` tables in any order.

**Primary recommendation:** Implement exactly as CONTEXT.md specifies, taking `DATABASE_URL` from `getConnectionUri()`, `npx prisma migrate deploy` invoked as a child process with `cwd` at the repo root so it picks up `prisma.config.ts`, and the `mysql:8.0` image matching the dev engine — flag the floating-tag risk in Open Questions.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Ephemeral DB provisioning | CI Runner (Node process) | Database / Storage (MySQL container) | The runner (`run-with-container.ts`) owns the container lifecycle; the container itself is the storage tier being stood up |
| Schema migration application | CI Runner (Node process) → Database | — | `prisma migrate deploy` is invoked by the runner but executes against the container's DB tier |
| Test execution | CI Runner (Node process) | API / Backend (app under test, via `app.inject()`) | `node --test` runs in-process against the compiled app; no real HTTP/network tier involved |
| Workflow orchestration / triggers | CI/CD (GitHub Actions) | — | Push/PR triggers, job matrix, step sequencing live entirely at the GHA tier, outside the Node runner |
| Env-var safety guard (`.env.testing` bypass) | CI Runner (Node process) | — | `src/test/env.ts` runs in the same process as the test suite; it is not a network-facing tier |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@testcontainers/mysql` | `^12.0.4` [VERIFIED: npm registry 2026-08-03] | Boots an ephemeral MySQL 8.0 container for tests | Official Testcontainers-node module, part of the `testcontainers` monorepo; matches the project's actual engine |
| `testcontainers` | `^12.0.4` [VERIFIED: npm registry] (sole declared dependency of the mysql module) | Core container lifecycle engine (Ryuk reaper, wait strategies, port mapping) | Required transitively; do not pin a mismatched version |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `prisma` (already a devDependency) | `7.8.0` installed, `7.9.1` latest on registry [VERIFIED: npm view] | `migrate deploy` CLI | Already present; no new install needed for this phase |
| `actions/checkout@v4` | pinned major `v4` [CITED: github.com/actions/checkout] | Clones repo in the CI job | Standard first step in every GHA job |
| `actions/setup-node@v4` | pinned major `v4` [CITED: github.com/actions/setup-node] | Installs Node, enables `cache: npm` | Standard Node setup action; `cache: npm` speeds up `npm ci` via built-in `~/.npm` caching keyed on `package-lock.json` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Testcontainers ephemeral DB | GHA `services:` block (`mysql:8.0` service container) | Rejected by D-02 — services containers are declared statically in YAML and always start, even for non-DB jobs; Testcontainers keeps DB lifecycle in code, colocated with the runner logic, and matches the two-container pattern already planned for Phase 8 |
| `@testcontainers/mysql` | `@testcontainers/mariadb` | Rejected — the engine is MySQL 8.0 (see §Engine Correction). A MariaDB container would make CI validate a different engine than dev/prod: divergent default collations, auth-plugin defaults, and JSON storage between the two families mean a green CI would stop being evidence |
| Manual URL construction from getters | `getConnectionUri()` | Rejected — `MySqlContainer.getConnectionUri()` already returns a `mysql://` URL; hand-assembling the same string from five getters is more code for identical output |
| `node --test` global setup (`--test-global-setup`) | Spawn-with-env child-process runner | Rejected in code_context — `--test-global-setup` is experimental and its env-mutation guarantees across process/worker boundaries are not reliable for "set `DATABASE_URL` before any test file's module-level `import`" ordering |

**Installation:**
```bash
npm install --save-dev @testcontainers/mysql
```
This transitively installs `testcontainers` (`^12.0.4`, the module's sole declared dependency) — no separate explicit install needed. **This install is gated behind human approval per CLAUDE.md — do not run automatically.**

**Version verification:** `npm view @testcontainers/mysql version` → `12.0.4`, `npm view testcontainers version` → `12.0.4`. [VERIFIED: npm registry, 2026-08-03]

## Package Legitimacy Audit

*Re-run 2026-08-03 against `@testcontainers/mysql` after the engine correction. The prior audit covered `@testcontainers/mariadb`, which this phase no longer installs.*

| Package | Registry | Version | Downloads | Source Repo | Postinstall | Deprecated | Verdict |
|---------|----------|---------|-----------|-------------|-------------|------------|---------|
| `@testcontainers/mysql` | npm | `12.0.4` | ~310,862/wk | github.com/testcontainers/testcontainers-node | none | no | OK |
| `testcontainers` | npm | `12.0.4` | ~5,572,511/wk | github.com/testcontainers/testcontainers-node | none | no | OK |

Verified directly this session [VERIFIED: 2026-08-03]:
- `npm view @testcontainers/mysql version` → `12.0.4`
- `npm view @testcontainers/mysql repository.url` → `git+https://github.com/testcontainers/testcontainers-node.git`
- `npm view @testcontainers/mysql scripts.postinstall` → empty (no postinstall script)
- `npm view @testcontainers/mysql deprecated` → empty (not deprecated)
- `npm view @testcontainers/mysql dependencies` → `{ testcontainers: '^12.0.4' }` (single transitive dep, same org)
- Weekly downloads via `api.npmjs.org/downloads/point/last-week` → 310,862 (period 2026-07-27 → 2026-08-02)

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
 GitHub push / PR
        │
        ▼
 ┌─────────────────────────────┐
 │ GHA job: ubuntu-latest        │
 │  actions/checkout@v4          │
 │  actions/setup-node@v4        │
 │  npm ci                       │──▶ installs deps; @prisma/engines
 │  npm run test:ci              │    postinstall fetches Linux schema-engine
 └───────────┬────────────────────┘
             ▼
   test:ci → tsc && node dist/src/test/run-with-container.js
             │
             ▼
 ┌─────────────────────────────────────────┐
 │ run-with-container.js (Node process)      │
 │                                            │
 │  1. new MySqlContainer('mysql:8.0')       │
 │     .start()  ───────────────▶ Docker pulls/starts container
 │                                            │        │
 │  2. DATABASE_URL = getConnectionUri()     │◀───────┘ (mysql://user:pass@host:port/db)
 │                                            │
 │  3. spawn('npx', ['prisma','migrate',     │
 │     'deploy'], { env: {...process.env,    │
 │     DATABASE_URL, USE_TESTCONTAINER_DB }})│──▶ prisma.config.ts reads DATABASE_URL
 │                                            │    (schema-engine binary applies 3
 │                                            │    committed migrations)
 │  4. spawn('node', ['--test',              │
 │     '--test-concurrency=1',               │
 │     'dist/src/test/**/*.test.js'],        │──▶ src/test/env.ts sees
 │     { env: {...} })                       │    USE_TESTCONTAINER_DB set →
 │                                            │    skips .env.testing load →
 │                                            │    src/lib/env.ts reads the
 │                                            │    inherited DATABASE_URL →
 │                                            │    src/lib/prisma.ts connects
 │                                            │    via @prisma/adapter-mariadb
 │  5. finally: container.stop()             │
 │     process.exit(child.exitCode)          │
 └────────────────────────────────────────────┘
```

### Recommended Project Structure
```
.github/
└── workflows/
    └── ci.yml                    # GHA workflow (D-01)
src/
└── test/
    ├── env.ts                    # +1-line guard (D-07)
    └── run-with-container.ts     # new: container lifecycle + spawn (D-03, D-06)
```

### Pattern 1: Match the container image to the production engine, then take its connection URI
**What:** Pick the Testcontainers module for the engine the app actually runs on, and read `DATABASE_URL` from `getConnectionUri()`.
**When to use:** Always. A CI database that is not the production engine turns a green suite into weak evidence.
**Example:**
```typescript
// Source: github.com/testcontainers/testcontainers-node, packages/modules/mysql/src/mysql-container.ts [VERIFIED]
import { MySqlContainer } from '@testcontainers/mysql'

const container = await new MySqlContainer('mysql:8.0').start()
const databaseUrl = container.getConnectionUri()
```
`getConnectionUri()` is implemented as `new URL("", "mysql://")` with hostname/port/pathname/username/password assigned from the container — the `mysql://` scheme is structural, not incidental, so `@prisma/adapter-mariadb` receives exactly what it expects.

Defaults if `.withDatabase()/.withUsername()/.withUserPassword()` are never called: database `"test"`, username `"test"`, user password `"test"`, root password `"test"` [VERIFIED: module source]. `getPort()` wraps `getMappedPort(3306)`; the runner needs neither.

### Pattern 2: Spawn-with-inherited-env runner (never global test setup)
**What:** A plain Node script that mutates `process.env` in its own process, then spawns a **child** process for `prisma migrate deploy` and another child process for `node --test`, passing `{ ...process.env, DATABASE_URL, USE_TESTCONTAINER_DB: '1', JWT_SECRET: 'ci-test-secret' }` as that child's `env`.
**When to use:** Any time environment variables must be guaranteed-present before another process's module-graph evaluates (here: before `src/lib/env.ts` and `src/lib/prisma.ts` run their import-time logic).
**Example:**
```typescript
// Source: Node.js child_process docs (well-established, training-knowledge-grade API)
import { spawn } from 'node:child_process'

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env, shell: false })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', reject)
  })
}
```
A child process spawned via `child_process.spawn` receives its own copy of whatever `env` object is passed (defaults to `process.env` if omitted) [ASSUMED: standard, unambiguous Node.js API behavior — not independently re-verified this session, but not in dispute]. Spreading `process.env` plus overrides guarantees the child sees the mutated `DATABASE_URL`/`USE_TESTCONTAINER_DB` without touching the parent's real `process.env` (though mutating the parent's `process.env` directly, before either spawn call, is equally valid and simpler — either approach satisfies D-06/D-07).

### Anti-Patterns to Avoid
- **Reading the engine off the dependency name:** `@prisma/adapter-mariadb` / `PrismaMariaDb` do **not** mean the database is MariaDB — it is Prisma's one adapter for the whole MySQL/MariaDB family, and this project runs MySQL 8.0. Reaching for `@testcontainers/mariadb` on that inference is exactly the mistake §Engine Correction records.
- **Hand-assembling `DATABASE_URL` from the getters:** unnecessary here — `MySqlContainer.getConnectionUri()` returns the same `mysql://` string in one call.
- **Gating the `.env.testing` bypass on `DATABASE_URL` presence:** explicitly rejected by D-07 — a stray `DATABASE_URL` in a developer's shell must still be overridden locally. Gate only on `USE_TESTCONTAINER_DB`.
- **Running `prisma migrate deploy` from a different `cwd`:** Prisma 7 resolves `prisma.config.ts` relative to the current working directory (or via `--config`); the runner must execute the CLI with `cwd` at the repo root (the default when GHA checks out and `npm run test:ci` runs from root) so `prisma.config.ts`'s relative `schema: './prisma/schema.prisma'` path resolves correctly.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| Container startup readiness detection | A custom TCP-poll/retry loop against port 3306 | `MySqlContainer.start()`'s built-in wait strategy [CITED: testcontainers-node source] | The module already waits for MySQL's readiness signal before `.start()` resolves; a custom poll would race the exact same signal less reliably |
| Building the connection string | Template-literal assembly from five getters | `container.getConnectionUri()` | Returns the `mysql://` URL directly; identical output, one call |
| Orphaned container cleanup if the CI job is killed mid-run | Manual `docker rm -f` cleanup scripts | Testcontainers' built-in Ryuk resource reaper (on by default) | Ryuk runs as a sidecar container and force-removes anything tagged by the Testcontainers session if the parent process dies uncleanly — exactly the GHA-kill scenario a custom `finally` block can't cover |
| Migration application against a fresh DB | Hand-written SQL runner reading `prisma/migrations/*/migration.sql` in file order | `prisma migrate deploy` | It already tracks `_prisma_migrations`, applies files in the correct order, and is idempotent/checksum-verified — re-implementing this is unnecessary risk for zero benefit |

**Key insight:** Every piece of this phase's "custom" logic is intentionally thin (URL string-building, env-flag guard, spawn-and-teardown sequencing) — the moment a task starts polling ports, retrying connections, or parsing migration SQL by hand, that's a signal the plan has drifted from what Testcontainers/Prisma already provide.

## Common Pitfalls

### Pitfall 1: `prisma migrate deploy` silently uses the wrong `DATABASE_URL`
**What goes wrong:** `prisma.config.ts` itself runs `import 'dotenv/config'` at the top. If a `.env` file ever exists on the CI runner (it won't by default — `.env`/`.env.*` are gitignored) with a stale `DATABASE_URL`, dotenv's default `override: false` means the pre-set (spawned-child) `DATABASE_URL` still wins — but if the runner ever *doesn't* set `DATABASE_URL` before spawning `prisma migrate deploy`, and a `.env` happens to exist (e.g. a future contributor commits one, or a local dry-run of `test:ci` picks up a developer's real `.env`), migrations could apply to the wrong database.
**Why it happens:** Two independent env-loading paths exist in this repo now: `src/test/env.ts` (loads `.env.testing`, guarded by `USE_TESTCONTAINER_DB`) and `prisma.config.ts` (unconditionally loads `.env` via `dotenv/config`, with no override).
**How to avoid:** Always set `DATABASE_URL` in `process.env` (or the child's `env` object) **before** invoking `prisma migrate deploy`, never rely on it being read from a file. Verified: this repo's `.env`/`.env.*` are gitignored, so a clean CI checkout never has one — this pitfall applies only to local `test:ci` dry-runs on a machine with a stray `.env`.
**Warning signs:** `prisma migrate deploy` reports "Datasource ... " pointing at an unexpected host/db name in its own log output (Prisma prints the datasource it resolved before applying).

### Pitfall 2: Floating `mysql:8.0` tag drifts under CI
**What goes wrong:** `mysql:8.0` is a floating minor-line tag that moves forward as new 8.0.x patches release. A future patch could introduce a startup-log-format change that breaks the wait strategy, or a behavior change unrelated to this project's migrations.
**Why it happens:** Testcontainers pulls whatever `mysql:8.0` currently resolves to at image-pull time; GHA runners have no persistent image cache across unrelated jobs unless explicitly configured.
**How to avoid:** Acceptable as specified for this phase (D-03 names `mysql:8.0`, matching the dev engine line); if CI ever becomes flaky in a way traceable to an image update, pin to a specific patch tag or a digest.
**Warning signs:** A previously-green CI run starts failing with no code changes and no dependency-lockfile changes — check whether the pulled image digest changed.

### Pitfall 5: CI engine drifting from the dev/prod engine
**What goes wrong:** The container image is chosen from the adapter's package name (`@prisma/adapter-mariadb`) rather than from the actual server, and CI validates MariaDB while dev/prod run MySQL 8.0. Green CI then stops being evidence: the two families diverged after MySQL 5.7 in default collations (MySQL 8's `utf8mb4_0900_ai_ci` does not exist in MariaDB at all), default auth plugin (`caching_sha2_password`), JSON storage, and `RETURNING`/sequences support.
**Why it happens:** `@prisma/adapter-mariadb` is Prisma's single adapter for the whole MySQL/MariaDB family; its name carries no information about the server. This exact inference produced the original (wrong) version of this research doc.
**How to avoid:** Take the engine from the running server (`SELECT VERSION()`), never from a dependency name. This project: MySQL 8.0 → `@testcontainers/mysql` + `mysql:8.0`.
**Warning signs:** A migration or query that passes in CI and fails in dev (or vice versa) with a collation, charset, or auth-plugin error.

### Pitfall 3: Ryuk needs outbound Docker socket access — usually fine, but flag if the runner is ever locked down
**What goes wrong:** If `ubuntu-latest`'s Docker daemon socket were ever restricted (it isn't, by default), Testcontainers' Ryuk reaper container would fail to start and Testcontainers throws before the DB container even starts.
**Why it happens:** Ryuk itself needs to mount `/var/run/docker.sock` to track and clean up sibling containers.
**How to avoid:** No action needed on `ubuntu-latest` — Docker is preinstalled and the socket is available with no special runner configuration [CITED: github.com/actions/runner-images Ubuntu 24.04 readme confirms Docker 28.0.4 client+server present]. Only relevant if this workflow is ever moved to a self-hosted or hardened runner.
**Warning signs:** Error message referencing `ryuk` or `Could not find a valid Docker environment` in the CI log.

### Pitfall 4: Schema-engine binary fetch failing/slow on a cold `npm ci`
**What goes wrong:** `@prisma/engines`'s `postinstall` script downloads a native `schema-engine` binary for the current platform. On a network-restricted CI runner this could fail; on a normal `ubuntu-latest` runner it succeeds but adds to `npm ci` time (partially offset by `actions/setup-node`'s `cache: npm`, which caches downloaded npm packages, not necessarily the *engine binary* itself — the postinstall step still re-downloads the binary on every job unless a separate cache is layered on, which is explicitly out of scope per CONTEXT.md's "extra caching" deferral).
**Why it happens:** [VERIFIED: local `node_modules/@prisma/engines/package.json` inspection] — `"postinstall": "node scripts/postinstall.js"` is present, and this repo's own `node_modules/@prisma/engines/schema-engine-windows.exe` confirms the postinstall step fetches a platform-specific binary (Windows here, on this dev machine); it will fetch a Linux binary on `ubuntu-latest`.
**How to avoid:** No action needed — `ubuntu-latest` has outbound internet access by default, and this is the same binary-fetch mechanism every Prisma project on GHA already relies on. Just be aware the first CI run may be a few seconds slower for this fetch; this is not itself a flakiness risk beyond the network being briefly unavailable (rare, transient).
**Warning signs:** `Error: Could not find schema-engine binary` or a `migrate deploy` step that hangs on a download.

## Code Examples

### `src/test/run-with-container.ts` (full recommended shape)
```typescript
// Source: pattern synthesized from testcontainers-node + Node child_process docs;
// D-03/D-04/D-05/D-06 from CONTEXT.md
import { spawn } from 'node:child_process'
import { MySqlContainer } from '@testcontainers/mysql'

async function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env, shell: false })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', reject)
  })
}

async function main(): Promise<void> {
  const container = await new MySqlContainer('mysql:8.0').start()

  const testEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: container.getConnectionUri(),
    JWT_SECRET: 'ci-test-secret',
    USE_TESTCONTAINER_DB: '1'
  }

  let exitCode = 1
  try {
    const migrateCode = await run('npx', ['prisma', 'migrate', 'deploy'], testEnv)
    if (migrateCode !== 0) {
      exitCode = migrateCode
      return
    }

    exitCode = await run(
      'node',
      ['--test', '--test-concurrency=1', 'dist/src/test/**/*.test.js'],
      testEnv
    )
  } finally {
    await container.stop()
  }

  process.exitCode = exitCode
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
```

### `src/test/env.ts` guard (D-07)
```typescript
// Source: pattern; single-line addition to existing file per D-07
import path from 'node:path'
import dotenv from 'dotenv'

if (!process.env.USE_TESTCONTAINER_DB) {
  const result = dotenv.config({
    path: path.resolve(__dirname, '../../../.env.testing'),
    override: true
  })

  if (result.error) {
    throw new Error(
      'Missing .env.testing at the repo root. Tests refuse to run without it — ' +
        'they truncate every table, so they must never point at the dev database. ' +
        'Create .env.testing with DATABASE_URL (a separate database) and JWT_SECRET, ' +
        'then apply migrations to it.'
    )
  }
}
```

### `package.json` script addition (D-03)
```json
{
  "scripts": {
    "test:ci": "tsc && node dist/src/test/run-with-container.js"
  }
}
```

### `.github/workflows/ci.yml`
```yaml
# Source: pattern per D-01, actions/checkout@v4 + actions/setup-node@v4 are the
# GitHub-published, version-pinned standard actions
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run test:ci
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Rust-native Prisma query engine binary (per-platform) | TS + WASM query engine, driver adapters mandatory | Prisma 7 (this repo is already on 7.8.0) | The *query* engine no longer needs a platform binary — this repo's `@prisma/adapter-mariadb` client is already Linux-portable as CONTEXT.md states. The *schema/migration* engine (`schema-engine`) is a separate concern and still ships as a native binary fetched by `@prisma/engines`'s postinstall — this distinction is easy to conflate and worth calling out to the planner. |
| `datasource db { url = env("DATABASE_URL") }` in `schema.prisma` | `prisma.config.ts` with `datasource: { url: env('DATABASE_URL') } }` | Prisma 7 | This repo has already migrated to this pattern (`prisma.config.ts` exists, `schema.prisma`'s `datasource` block has no `url`). `migrate deploy` reads `DATABASE_URL` via this config file, not the schema — the runner must still just set `process.env.DATABASE_URL` before spawning, which works transparently either way. |

**Deprecated/outdated:**
- `datasource.url` directly in `schema.prisma`: removed in Prisma 7 in favor of `prisma.config.ts`; not relevant to write here since this repo already migrated.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | `child_process.spawn`'s `env` option fully replaces (not merges with) the child's environment when provided explicitly, and `stdio: 'inherit'` is sufficient for CI log visibility | Code Examples / Pattern 2 | Low — this is extremely well-established Node.js API behavior; if wrong, the fix is a one-line change to the spawn call and would surface immediately as a broken/missing env var in the first CI run |
| A2 | `npx prisma migrate deploy` (vs. `node_modules/.bin/prisma migrate deploy`) is the correct invocation and resolves the locally-installed `prisma` binary without attempting a network fetch | Findings §2 / Code Examples | Low — `npx` resolves local `node_modules/.bin` first before considering a registry fetch; worst case is a slightly slower first invocation, not a wrong-version execution |
| A3 | GitHub Actions treats `push` and `pull_request` triggers as producing two separate job runs for a PR from a branch within the same repo (not deduplicated automatically) — noted as acceptable per D-01, no `concurrency:` block requested | Findings §3 | Low — CONTEXT.md did not ask for deduplication; if double-runs become a cost/time concern later, a `concurrency:` group can be added without changing the runner or migration logic |

## Open Questions

1. **Should `mysql:8.0` be pinned more tightly (e.g. a patch tag or digest) before the first CI run?**
   - What we know: `mysql:8.0` is the LTS line matching the dev engine; CONTEXT.md names it in D-03 and flags the tag choice as within Claude's discretion to revisit "if flakiness warrants."
   - What's unclear: Whether the team wants reproducibility (pinned tag) over always-latest-patch (floating tag) from day one, vs. waiting for evidence of flakiness.
   - Recommendation: Ship with `mysql:8.0` as locked by D-03; the planner should not pre-emptively change this without discussion — it's explicitly deferred to "if flakiness warrants," which hasn't been observed yet.
   - Related: if the dev server's exact patch version matters, take it from `SELECT VERSION()` rather than assuming.

2. **Does the runner need an explicit `TESTCONTAINERS_RYUK_DISABLED` setting for GHA?**
   - What we know: Ryuk is enabled by default and works out-of-the-box on Docker-enabled GHA runners; disabling it is only recommended when the CI environment already has its own guaranteed cleanup mechanism and disallows privileged containers — neither is true here.
   - What's unclear: Nothing significant; this is a low-risk default-off decision.
   - Recommendation: Leave Ryuk enabled (default) — do not set `TESTCONTAINERS_RYUK_DISABLED`. No workflow env var needed.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|--------------|-----------|---------|----------|
| Docker Engine (GHA runner) | Testcontainers container lifecycle | ✓ (on `ubuntu-latest`, by GitHub's own runner-image spec) | 28.0.4 client+server [CITED: github.com/actions/runner-images] | — |
| Node.js | Build + test runner | ✓ | `22` pinned in workflow (matches `engines.node >=22`); local dev machine has `24.18.0` | Node `24` acceptable per CONTEXT.md discretion note |
| `@testcontainers/mysql` / `testcontainers` | Ephemeral MySQL 8.0 provisioning | ✗ (not yet installed — gated devDependency, D-08) | `12.0.4` on registry | Blocking — see Open Questions / package-install gate below |
| `prisma` CLI + `@prisma/engines` schema-engine binary | `migrate deploy` | ✓ (already a devDependency; postinstall fetches platform binary automatically) | `7.8.0` installed / `7.9.1` latest | — |

**Missing dependencies with no fallback:**
- `@testcontainers/mysql` (+ transitive `testcontainers`) — must be installed before `run-with-container.ts` can compile or run; this is the human-approval-gated install per D-08/CLAUDE.md.

**Missing dependencies with fallback:**
- None beyond the above.

## Validation Architecture

Per CONTEXT.md's "Specific Ideas": **the runner is the phase's own runnable check.** There is no separate unit-test file for `run-with-container.ts` — its correctness is proven by actually running it.

### What "passing" looks like
A green `npm run test:ci` run means, in order: (1) `tsc` compiles with zero errors, (2) `MySqlContainer('mysql:8.0').start()` resolves (Docker pulled the image, container booted, wait strategy satisfied), (3) the `mysql://` URL from `getConnectionUri()` is accepted by `npx prisma migrate deploy`, which applies all 3 committed migrations against the fresh, empty container DB with exit code 0, (4) the spawned `node --test --test-concurrency=1 "dist/src/test/**/*.test.js"` run completes with exit code 0 (all existing Phase 1/2 auth + entity-CRUD tests pass against the container DB, unmodified), (5) `container.stop()` runs in `finally` regardless of outcome, and (6) the runner's own `process.exitCode` matches the test run's exit code, which GitHub Actions then reads to mark the job green.

### Smallest observable failure per link in the chain
| Link | Smallest observable failure | Where it surfaces |
|------|------------------------------|---------------------|
| Container boot | `MySqlContainer.start()` rejects (Docker unavailable, image pull failure, wait-strategy timeout) | Uncaught rejection in `main()`, non-zero `process.exitCode`, error printed via the `.catch()` handler |
| URL construction | `prisma migrate deploy` reports a connection error (wrong scheme, wrong port/host) | Migration step's exit code ≠ 0; runner returns early without running tests |
| Migration apply | `migrate deploy` reports a specific migration failing (SQL error, checksum mismatch) | Non-zero exit from the migrate child process; test suite is never spawned |
| Test suite | Any individual `node --test` assertion fails, or the whole run has a non-zero exit | Standard `node --test` TAP-ish output in the CI log, inherited via `stdio: 'inherit'` |
| Teardown | `container.stop()` throws (rare) | Would only surface as an unhandled rejection after the exit code is already set — acceptable, since the job's pass/fail signal (exit code from the test run) is already correct at that point |
| Local safety guard (D-07) | Running `npm test` locally (no `USE_TESTCONTAINER_DB`) with a stray `DATABASE_URL` in the shell still loads `.env.testing` with `override:true`, overwriting the stray value | Verified by the existing `.env.testing`-missing throw still firing when the file is absent, unchanged by this phase |

### Sampling Rate
- **Per task commit (this phase):** `npm run build` (compile-only checkpoint — no container needed) after scaffolding `run-with-container.ts`.
- **Per wave / before merge:** `npm run test:ci` locally (developer must have Docker running) — full container boot → migrate → test → teardown cycle.
- **Phase gate:** The GHA workflow itself running green on the phase's own PR is the acceptance signal — this phase's "test" *is* the CI job passing on its own diff.

### Wave 0 Gaps
None — this phase adds no application-level test files; it wraps the existing Phase 1/2 suite. The only new "test" surface is the runner script itself, and per CONTEXT.md it is validated by being run, not by a dedicated test file.

## Security Domain

CI-01/02/03 introduce no new application attack surface (no new routes, no new auth logic, no new user input handling) — this phase's asset is CI infrastructure. `security_enforcement` is on for the project generally, but ASVS categories V2–V6 do not meaningfully apply to a CI workflow file and a test-only DB provisioning script. The one relevant control:

| Concern | Applies | Standard Control |
|---------|---------|-------------------|
| Secrets in CI | Marginal | `JWT_SECRET: 'ci-test-secret'` is a hardcoded, non-production placeholder used only inside an ephemeral, network-isolated CI container DB — not a real secret, no GitHub Actions `secrets:` context needed for this phase. `DATABASE_URL` is generated at runtime from Testcontainers-assigned random credentials (`test`/`test` by default), scoped to a container that is destroyed at job end — not a credential-leak risk. |
| Supply-chain (new devDependency) | Yes | Package Legitimacy Audit above — both `@testcontainers/mysql` and `testcontainers` verified OK, official Testcontainers org, no suspicious postinstall scripts, high download counts, verified GitHub source repo. |

No STRIDE-relevant threat patterns apply to this phase's scope (no network-facing code changes).

## Sources

### Primary (HIGH confidence)
- Local filesystem inspection: `node_modules/@prisma/engines/package.json` (`postinstall` script), `node_modules/@prisma/engines/schema-engine-windows.exe` (confirms native binary fetch behavior) — [VERIFIED]
- `npm view @testcontainers/mysql version|repository.url|scripts.postinstall|deprecated|dependencies` — [VERIFIED: npm registry, 2026-08-03]
- `api.npmjs.org/downloads/point/last-week/@testcontainers/mysql` → 310,862 — [VERIFIED: 2026-08-03]
- `gsd-tools query package-legitimacy check --ecosystem npm @testcontainers/mariadb testcontainers` — [VERIFIED, but for the superseded MariaDB module; the mysql module was re-verified directly via `npm view`]
- This repo: `prisma.config.ts`, `prisma/schema.prisma`, `src/test/env.ts`, `src/lib/env.ts`, `src/lib/prisma.ts`, `package.json`, `.gitignore` — [VERIFIED: direct file reads]

### Secondary (MEDIUM confidence)
- https://github.com/testcontainers/testcontainers-node — `packages/modules/mysql/src/mysql-container.ts` fetched via raw.githubusercontent.com: exact defaults (`test`/`test`/`test`/`test`), `getPort()` = `getMappedPort(3306)`, and `getConnectionUri()` composed from `new URL("", "mysql://")` [VERIFIED: 2026-08-03]
- https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database — shadow DB never required for `migrate deploy` [CITED]
- https://www.prisma.io/docs/orm/reference/prisma-config-reference — driver adapters work automatically with migrations in Prisma 7 config [CITED]
- https://github.com/actions/runner-images (Ubuntu 24.04 readme) — Docker 28.0.4 preinstalled on `ubuntu-latest` [CITED]
- Live dev database probed directly (2026-08-03): `SELECT VERSION()` → `8.0.46`, `@@version_comment` → `MySQL Community Server - GPL`, `@@collation_server` → `utf8mb4_0900_ai_ci` — supersedes the earlier inference from the adapter's package name [VERIFIED]

### Tertiary (LOW confidence)
- General WebSearch results on Prisma 7 architecture (WASM query engine, Rust removal) — consistent across multiple independent sources (digitalapplied.com, tomodahinata.com, Medium articles) but not fetched from prisma.io's primary release notes directly — [CITED via cross-checked WebSearch, treat schema-engine-is-still-native claim as MEDIUM given it was also independently confirmed via local filesystem inspection]
- Node.js `child_process.spawn` env-inheritance behavior — standard, well-documented API, not independently re-fetched this session — [ASSUMED, low risk]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — both packages verified via npm registry + legitimacy gate, versions confirmed current
- Architecture: HIGH — runner design directly validated against actual repo files (`prisma.config.ts`, `env.ts`, `prisma.ts`) plus official Testcontainers-node source
- Pitfalls: HIGH — the Prisma 7 config/engine-binary nuance was discovered and verified locally, not assumed from training data

**Research date:** 2026-08-02
**Valid until:** 30 days (stable domain — GHA/Testcontainers/Prisma migrate-deploy mechanics change slowly; re-verify package versions if planning is delayed past ~30 days)
