# SmartHome Backend Core

> A modern, high-performance Smart Home Automation backend.

---

## Project Name & Mission

**SmartHome Backend Core**

A modern, high-performance Smart Home Automation backend built to manage real-time device states, ingest high-throughput telemetry, and lay the foundation for future AI-driven automation.

The system is designed to serve as the single source of truth for a smart home's operational state — knowing what every device is doing right now — while simultaneously building a rich historical record that enables intelligent, data-driven automation over time.

> **Status:** Early development. The capabilities below describe the **target product vision**. For what is implemented today and the path to get there, see [`PLAN.md`](PLAN.md) and [`CLAUDE.md`](CLAUDE.md).

---

## Core Architecture Concepts

The system employs a **hybrid persistence strategy**, choosing the right storage tool for each type of data rather than forcing everything into a single model.

### Relational Layer — Operational Consistency

Handles all entities where strict relational integrity matters: Houses, Rooms, Devices, Users, and their **current live states**. Transactions, foreign key constraints, and normalized schemas ensure that the operational picture of the home is always consistent and queryable.

### Document / Time-Series Layer — Analytical Velocity

Optimized for the high write-throughput demands of telemetry: every sensor reading, state change event, and system log is captured here. This layer is append-only by design, prioritizing ingestion speed over transactional guarantees, and acts as the raw material for analytics and AI training pipelines.

---

## Core Functional Capabilities

### State Management
Real-time tracking and control of device power states, temperature setpoints, configuration parameters, and presence detection. Any connected client can query the current state of any device or trigger a state transition through the API.

### Telemetry Ingestion
Every state change and sensor event is asynchronously logged to the time-series layer without blocking the primary request lifecycle. This decoupling ensures that high-frequency device reporting does not degrade API responsiveness.

### AI Readiness
The historical log schema is designed from the outset for downstream ML/AI consumption — structured to make it straightforward to export event sequences into LLM context windows or training datasets for behavioral prediction, anomaly detection, and automated scheduling.

---

## System Guiding Principles

### Type Safety
The entire codebase is built with strict compile-time typing. Every request body, response shape, database model, and service contract is explicitly typed. The goal is to catch contract violations at build time, not at runtime in production.

### Modularity — Operational vs. Analytical Separation
The business logic for managing device state is deliberately decoupled from the telemetry pipeline. Failures or backpressure in the logging layer cannot cascade into the operational control plane. These two concerns evolve independently and can be scaled independently.

---

## Getting Started

```bash
npm install          # Install dependencies
npm run dev          # Start the dev server with hot-reload (http://localhost:3000)
npm run build        # Compile to dist/
npm start            # Run the compiled production build
npm test             # Build and run the test suite
```

Database (Prisma):

```bash
npm run prisma:generate   # Regenerate the client after schema changes
npm run prisma:migrate    # Apply migrations (dev)
npm run prisma:studio     # Open the Prisma Studio GUI
```

Create a `.env` file with at least `DATABASE_URL` and `JWT_SECRET` (see [`CLAUDE.md`](CLAUDE.md) for the full list).

---

## Documentation Map

| File | Audience | Purpose |
|---|---|---|
| `README.md` | Everyone | Product vision & getting started |
| [`PLAN.md`](PLAN.md) | Contributors | Development rules, target architecture, roadmap |
| [`CLAUDE.md`](CLAUDE.md) | AI assistants / devs | What is implemented today, conventions, commands |
