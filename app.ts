import path from 'node:path'
import { type FastifyInstance } from 'fastify'
import AutoLoad from '@fastify/autoload'
import cookie from '@fastify/cookie'

export default async function (fastify: FastifyInstance, opts: Record<string, unknown>) {
  fastify.register(cookie)

  fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'src/plugins'),
    options: { ...opts }
  })

  fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'src/routes'),
    options: { ...opts }
  })
}
