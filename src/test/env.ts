import path from 'node:path'
import dotenv from 'dotenv'

// Must be imported before anything that pulls in src/lib/env.ts: that does
// `import 'dotenv/config'` at load, and dotenv won't overwrite an already-set var, so
// override:true here is what actually points the app at the test DB and not the dev one.
// Gated on the flag, not on DATABASE_URL presence, so a stray shell DATABASE_URL is still overridden locally.
if (!process.env.USE_TESTCONTAINER_DB) {
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
}
