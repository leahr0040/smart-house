<!-- refreshed: 2026-06-25 -->
# Architecture

**Analysis Date:** 2026-06-25

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                      HTTP Request Handler (Fastify)                      │
│                          `src/server.ts`                                 │
└─────────────────────┬───────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Plugin Layer (Initialization)                         │
│                          `app.ts` → AutoLoad                             │
├───────────────────┬──────────────────────┬──────────────────────────────┤
│   Auth Plugin     │   Error Handler      │   Cookie & Sensible          │
│ `src/plugins/     │  `src/plugins/       │  `src/plugins/sensible.ts`   │
│  auth.ts`         │   error-handler.ts`  │  (+ @fastify/cookie)         │
│                   │                      │                              │
│ - JWT setup       │ - Error normalization│ - HTTP error helpers         │
│ - Token funcs     │                      │ - Cookie parsing             │
└───────────────────┴──────────────────────┴──────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Route Layer (API Handlers)                            │
│                    `src/routes/` → AutoLoad                              │
├───────────────────────────────────────────────────────────────────────┤
│  Root Route           │      Auth Routes                                │
│  `src/routes/         │      `src/routes/auth/index.ts`                 │
│   root.ts`            │                                                 │
│                       │  - POST /auth/register                          │
│  - GET /              │  - POST /auth/login                             │
│                       │  - GET /auth/me (protected)                     │
│                       │  - POST /auth/refresh                           │
│                       │  - POST /auth/logout                            │
└───────────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Service Layer (Business Logic)                        │
│                        `src/services/`                                   │
├────────────────────────┬──────────────────┬──────────────────────────┤
│   User Service         │  Auth Service    │  Refresh Token Service   │
│  `src/services/        │ `src/services/   │ `src/services/           │
│   user.ts`             │  auth.ts`        │  refresh-token.ts`       │
│                        │                  │                          │
│ - createUser()         │ - loginUser()    │ - generateRefreshToken() │
│ - getUserById()        │                  │ - verifyRefreshToken()   │
│                        │                  │ - revokeRefreshToken()   │
└────────────────────────┴──────────────────┴──────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Data Layer (Prisma ORM)                               │
│   `src/lib/prisma.ts` (singleton) + `src/generated/prisma/` (client)   │
│                                                                          │
│   - PrismaMariaDb adapter for MariaDB connection                        │
│   - User & RefreshToken models                                          │
└─────────────────────┬─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      MariaDB Database                                    │
│                  (via connection pool)                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Server | Boot Fastify, listen on port | `src/server.ts` |
| App Plugin | Register plugins & routes via AutoLoad | `app.ts` |
| Auth Plugin | JWT setup, token decoration | `src/plugins/auth.ts` |
| Error Handler | Normalize errors to JSON shape | `src/plugins/error-handler.ts` |
| Root Route | Health/identity check | `src/routes/root.ts` |
| Auth Routes | Register, login, refresh, me, logout | `src/routes/auth/index.ts` |
| User Service | Create/fetch user, hash password | `src/services/user.ts` |
| Auth Service | Password verification | `src/services/auth.ts` |
| Refresh Service | Token generation, validation, revocation | `src/services/refresh-token.ts` |
| Prisma Client | Database access (singleton) | `src/lib/prisma.ts` |
| Env Validation | Parse/validate environment variables | `src/lib/env.ts` |

## Pattern Overview

**Overall:** Layered architecture with Fastify plugin-based composition and service separation of concerns.

**Key Characteristics:**
- **Plugin-first**: Fastify plugins initialize cross-cutting concerns (auth, error handling) before routes load.
- **AutoLoad**: Directory-based plugin/route registration maps filesystem to API structure (e.g., `src/routes/auth/index.ts` → `/auth/*`).
- **Pure services**: Services contain no Fastify types; they're pure functions over Prisma that routes can call.
- **Single entry point**: All requests flow through `src/server.ts` → `app.ts` plugin registration.
- **Middleware via preHandler**: Route-level authentication via Fastify `preHandler` hook (e.g., `fastify.authenticate`).

## Layers

**Plugin Layer:**
- Purpose: Extend Fastify instance with cross-cutting concerns before routes register.
- Location: `src/plugins/`
- Contains: Fastify plugins using `fastify-plugin` wrapper for proper initialization ordering.
- Depends on: Fastify instance, environment config.
- Used by: `app.ts` AutoLoad registration; routes call decorated methods like `fastify.authenticate`, `fastify.generateTokens`.

**Route Layer:**
- Purpose: Handle HTTP requests, parse input, call services, return responses.
- Location: `src/routes/`
- Contains: FastifyPluginAsync exports with route handlers and co-located schemas.
- Depends on: Services, plugins (for decorators), Prisma models.
- Used by: Client HTTP requests (via AutoLoad path-to-route mapping).

