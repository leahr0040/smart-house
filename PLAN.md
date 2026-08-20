# PLAN.md — Development Plan, Rules & Roadmap

This document is the canonical source for **how we work** on SmartHome Backend Core and **where the architecture is headed**. For product vision see [`README.md`](README.md); for what is implemented today see [`CLAUDE.md`](CLAUDE.md).

---

## 1. Development Rules

### 1.1 Never go straight to implementation
This is the top rule and applies to every change.

- **Bug / unexpected behavior** → Explain *why it happened* (root cause), propose **2–3 solutions** each with explicit advantages and disadvantages, and implement **only after approval**.
- **New feature** → Propose an **architecture plan** (data model, affected files, API shape, trade-offs) and continue **only after approval**.

### 1.2 Type Safety
- Strict TypeScript across the whole codebase — no implicit `any`, no unchecked indexing, no silent nulls.
- Every request body, response shape, DB model, and service contract is explicitly typed.
- Contract violations should fail at build time, not in production.

### 1.3 Modularity — Operational vs. Analytical Separation
- Keep **operational business logic** (device state, control) decoupled from the **analytical/telemetry pipeline**.
- A failure or backpressure in the logging layer must **never** cascade into the operational control plane.
- The two concerns evolve and scale independently.

### 1.4 Layering conventions
- **Routes** handle HTTP concerns only (validation via schema, status codes, cookies). They call services.
- **Services** are pure functions that own business logic and database access. They take and return plain types — no framework types.
- **Plugins** extend the framework instance (auth, error handling, helpers) and are registered before routes.
- Database access goes through the single shared client; never instantiate clients ad hoc.

### 1.5 Validation — TypeBox
- Define **all** request and response schemas with **TypeBox**.
- TypeBox is the single source of truth: the same schema validates at runtime (the framework consumes it as JSON Schema) **and** infers the static TypeScript type via `Static<typeof schema>`. Request/response types must be *derived* from the schema — never hand-write a separate `type` alongside it.
- Co-locate schemas with their route (e.g. `routes/<area>/schemas.ts`).
- **Migration note:** the existing auth schemas use hand-written `as const` JSON Schema plus separate body types ([`src/routes/auth/schemas.ts`](src/routes/auth/schemas.ts), [`src/routes/auth/index.ts`](src/routes/auth/index.ts)). These predate this rule and should be migrated to TypeBox.

### 1.6 Testing
- Every route or service change ships with tests — no exceptions.
- Use Node's built-in runner (`node:test` + `node:assert`), the `build(t)` helper in [`src/test/helper.ts`](src/test/helper.ts) to boot a full app instance (all plugins + routes), and `app.inject()` for HTTP-level assertions (no real network).
- Tests execute against compiled output, so `npm test` builds first; see the **Tests** section in [`CLAUDE.md`](CLAUDE.md) for mechanics and single-test commands.
- A bug fix starts with a failing test that reproduces it (once the fix approach is approved per rule 1.1).

### 1.7 Branch per phase
- Every phase — its planning docs **and** its implementation — happens on its own branch off `main`, named `feat/<NN>-<phase-slug>` (e.g. `feat/02-entity-crud-multi-tenancy`).
- Create the branch **before** the first planning commit of the phase; never commit phase work directly to `main`.
- The branch merges to `main` via PR once the phase is complete.

---

## 2. Target Architecture

The end-state employs a **hybrid persistence strategy** — the right store for each kind of data.

### 2.1 Relational Layer — Operational Consistency
Strict relational integrity for: Houses, Rooms, Devices, Users, and their **current live states**. Transactions and foreign keys keep the operational picture always-consistent.

### 2.2 Document / Time-Series Layer — Analytical Velocity
Append-only, high-write-throughput capture of every sensor reading, state change, and system event. Prioritizes ingestion speed over transactional guarantees; serves as raw material for analytics and AI training.

### 2.3 AI Readiness
Historical-log schema designed up front for ML/AI consumption — structured for straightforward export into LLM context windows or training datasets (behavioral prediction, anomaly detection, automated scheduling).

---

## 3. Roadmap

> Reflects status as of project setup. Update as phases complete.

### ✅ Phase 0 — Foundation (current)
- Project scaffolding, strict TypeScript config.
- Authentication: register, login, JWT access tokens, rotating refresh tokens.
- Single relational database via Prisma.

### ⬜ Phase 1 — Operational Entities
- Relational models: House, Room, Device.
- CRUD + ownership/authorization tying entities to Users.
- Current-state tracking for devices (power, temperature, configuration).

### ⬜ Phase 2 — Telemetry Pipeline
- Introduce the document/time-series layer.
- Non-blocking, asynchronous ingestion of state-change and sensor events.
- Hard isolation so logging backpressure cannot affect the control plane.

### ⬜ Phase 3 — AI Readiness
- Stable, export-friendly historical-log schema.
- Export tooling for ML/AI pipelines.
- Initial anomaly-detection / behavioral-prediction experiments.

---

## 4. Architecture Gap (Vision vs. Reality)

The product vision in [`README.md`](README.md) describes the **target** system. **Today only Phase 0 exists.** When working in this repo, do not assume any Phase 1+ capability (devices, telemetry, time-series store, AI export) is present — verify against the actual code and [`CLAUDE.md`](CLAUDE.md) before relying on it.
