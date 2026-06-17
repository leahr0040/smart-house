import Fastify from 'fastify'
import app from '../app'

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
})

async function start () {
  await server.register(app)

  await server.listen({
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || '127.0.0.1'
  })
}

start().catch((error: unknown) => {
  server.log.error(error)
  process.exit(1)
})