**Service Layer:**
- Purpose: Pure business logic and database operations, independent of HTTP/Fastify.
- Location: `src/services/`
- Contains: Exported async functions that take plain JS objects, return data or null.
- Depends on: Prisma client, bcrypt, Node crypto.
- Used by: Routes and tests.

**Data Layer:**
- Purpose: Database abstraction and access.
- Location: `src/lib/prisma.ts` (singleton initialization); `src/generated/prisma/` (generated client types).
- Contains: Prisma client with MariaDB adapter, auto-generated query builder methods.
- Depends on: MariaDB driver (via `@prisma/adapter-mariadb`), connection string.
- Used by: Services.

**Environment Layer:**
- Purpose: Centralized environment variable parsing and validation.
- Location: `src/lib/env.ts`
- Contains: Zod schema, parsing logic, throws on invalid config.
- Depends on: `dotenv`, `zod`.
- Used by: `src/server.ts`, `src/plugins/auth.ts`, `src/lib/prisma.ts`.

## Data Flow

### Primary Request Path: POST /auth/login

1. **Request arrives** at Fastify listener (`src/server.ts:14`)
2. **Router dispatches** to `/auth` handler via AutoLoad (`app.ts:14-17`)
3. **Route handler** (`src/routes/auth/index.ts:53-66`) receives request with body schema validation
4. **Call service** (`loginUser(request.body)` → `src/services/auth.ts:9`)
5. **Service queries DB** (Prisma) for user by email, verifies bcrypt hash
6. **Return user object** to route
7. **Route calls plugin decorator** (`fastify.generateTokens(user)` → `src/plugins/auth.ts:38-43`)
8. **Decorator creates JWT** and generates refresh token via service (`generateRefreshToken` → `src/services/refresh-token.ts:10-23`)
9. **Refresh token stored in DB** (hash only, raw returned to route)
10. **Route sets cookie** with raw refresh token (httpOnly, secure) (`src/routes/auth/index.ts:20-28`)
11. **Response sent**: `{ accessToken, expiresAt, user }`

### Refresh Token Rotation Path: POST /auth/refresh

1. **Request arrives** with `refreshToken` cookie
2. **Route reads cookie** (`request.cookies.refreshToken`)
3. **Call service** (`verifyRefreshToken(raw)` → `src/services/refresh-token.ts:25-40`)
4. **Service hashes token**, queries DB for stored record, checks expiry and revocation status
5. **If valid**, return user object; else return null (clear cookie on null)
6. **If valid, call revocation** (`revokeRefreshToken(raw)`) to mark old token as revoked
7. **Generate new token pair** via `fastify.generateTokens(user)` (stores new refresh token in DB)
8. **Set new cookie**, return new access token + expiry

### Protected Route Path: GET /auth/me

1. **Request arrives** with `Authorization: Bearer <accessToken>`
2. **Route specifies** `preHandler: fastify.authenticate` (`src/routes/auth/index.ts:69`)
3. **Authenticate decorator** (`src/plugins/auth.ts:34-36`) calls `request.jwtVerify()`
4. **JWT verified** by `@fastify/jwt`; user payload attached to `request.user`
5. **Route handler executes** if JWT valid
6. **Call service** (`getUserById(request.user.id)`) to fetch current user data
7. **Return user** (or 404 if not found)

**State Management:**
- **Request state**: Transient; passed through request object and local variables.
- **Global state**: Prisma singleton (`src/lib/prisma.ts`); Fastify instance (shared via plugin decorators).
- **Persistent state**: User credentials and refresh token hashes stored in MariaDB.
- **Session state**: Refresh token represents a session; revocation marks it as inactive.

## Key Abstractions

**User:**
- Purpose: Represents an authenticated identity.
- Examples: `src/services/user.ts` creates/fetches; `src/routes/auth/index.ts` returns user payload.
- Pattern: Plain `{ id, email, name }` object; no class wrapper.

**Refresh Token:**
- Purpose: Long-lived opaque secret for obtaining new access tokens without password.
- Examples: `src/services/refresh-token.ts` generates/verifies/revokes; stored as hash in `RefreshToken` table.
- Pattern: Raw token (40-byte hex) issued to client; hash stored in DB; single-use (revoked on rotation).

**JWT Access Token:**
- Purpose: Short-lived signed credential for API access.
- Examples: `src/plugins/auth.ts` signs; `src/routes/auth/index.ts` returns; `@fastify/jwt` verifies.
- Pattern: Signed by `JWT_SECRET`, expires in 15 minutes, contains user id/email/name.

**Error Response:**
- Purpose: Normalized error shape for all HTTP failures.
- Examples: `src/plugins/error-handler.ts` formats as `{ error, message, statusCode }`.
- Pattern: Global error handler catches all throws; routes throw `fastify.httpErrors.conflict()`, `fastify.httpErrors.unauthorized()`, etc.

