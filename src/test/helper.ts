import './env' // must be first — points the app at the test database (see src/test/env.ts)
import Fastify, { type FastifyInstance } from 'fastify'
import appPlugin from '../../app'

async function build (t: { after: (fn: () => void) => void }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(appPlugin)
  t.after(() => app.close())
  return app
}

export { build }
