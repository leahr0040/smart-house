# Phase 3: Messaging Infrastructure - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-02
**Phase:** 3-Messaging Infrastructure
**Areas discussed:** RabbitMQ deps, POST /commands stub, Test infra, Topology config & naming

---

## RabbitMQ deps (gate)

| Option | Description | Selected |
|--------|-------------|----------|
| amqp-connection-manager | Wraps amqplib; automatic background reconnect + channel re-setup (matches ROADMAP scaffold). Installs amqp-connection-manager + amqplib + @types/amqplib. | ✓ |
| Raw amqplib only | amqplib + @types only; hand-roll reconnect/backoff/re-assertion — more code, contradicts ROADMAP note. | |

**User's choice:** amqp-connection-manager
**Notes:** Package installs; blocking-human review checkpoint applies at plan time.

---

## POST /commands stub

| Option | Description | Selected |
|--------|-------------|----------|
| Stub route, 503-or-501 | Phase 3 owns `src/routes/commands/`; readiness preHandler → 503 when down, 501 Not Implemented when up; Phase 4 fills handler. | ✓ |
| Stub route, 503-or-202 | Same route/guard but 202 Accepted no-op when up — slightly misleading until Phase 4. | |
| Guard only, test the seam | No route in Phase 3; test isBrokerReady() via a throwaway probe, defer route to Phase 4 — can't hit literal POST /commands path SC-2 names. | |

**User's choice:** Stub route, 503-or-501
**Notes:** The phase test requires the literal POST /commands path; 501-when-up honestly signals "route exists, logic pending."

---

## Test infra (gate)

| Option | Description | Selected |
|--------|-------------|----------|
| testcontainers now | Introduce @testcontainers/rabbitmq in Phase 3; boot against ephemeral container; same harness Phase 8 needs. New dev dep. | |
| Local broker via env | No new dep; test connects to developer/CI-provided RABBITMQ_URL. | ✓ |
| Split: unit now, containers Phase 8 | Unit-test readiness/503 with a mock; defer all real-broker topology assertions to Phase 8. | |

**User's choice:** Local broker via env (overrides ROADMAP Phase-3 testcontainers note)

### Follow-up — behavior when no broker reachable

| Option | Description | Selected |
|--------|-------------|----------|
| Skip if unreachable | Self-skip when connection fails within a timeout; npm test stays green without a broker. | |
| Fail if unreachable | Hard-fail when no broker reachable; guarantees CI verification, breaks npm test without a local RabbitMQ. | ✓ |
| Gate on a test env flag | Only run when RUN_BROKER_TESTS=1; easy to forget. | |

**User's choice:** Fail if unreachable
**Notes:** `npm test` now requires a running RabbitMQ at RABBITMQ_URL.

---

## Topology config & naming

| Option | Description | Selected |
|--------|-------------|----------|
| Typed constants module | Single topology file: typed constants + declareTopology(); env holds only RABBITMQ_URL. | ✓ (adapted) |
| Env-configurable | Surface TTL/x-death/prefetch/names as env vars with defaults now. | |

**User's choice:** Constants under a new `src/config/` directory (a `rabbitmq` topology file) — no env vars now, but the file is the seam where a future env var can be added (declared in env.ts, consumed here).

### Follow-up — routing-key binding design

| Option | Description | Selected |
|--------|-------------|----------|
| Catch-all '#' for now | Each main queue binds with '#'; topic type preserved; tighten later. | |
| Structured keys now | Design effect.<type>.<id> / report.<type> scheme now — speculative in v1. | |
| You decide (defer to researcher) | Leave the pattern to researcher/planner; constraint: idempotent + single-queue-per-exchange works. | ✓ |

**User's choice:** You decide (defer to researcher)

---

## Claude's Discretion

- Routing-key / binding pattern (idempotent topology, single-queue-per-exchange must work; `#` the likely default).
- Graceful-shutdown wiring: SIGTERM/SIGINT handlers in src/server.ts calling server.close() so the plugin onClose fires in production.
- Depth of RABBITMQ_URL validation (presence is locked; amqp:// shape check optional).
- Readiness-flag toggle mechanics (connection-manager connect/disconnect events).

## Deferred Ideas

- testcontainers real-broker fixture → Phase 8.
- Env-configurable topology knobs → seam left open in src/config/rabbitmq*.
- Structured routing keys → until a selective second consumer needs a subset.
- DLQ drain / alerting → out of scope for v1 (manual inspection only).
