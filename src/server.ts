import Fastify from 'fastify'
import app from '../app'
import { env } from './lib/env'

const server = Fastify({
  logger: {
    level: env.LOG_LEVEL
  }
})

async function start () {
  await server.register(app)

  await server.listen({
    port: env.PORT,
    host: env.HOST
  })
}

start().catch((error: unknown) => {
  server.log.error(error)
  process.exit(1)
})
