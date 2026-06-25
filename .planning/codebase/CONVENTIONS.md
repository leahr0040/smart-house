# Coding Conventions

**Analysis Date:** 2026-06-25

## Naming Patterns

**Files:**
- Service files: lowercase with hyphens (e.g., `refresh-token.ts`, `auth.ts`, `user.ts`)
- Route files: lowercase with hyphens or index pattern (e.g., `src/routes/root.ts`, `src/routes/auth/index.ts`)
- Plugin files: lowercase with hyphens (e.g., `error-handler.ts`, `auth.ts`)
- Schema files: co-located with routes as `schemas.ts`
- Test files: same name as source with `.test.ts` suffix (e.g., `src/test/routes/root.test.ts`)

**Functions:**
- camelCase for all function names
- Private helpers prefixed with underscore not used; all functions exported as named exports
- Async functions return Promise types explicitly
- Examples:
  - `createUser` (`src/services/user.ts`)
  - `loginUser` (`src/services/auth.ts`)
  - `generateRefreshToken` (`src/services/refresh-token.ts`)
  - `verifyRefreshToken` (`src/services/refresh-token.ts`)

**Variables:**
- camelCase for all variable names (e.g., `hashedPassword`, `accessToken`, `refreshToken`)
- Constants in uppercase with underscores (e.g., `REFRESH_TOKEN_EXPIRES_DAYS = 7`, `ACCESS_TOKEN_EXPIRES_MINUTES = 15`)
- Boolean variables often prefixed with `is` (e.g., `isValid`)
- No Hungarian notation or type prefixes

**Types:**
- PascalCase for all type names (e.g., `RegisterBody`, `LoginBody`, `CreateUserInput`, `LoginUserInput`)
- Inline type definitions for request/response bodies in route files
- Type alias pattern: `type TypeName = { ... }`
- Shared types defined in service files as type aliases
- Interface syntax preferred for module augmentation (e.g., `declare module 'fastify'` extends with `interface`)

## Code Style

**Formatting:**
- No explicit formatter configured (ESLint/Prettier not in devDependencies)
- Consistent observed style:
  - 2-space indentation
  - Semicolons used throughout
  - Single quotes preferred in strings
  - No trailing commas in single-line objects/arrays
  - Spacing around imports, functions, and logical blocks

**Linting:**
- No ESLint configuration detected (`.eslintrc*` files absent)
- TypeScript compiler enforces strict type checking via `tsconfig.json` flags:
  - `strict: true` (all strict checks enabled)
  - `noImplicitAny: true` — all implicit `any` types rejected
  - `strictNullChecks: true` — null/undefined type separation enforced
  - `strictFunctionTypes: true` — function parameter types strictly checked
  - `noImplicitReturns: true` — all code paths must return a value
  - `noUnusedLocals: true` — unused variables cause compile error
  - `noUnusedParameters: true` — unused parameters cause compile error
  - `exactOptionalPropertyTypes: true` — optional properties cannot be assigned `undefined` directly
  - `useUnknownInCatchVariables: true` — catch clause variables typed as `unknown`

## Import Organization

**Order:**
1. Node.js built-in modules (`import crypto from 'node:crypto'`, `import path from 'node:path'`)
2. Third-party packages (`import Fastify from 'fastify'`, `import bcrypt from 'bcrypt'`)
3. Local project imports (`import app from '../app'`, `import { env } from './lib/env'`)
4. Type-only imports from local files (`import type { FastifyInstance }`)

**Path Aliases:**
- Single alias configured: `@/*` → `src/*` (defined in `tsconfig.json`)
- Not heavily used in codebase; relative paths still common
- Example usage (recommended for new code): `import { env } from '@/lib/env'`

**Import Style:**
- Named imports preferred for multiple exports: `import { createUser, getUserById } from '../../services/user'`
- Default imports used for plugin modules: `import app from '../app'`, `export default plugin`
- Type imports use `type` keyword: `import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'`
- Destructuring common for utility functions: `import { build } from '../helper'`

## Error Handling

**Patterns:**
- Service layer returns `null` for not-found or validation failures (e.g., `loginUser` returns `null` if user not found or password invalid)
- Routes check for null and throw HTTP errors via `fastify.httpErrors.*`:
  - `.unauthorized()` — 401
  - `.conflict()` — 409
  - `.notFound()` — 404
