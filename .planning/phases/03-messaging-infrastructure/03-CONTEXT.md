# Phase 3: Messaging Infrastructure - Context

**Gathered:** 2026-08-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Stand up the RabbitMQ **infrastructure only** — no publishing, no consuming yet.
Deliver: an `amqp-connection-manager` wrapper that connects in the **background**
(never blocking `app.ready()`) with automatic reconnect; a Fastify plugin that
owns the connection lifecycle and closes it on shutdown; idempotent provisioning
of the full topology (per consumer queue `device_effects` / `device_reports`:
main queue + `*.retry` wait queue + terminal `*.dlq`) on the two topic exchanges;
a broker-readiness flag (`isBrokerReady()`); and graceful `POST /commands` → 503
degradation while every MySQL route (auth, CRUD, state, events) stays fully
available. Requirement: **MSG-01 only**.

Not in scope (later phases): publishing effects (Phase 4), the simulated worker
(Phase 5), the report consumer + state projection (Phase 6), the real
`POST /commands` handler logic (Phase 4), testcontainers-based E2E (Phase 8).

This phase follows the **structure-first → tests-red → implement** sequence (it
adds runtime logic, not just schema).

</domain>

<decisions>
## Implementation Decisions

Most topology/boot semantics are already locked by PROJECT.md / ROADMAP / REQUIREMENTS
(see Canonical References) and are **not** re-litigated here. The decisions below
resolve the open gray areas from this discussion.

### Dependencies (install gate)
- **D-01 (amqp-connection-manager):** Use `amqp-connection-manager` (wraps
  `amqplib`) for the connection layer — it provides the background reconnect +
  channel re-assertion the "no startup block, reconnect" requirement needs.
  New deps: `amqp-connection-manager`, `amqplib` (runtime) and `@types/amqplib`
  (dev). **These are package installs — the blocking-human review checkpoint
  applies; the plan must stop at that gate before installing.**

### POST /commands stub
- **D-02 (stub route now, real handler Phase 4):** Phase 3 scaffolds
  `src/routes/commands/` owning `POST /commands`. A broker-readiness `preHandler`
  guard returns **503 when the broker is down**; when the broker is up the
  placeholder returns **501 Not Implemented**. Phase 4 fills the real handler
  behind the same readiness guard. Rationale: SC-2 and the phase test assert the
  literal `POST /commands` path returns 503 when down, so the route must exist
  now; 501-when-up honestly signals "route exists, logic not yet built."

### Test infrastructure (deviation from ROADMAP)
- **D-03 (local broker via env, NOT testcontainers):** Phase 3 integration tests
  connect to a developer/CI-provided `RABBITMQ_URL` — **no testcontainers
  dependency is introduced in Phase 3**. testcontainers moves to Phase 8.
  **This overrides the ROADMAP Phase-3 test note** ("testcontainers integration
  test — boot the app against a real RabbitMQ container"). Deliberate user
  decision — recorded here so the planner does not re-add testcontainers.
- **D-04 (hard-fail if no broker):** The real-broker integration test (topology
  assertions + the 503/200 degradation test) **hard-fails when no broker is
  reachable** at `RABBITMQ_URL` — it does not self-skip. Consequence: `npm test`
  requires a running RabbitMQ; CI/dev must provide one. (Note the interaction
  with the fail-fast env rule: `RABBITMQ_URL` is *required* for the app to boot
  at all, so the suite already needs it set; this decision additionally requires
  the broker at that URL to be reachable.)

### Topology config & naming
- **D-05 (typed constants in a config directory, env-seam left open):** Topology
  parameters — exchange names, queue names, retry `x-message-ttl` (~30s),
  `x-death` max (~5), `prefetch` (1) — live as **typed constants in a new
  `src/config/` directory** (e.g. `src/config/rabbitmq.ts`), alongside a
  `declareTopology()` helper. **No env vars beyond `RABBITMQ_URL` in v1.** The
  file is the seam where a future env-backed override slots in (add the var to
  `src/lib/env.ts`, reference it here) — mark it with a `ponytail:` upgrade
  comment. Matches the "explicit over magic / typed enumerated config" rule.

### Claude's Discretion (researcher/planner to decide)
- **D-06 (routing-key binding design):** Exact routing keys / binding pattern for
  the main-queue↔topic-exchange bindings is deferred to the researcher/planner.
  Hard constraints: topology provisioning must be **idempotent** and
  **single-queue-per-exchange** must work in v1. A catch-all `#` binding is the
  expected lazy default; tighten to structured keys only when a second selective
  consumer needs a subset (`ponytail:`).
- **Graceful shutdown wiring:** Add SIGTERM/SIGINT handlers in `src/server.ts`
  that call `server.close()` so the plugin's `onClose` hook actually fires the
  connection close in production (tests already close via `build(t)`). Exact
  shape is Claude's discretion; SC-4 (clean shutdown, no unclosed-handle
  warnings) is the acceptance bar.
- **`RABBITMQ_URL` validation depth** — presence/fail-fast is locked; whether to
  additionally assert an `amqp://`/`amqps://` shape in `env.ts` is discretion.
- **Readiness-flag mechanics** — how `isBrokerReady()` is toggled (connection
  manager `connect`/`disconnect` events) is an implementation detail for the
  researcher.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Planning specs (authoritative for Phase 3)
- `.planning/ROADMAP.md` §"Phase 3: Messaging Infrastructure" — Goal, the five
  Success Criteria (the acceptance contract), and the scaffold/test/implement
  notes. **Note the D-03 override:** ignore the "testcontainers integration test"
  wording in the test note for Phase 3 — this phase tests against a local broker
  via `RABBITMQ_URL`.
