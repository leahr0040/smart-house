# AGENTS.md — smart-house

## Rules

Before implementing anything:
- **Bug**: explain root cause, suggest few solutions with trade-offs, wait for approval.
- **Feature**: propose an architecture plan, wait for approval.
Never go straight to code.
- Don't guard against empty/null/undefined values unless there's a specific business reason. Keep validation minimal. Assume callers pass valid data.
- **DB columns**: snake_case in database, camelCase in Prisma client via `@map` / `@@map`. Multi-word fields need explicit `@map` (e.g. `tokenHash @map("token_hash")`). Table names use `@@map` (e.g. `@@map("refresh_tokens")`). Single-word fields need no `@map`.
- **FK indexes**: every foreign key field must have an `@@index(...)` on the model (e.g. `@@index([userId])`).

## Commands

| Action | Command |
|--------|---------|
| Dev server | `npm run dev` — `tsx watch src/server.ts` |
| Build | `npm run build` (tsc) |
| Test all | `npm test` — `tsc && node --test dist/src/test/**/*.test.js` |
| Prisma generate | `npm run prisma:generate` — outputs to `src/generated/prisma/` |
| Prisma migrate | `npm run prisma:migrate` |
| Prisma studio | `npm run prisma:studio` |

Tests use Node built-in runner (`node:test` + `node:assert`), live as `.ts` in `src/test/`. Helper at `src/test/helper.ts` builds a Fastify instance for `app.inject()` HTTP tests.

## Architecture

- **Not fastify-cli.** `src/server.ts` manually bootstraps Fastify and registers `app.ts` plugin. Dev uses `tsx watch`, prod runs compiled `dist/src/server.js`.
- **app.ts** registers `@fastify/cookie`, then auto-loads `src/plugins/` and `src/routes/` via `@fastify/autoload`.
- **DB**: Prisma 7 + MariaDB via `@prisma/adapter-mariadb`. Config in `prisma.config.ts` (Prisma 7 `defineConfig`). Client generated to `src/generated/prisma/`; import from `../../generated/prisma/client`.
- **Auth flow**: JWT access token (15min, stateless) + refresh token rotation (7-day httpOnly cookie, path `/auth`). Decorators on `fastify`: `authenticate`, `generateTokens`, `verifyRefreshToken`, `revokeRefreshToken`. Implemented in `src/plugins/auth.ts`.
- **Validation**: Fastify JSON Schema via `schema` option on routes (e.g. `src/routes/auth/schemas.ts`), **not** Zod.
- **Error handling**: Custom handler in `src/plugins/error-handler.ts` returns `{ error, message, statusCode }`. `@fastify/sensible` provides `httpErrors` helpers.
- **Env**: `dotenv` loaded; required vars `JWT_SECRET`, `DATABASE_URL`.

## Conventions

- Routes export default async Fastify plugin functions. Sub-directories with `index.ts` work as route modules.
- Plugins use `fastify-plugin` (`fp`) wrapper to break encapsulation.
- All source `.ts` under `src/`, tests `.ts` under `src/test/`. Path alias `@/*` → `src/*`.
- `tsconfig.json` is very strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`.
- Schema has two models: `User` + `RefreshToken` (with FK index on `userId`).