- Database constraint errors caught and mapped to HTTP errors (e.g., `Prisma.PrismaClientKnownRequestError` with code `P2002` → 409 Conflict)
- Global error handler in `src/plugins/error-handler.ts` normalizes all errors to `{ error, message, statusCode }` and logs with `this.log.error(error)`
- Error handler catches both known HTTP errors and unexpected errors
- Async functions use try-catch for database operations; thrown errors bubble to handler
- No custom error classes; reliance on Fastify's built-in HTTP error utilities

**Example from `src/routes/auth/index.ts`:**
```typescript
try {
  user = await createUser(request.body)
} catch (err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw fastify.httpErrors.conflict('Email already in use')
  }
  throw err
}
```

## Logging

**Framework:** Fastify's built-in logger (piped via `fastify.log` or `this.log`)

**Patterns:**
- Errors logged via `this.log.error(error)` in error handler
- Server startup errors logged via `server.log.error(error)` in `src/server.ts`
- Log level configurable via `LOG_LEVEL` env var (default: `'info'`)
- Fastify instance configured with logger level in `src/server.ts`:
  ```typescript
  const server = Fastify({
    logger: {
      level: env.LOG_LEVEL
    }
  })
  ```
- Test instances disable logging: `const app = Fastify({ logger: false })`

## Comments

**When to Comment:**
- Minimal commentary observed in codebase
- Comments used to clarify non-obvious logic only
- Plugin file includes doc comment explaining decorator/service split (see `src/plugins/auth.ts` line 26):
  > "Decorators here wrap operations that need the Fastify instance (jwt.sign / request.jwtVerify). Pure DB operations (verifyRefreshToken, revokeRefreshToken, etc.) live in services/ and are imported directly by routes."

**JSDoc/TSDoc:**
- Not used in current codebase
- TypeScript types provide sufficient inline documentation via type annotations

## Function Design

**Size:** 
- Small, single-responsibility functions
- Route handlers 15-40 lines max
- Service functions 5-20 lines max
- Utilities (crypto, hashing) 2-10 lines

**Parameters:**
- Typed input objects for services (e.g., `CreateUserInput`, `LoginUserInput` type aliases)
- Request/reply types passed explicitly in Fastify route generics: `fastify.post<{ Body: RegisterBody }>(...)`
- Avoid many positional arguments; use typed object destructuring

**Return Values:**
- Async functions return Promise-wrapped types: `Promise<User | null>`, `Promise<{ accessToken: string; ... }>`
- Sync functions return primitive types or typed objects
- Null used as "not found" sentinel value in services
- HTTP errors thrown in routes rather than returning error objects

## Module Design

**Exports:**
- Service modules export named functions: `export async function createUser(...) { ... }`
- Plugin modules use default export: `export default fp(async function (...) { ... })`
- Routes use default export: `export default plugin`
- Helper modules export named functions: `export { build }`
- Constants exported as named exports: `export const REFRESH_TOKEN_EXPIRES_DAYS = 7`

**Barrel Files:**
- No barrel files (index.ts re-exports) used in current codebase
- Routes loaded via AutoLoad (no manual barrel files needed)

**Module Patterns:**
- Service modules are pure functions—no class instances
- Plugin modules wrap Fastify instance extensions (decorators, handlers)
- Routes are async plugin functions that register endpoints
- Lib modules export singletons or utilities (`prisma`, `env`)

## Database & Prisma

**Client Usage:**
- Prisma client imported from singleton `src/lib/prisma.ts`
- All database queries use `prisma` directly, no repository/DAO pattern
- Queries include explicit `select` fields where applicable (e.g., excluding passwords from user response)
- Relations use `include` when full related data needed (e.g., `include: { user: true }` for refresh tokens)

**Async/Await:**
- All database calls explicitly awaited
- Services are async functions; routes await service calls

## Type Safety Patterns

**Inline Types for Routes:**
```typescript
type RegisterBody = {
  email: string
  password: string
  name?: string
}

fastify.post<{ Body: RegisterBody }>('/register', { schema: ... }, async (request, reply) => {
  // request.body is typed as RegisterBody
})
```

**Service Input Types:**
```typescript
type CreateUserInput = {
  email: string
  password: string
  name?: string
}

export async function createUser(input: CreateUserInput) { ... }
```

**Fastify Decorators with Module Augmentation:**
```typescript
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>
    generateTokens: (...) => Promise<{ accessToken: string; ... }>
  }
}
```

---

*Convention analysis: 2026-06-25*
