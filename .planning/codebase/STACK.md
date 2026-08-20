# Technology Stack

**Analysis Date:** 2026-06-25

## Languages

**Primary:**
- TypeScript 6.0.3 - Full codebase (API, services, database models, tests)

**Secondary:**
- JavaScript (CommonJS) - Compiled output target (ES2020)
- Node.js 18+ - Runtime environment (implied by package.json compatibility)

## Runtime

**Environment:**
- Node.js 18+ (implied by TypeScript ES2020 target and dependency requirements)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` (expected, standard npm behavior)

## Frameworks

**Core:**
- Fastify 5.8.5 - REST API framework
- @fastify/autoload 6.0.0 - Plugin auto-discovery and registration
- @fastify/jwt 10.0.0 - JWT authentication (access tokens)
- @fastify/cookie 11.0.2 - HTTP cookie handling (refresh tokens)
- @fastify/sensible 6.0.0 - HTTP error helpers
- fastify-plugin 5.0.0 - Fastify plugin utilities

**Database:**
- Prisma 7.8.0 - ORM and database migrations
- @prisma/adapter-mariadb 7.8.0 - MySQL connection adapter (driver-adapter pattern). Despite the name, this is Prisma's one adapter for the whole MySQL/MariaDB family and the engine here is **MySQL 8.0**, not MariaDB

**Validation:**
- Zod 4.4.3 - Runtime schema validation (environment variables)

**Security:**
- bcrypt 5.1.1 - Password hashing (argon2 alternative not used)

**Testing:**
- Node.js built-in test runner (`node:test`) - No external test framework
- Node.js built-in assertion library (`node:assert`) - No external assertion library

**Build/Dev:**
- TypeScript 6.0.3 - Compiler
- tsx 4.22.4 - TypeScript executor for dev server and scripts
- ts-node 10.9.2 - TypeScript REPL and command-line execution
- tsc - TypeScript compiler (via `npm run build`)

**Type Definitions:**
- @types/node 25.6.0 - Node.js type definitions
- @types/bcrypt 5.0.0 - bcrypt type definitions

## Key Dependencies

**Critical:**
- `fastify` 5.8.5 - Core HTTP server; all requests route through it
- `@prisma/client` 7.8.0 + `@prisma/adapter-mariadb` 7.8.0 - Database access; single source of data
- `@fastify/jwt` 10.0.0 - JWT signing and verification; required for auth routes
- `bcrypt` 5.1.1 - Password hashing; every user registration/login depends on it

**Infrastructure:**
- `dotenv` 17.4.2 - Environment variable loading (called in `src/lib/env.ts`)
- `@fastify/cookie` 11.0.2 - Cookie storage of refresh tokens

## Configuration

**Environment:**
- Loaded via `dotenv/config` in `src/lib/env.ts` at application startup
- Validated with Zod schema at runtime; application exits if validation fails
- Key configurations required:
  - `DATABASE_URL` (required) - MySQL connection string (driver-adapter format)
  - `JWT_SECRET` (required) - Secret for signing JWTs; minimum 1 character
  - `PORT` (optional, default: 3000) - HTTP server listen port
  - `HOST` (optional, default: 127.0.0.1) - HTTP server bind address
  - `LOG_LEVEL` (optional, default: info) - Fastify logger level

**Build:**
- `tsconfig.json` - Strict TypeScript compilation settings
  - Target: ES2020 (CommonJS module output)
  - Strict mode enabled (strictNullChecks, noImplicitAny, etc.)
  - Path alias: `@/*` → `src/*` (not yet used; available for imports)
  - Source maps enabled (declaration maps + inline source maps)
  - No unused locals/parameters allowed

## Platform Requirements

**Development:**
- Node.js 18+
- npm 7+
- Windows, macOS, or Linux with POSIX shell support (Bash/Zsh)
- MySQL 8.0 (for `DATABASE_URL` connection)

**Production:**
- Node.js 18+ LTS (production-grade runtime)
- MySQL 8.0 (production database)
- Environment variables configured (DATABASE_URL, JWT_SECRET at minimum)
- No container orchestration specified; designed for VM or bare-metal deployment

---

*Stack analysis: 2026-06-25*
