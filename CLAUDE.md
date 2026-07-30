# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Related docs:**
> - [`README.md`](README.md) — product vision & mission (the "why")
> - [`PLAN.md`](PLAN.md) — full development rules, target architecture & roadmap (the "where we're going")
>
> This file documents **what is actually implemented today**. Where it conflicts with the vision in README/PLAN, this file is authoritative for the current state of the code.

## Current State

⚠️ The product vision (smart-home device/telemetry platform) is **not yet built**. What exists today is an **authentication API**: user registration, login, JWT access tokens, and rotating refresh tokens, backed by a single relational database. There is no device, room, house, telemetry, or time-series functionality yet. See [`PLAN.md`](PLAN.md) for the roadmap.

## Working Style

**Never go straight to implementation.**

- **Bug / unexpected behavior**: Explain why it happened, propose 2–3 solutions each with trade-offs, then wait for approval before writing any code.
- **New feature**: Propose an architecture plan (data model, affected files, API shape) and wait for approval before writing any code.

### Stay in scope (applies to subagents/executors too)

Never install an npm package, change `prisma/schema.prisma`, or add infrastructure (test harness, config files, env files) that is **outside the plan's declared `files_modified`** without stopping to ask. Package installs are behind a blocking-human review checkpoint — that gate applies to subagents as well; do not work around it.

### Branch per phase

Each phase gets its own branch off `main`, `feat/<NN>-<phase-slug>`, created **before** the first planning commit and covering both planning and implementation. Merge to `main` via PR when the phase is done. See rule 1.7 in [`PLAN.md`](PLAN.md).

### Per-phase: structure-first, then test-first, then implement

Every phase is built in this order (maps to atomic commits):

1. **Scaffold** — create the phase's files with real signatures, types, and properties. Bodies are `// TODO:` only — no logic. *(commit)*
2. **Tests** — write the phase's unit + integration tests (`build(t)` / `app.inject()`) covering its requirements. They compile and run **red**. *(commit)*
3. **Implement** — fill in logic task-by-task until the tests go **green**. *(commits)*

Do not write implementation logic before the structure and its tests exist.

### Code style

- **Explicit over magic.** Prefer typed, enumerated declarations over reflection or catch-all generalization — e.g. a typed `Record<Union, …>` config over runtime field-detection, and one handler per case over a single `$allOperations`-style catch-all. Let the type system enforce completeness.
- **Readable conditions & names.** Meaningful names (never `a`, `tmp`); no double-negative conditions. Don't introduce a single-use variable just to name a boolean — inline it into an early-return guard clause.
- **Separate concerns.** Extract generic, reusable helpers (string utils, etc.) into their own module instead of inlining them in a domain file.
- **Stdlib over hand-rolled.** Reach for built-ins before writing a helper — e.g. `Object.groupBy` / `Object.entries` over a manual grouping loop. Avoid reflection dispatch (`(x as Record<string, any>)[name]`) when an enumerated or explicit form reads clearly.
- **Mind the query count.** In the service layer, keep DB round-trips at the floor for the task. When adding DB access, know the resulting number of queries and justify anything beyond the minimum (an extra `findMany` round-trip must buy more than it costs).

## Commands

```bash
npm run dev          # Start dev server with hot-reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm test             # Build then run Node test runner against dist/src/test/**/*.test.js
npm run prisma:generate   # Regenerate Prisma client after schema changes
npm run prisma:migrate    # Apply migrations (dev)
npm run prisma:studio     # Open Prisma Studio GUI
```

To run a single test file:
```bash
npm run build && node --test dist/src/test/routes/root.test.js
```

Required environment variables (`.env`): `DATABASE_URL`, `JWT_SECRET`, optionally `PORT`, `HOST`, `LOG_LEVEL`.

## Architecture

The app is a **Fastify 5 REST API** backed by **MariaDB via Prisma** (driver-adapter pattern — `@prisma/adapter-mariadb`, not the default TCP connector).

### Boot flow

`src/server.ts` → creates a bare Fastify instance → registers `app.ts` as a plugin → `app.ts` uses `@fastify/autoload` to load all files from `src/plugins/` then `src/routes/` in alphabetical order.

### Plugin layer (`src/plugins/`)

Plugins are registered before routes and extend the Fastify instance:

| File | What it adds |
|---|---|
| `auth.ts` | Registers `@fastify/jwt`, decorates `fastify` with `authenticate`, `generateTokens`, `verifyRefreshToken`, `revokeRefreshToken` |
| `error-handler.ts` | Global `setErrorHandler` — normalises all errors to `{ error, message, statusCode }` |
| `sensible.ts` | `@fastify/sensible` — adds `fastify.httpErrors.*` helpers |

### Auth token strategy

- **Access token**: short-lived JWT (15 min), signed with `JWT_SECRET`, returned in the response body.
- **Refresh token**: opaque 40-byte random hex, stored as a SHA-256 hash in the `refresh_tokens` DB table, set as an `httpOnly` cookie scoped to `/auth`. Tokens are single-use (revoked on rotation). Expiry: 7 days.
- Route `POST /auth/refresh` rotates: it revokes the old token and issues a new pair.

### Service layer (`src/services/`)

Pure functions that talk to the database — no Fastify types. Routes call services; services call `prisma`.

| File | Responsibility |
|---|---|
| `auth.ts` | `loginUser` — fetches user, verifies bcrypt hash |
| `user.ts` | `createUser`, `getUserById` |
| `refresh-token.ts` | `generateRefreshToken`, `verifyRefreshToken`, `revokeRefreshToken` |

### Database (`prisma/schema.prisma`)

Two models: `User` and `RefreshToken` (joined by `userId`). Prisma client is generated to `src/generated/prisma/` — never edit files there manually.

`src/lib/prisma.ts` exports the singleton `prisma` client; import it from there everywhere.

**Migrations — amend, don't stack, until pushed.** While a migration has **not** been pushed to `master`/`main`, never create a *new* migration to edit/update a column, table name, etc. — amend the existing still-local migration instead (hand-edit + re-run `prisma migrate dev`). A single migration may span multiple tables/changes; only split into a new migration once the prior one is pushed.

### Routes (`src/routes/`)

AutoLoad maps directory structure to URL paths. Route files export a `FastifyPluginAsync`. Request/response schemas are defined in a co-located `schemas.ts` and passed into route options — Fastify uses them for validation and serialisation.

**Validation standard: TypeBox.** New schemas must be written with TypeBox, deriving handler types via `Static<typeof schema>` rather than hand-writing parallel `type` aliases. The current auth schemas predate this and still use raw `as const` JSON Schema with separate body types — migrate them when touched. See rule 1.5 in [`PLAN.md`](PLAN.md).

### Tests (`src/test/`)

Uses Node's built-in test runner (`node:test` + `node:assert`). `src/test/helper.ts` exports a `build(t)` helper that spins up a full Fastify instance (including all plugins and routes) and registers a teardown via `t.after`. Tests use `app.inject()` — no real HTTP.

Tests run against compiled JS (`dist/`), so always `npm run build` before running them.