## Entry Points

**src/server.ts:**
- Location: Root entry point.
- Triggers: `npm start` or app startup.
- Responsibilities:
  - Creates bare Fastify instance with logger config.
  - Registers `app.ts` plugin (which triggers AutoLoad for plugins/routes).
  - Listens on `env.PORT` and `env.HOST`.
  - Handles startup errors.

**app.ts:**
- Location: Root plugin file (not in `src/`, loaded explicitly by `server.ts`).
- Triggers: Fastify.register() call in `server.ts`.
- Responsibilities:
  - Registers `@fastify/cookie` (needed by auth routes).
  - Registers `@fastify/autoload` twice: once for `src/plugins/`, once for `src/routes/`.
  - AutoLoad ensures plugins initialize before routes.

**src/routes/{path}/index.ts:**
- Location: Route files (one per route subtree).
- Triggers: AutoLoad discovery after plugins initialize.
- Responsibilities: Define HTTP handlers for all methods under that path.

## Architectural Constraints

- **Threading:** Single-threaded event loop (Node.js default). Fastify handles concurrency via async I/O; database operations are non-blocking via Prisma.
- **Global state:** Prisma singleton in `src/lib/prisma.ts`; Fastify instance shared via plugin decorators (`fastify.authenticate`, `fastify.generateTokens`). No module-level mutable state outside these.
- **Circular imports:** None detected. Layer dependency is strict: routes → services → prisma; plugins → env.
- **AutoLoad ordering:** Plugins load alphabetically before routes alphabetically. Explicit dependency requires filename prefixing (e.g., `1-auth.ts` before `2-routes.ts`), not currently used.
- **Cookie scope:** Refresh token cookie scoped to `/auth` path; only `/auth/*` routes can access it.
- **Database:** MariaDB via `@prisma/adapter-mariadb` driver (not TCP connector); migration-based schema management.

## Anti-Patterns

### Mixing Fastify types in services

**What happens:** Services import `FastifyRequest`, `FastifyReply`, or other Fastify types.

**Why it's wrong:** Services become tightly coupled to HTTP framework; they can't be reused in other contexts (CLI, cron jobs, tests without spinning up Fastify).

**Do this instead:** Services take plain JS objects, return plain objects. Routes translate between HTTP and services. See `src/services/user.ts` (plain input/output) vs `src/routes/auth/index.ts` (Fastify-aware).

### Inline validation in routes

**What happens:** Routes manually validate request body fields instead of using schemas.

**Why it's wrong:** Duplicates logic, hard to maintain, no automatic serialization or OpenAPI generation.

**Do this instead:** Define schemas in co-located `schemas.ts`, pass to route via `schema` option. Fastify validates input and serializes output. See `src/routes/auth/schemas.ts` + `src/routes/auth/index.ts` (schema: registerRouteSchema).

### Synchronous database queries in async context

**What happens:** Using `.sync()` methods or blocking on database I/O in handlers.

**Why it's wrong:** Blocks the event loop; kills concurrency benefits.

**Do this instead:** Always `await` Prisma queries. Services and routes are `async` functions. See `src/services/user.ts` (createUser uses `await prisma.user.create()`).

## Error Handling

**Strategy:** Global error handler normalizes all errors; routes throw typed HTTP errors.

**Patterns:**
- Routes throw `fastify.httpErrors.conflict()`, `fastify.httpErrors.unauthorized()`, etc. (from `@fastify/sensible`).
- Services throw generic `Error` or return `null` for "not found" cases.
- Global error handler (`src/plugins/error-handler.ts`) catches all throws, logs, returns `{ error, message, statusCode }`.
- Prisma unique constraint violations caught explicitly in routes (e.g., email duplicate → throw `conflict()`).

**Example:**
```typescript
// src/routes/auth/index.ts:38-45
try {
  user = await createUser(request.body)
} catch (err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw fastify.httpErrors.conflict('Email already in use')
  }
  throw err
}
```

## Cross-Cutting Concerns

**Logging:** Fastify built-in logger (configured via `server.ts` with `env.LOG_LEVEL`). Plugin/route code can call `fastify.log.*()` or `this.log.*()` in context. Error handler logs all exceptions.

**Validation:** Request body/params validated by Fastify using JSON Schema (defined in route schemas). Response validated against response schema (serialization). Env validation via Zod in `src/lib/env.ts`.

**Authentication:** JWT access tokens verified via `@fastify/jwt` + `preHandler: fastify.authenticate` hook. Refresh tokens verified via `verifyRefreshToken()` service (checks hash, expiry, revocation).

---

*Architecture analysis: 2026-06-25*
