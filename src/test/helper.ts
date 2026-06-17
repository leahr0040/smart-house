import Fastify, { type FastifyInstance } from 'fastify'
import appPlugin from '../../app'

function config () {
  return {
    logger: false
  }
}

async function build (t: { after: (fn: () => void) => void }): Promise<FastifyInstance> {
  const app = Fastify(config())
  await app.register(appPlugin)
  t.after(() => app.close())
  return app
}

export { config, build }
