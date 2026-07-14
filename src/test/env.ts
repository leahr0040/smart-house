import path from 'node:path'
import dotenv from 'dotenv'

// Tests run against a dedicated database, never the dev one — the suite truncates
// every table between tests (see resetDb in helpers/fixtures.ts), which would wipe
// dev data if DATABASE_URL still pointed at it.
//
// `override: true` matters: src/lib/env.ts does `import 'dotenv/config'` at module
// load, and dotenv does NOT overwrite variables that are already set. This module
// must therefore be imported BEFORE anything that pulls in src/lib/env.ts (the app,
// the prisma client) — helper.ts and helpers/fixtures.ts both import it first.
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