- `.planning/REQUIREMENTS.md` §Messaging (MSG-01) — the single requirement this
  phase delivers; §Testing (TEST-04 DLQ is Phase 6, not here) for the broader
  test convention.
- `.planning/PROJECT.md` §Constraints ("Boot resilience", "Failure taxonomy",
  "Process model", "Throughput ceiling") & §Key Decisions (the RabbitMQ topology
  row) — background connect, `POST /commands` → 503, per-queue main + `*.retry` +
  `*.dlq`, fixed ~30s TTL DLX→main, `x-death`-bounded retry, `prefetch=1`, API
  owns topology.

### Prior phase context
- `.planning/phases/02-entity-crud-multi-tenancy/02-CONTEXT.md` — the CRUD/route
  patterns and the `public_id`-only response convention the new `commands` route
  should follow (D-03 there); TypeBox for any new schemas.

### Codebase maps
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md` —
  autoload plugin/route layout, boot flow (`src/server.ts` → `app.ts` →
  autoload plugins then routes).
- `.planning/codebase/TESTING.md` — `build(t)` + `app.inject()` convention the
  phase tests use.
- `.planning/codebase/INTEGRATIONS.md` §Environment Configuration — current env
  vars + the Zod `src/lib/env.ts` validation seam (where `RABBITMQ_URL` is added).

### Existing code (integration points / patterns to mirror)
- `src/server.ts` — the bare Fastify instance + `start()`; where SIGTERM/SIGINT
  graceful-shutdown handlers land.
- `app.ts` — autoload registration order (plugins before routes); the new
  `rabbitmq` plugin drops into `src/plugins/`.
- `src/plugins/auth.ts` — the `fastify-plugin` + `fastify.decorate` +
  `declare module 'fastify'` pattern the rabbitmq plugin mirrors (for
  `isBrokerReady` / connection decoration).
- `src/lib/env.ts` — Zod env schema; add `RABBITMQ_URL` (fail-fast, required).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`src/lib/env.ts` (Zod schema, fail-fast on import)** — add `RABBITMQ_URL`
  here as a required string; the existing throw-on-invalid path already gives the
  "descriptive error, immediate exit" behavior SC-1 wants for a missing var.
- **`src/plugins/auth.ts` plugin shape** — `fp(async (fastify) => …)` +
  `fastify.decorate(...)` + a `declare module 'fastify'` interface augmentation.
  The rabbitmq plugin follows this to decorate `isBrokerReady()` (and the
  connection/channel) onto the instance.
- **`fastify.httpErrors` (@fastify/sensible)** — `serviceUnavailable()` for the
  `POST /commands` 503 guard; the global error-handler normalizes it.
- **`@fastify/autoload`** — dropping `src/plugins/rabbitmq.ts` and
  `src/routes/commands/index.ts` auto-registers them (plugins load before routes,
  so the readiness decorator is available to the route's preHandler).

### Established Patterns
- **Boot flow:** `src/server.ts` registers `app.ts`, which autoloads
  `src/plugins/` then `src/routes/`. The rabbitmq plugin must NOT `await` the
  broker connection before `app.ready()` — it kicks off connect and returns.
- **New route response convention:** `commands` route exposes `public_id`-only
  and uses TypeBox schemas (per Phase 2 D-03) — even though the Phase 3 stub only
  returns 501/503, keep it consistent for Phase 4.
- **Services stay Prisma-only / no Fastify types** — the rabbitmq connection is
  Fastify-plugin-owned infrastructure, not a `src/services/` concern.

### Integration Points
- **Readiness flag → 503 guard:** the plugin decorates `isBrokerReady()`; the
  `POST /commands` preHandler reads it → 503 when false. Toggled by the
  connection manager's connect/disconnect events.
- **Graceful shutdown:** plugin registers an `onClose` hook that closes the
  amqp-connection-manager connection; `src/server.ts` signal handlers call
  `server.close()` so that hook runs in production.
- **Topology ownership:** the API process declares/asserts the topology
  idempotently on (re)connect via the `src/config/rabbitmq*` `declareTopology()`
  helper; future worker/consumer processes (Phases 5/6) assert the same topology
  idempotently.

</code_context>

<specifics>
## Specific Ideas

- Config directory is explicitly requested: create `src/config/` and put the
  RabbitMQ topology file under it — constants now, structured so a future env var
  can be added in `env.ts` and consumed here.
- Do not introduce testcontainers in this phase (D-03) — it belongs to Phase 8.
- Mark the retry/TTL/x-death/prefetch constants and the routing-key binding with
  `ponytail:` upgrade comments naming the future trigger, per the deferrals in
  PROJECT.md.

</specifics>

<deferred>
## Deferred Ideas

- **testcontainers-based real-broker fixture** — moved to Phase 8 (shared
  suite-level fixture for MySQL + RabbitMQ). Phase 3 uses a local broker via
  `RABBITMQ_URL` instead. When Phase 8 lands, its DB container must be
  `@testcontainers/mysql` / `mysql:8.0` — the same module Phase 9 settles on.
  The engine is MySQL, not MariaDB, regardless of the `@prisma/adapter-mariadb`
  package name (see `.planning/codebase/INTEGRATIONS.md`).
- **Env-configurable topology knobs** (TTL, x-death max, prefetch, names) — seam
  left open in `src/config/rabbitmq*`; add only when a real tuning need appears.
- **Structured routing keys** — deferred until a second selective consumer needs
  a subset; `#` catch-all suffices for single-queue-per-exchange v1.
- **DLQ drain / alerting** — explicitly out of scope for v1 (PROJECT.md
  `ponytail:` note); manual inspection only.

None of the above are blockers; discussion stayed within phase scope.

</deferred>

---

*Phase: 3-Messaging Infrastructure*
*Context gathered: 2026-08-02*
