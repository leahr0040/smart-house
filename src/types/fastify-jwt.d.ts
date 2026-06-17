import type { FastifyRequest, FastifyReply } from 'fastify'
import '@fastify/jwt'

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: number; email: string; name: string | null }
    user: { id: number; email: string; name: string | null }
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<FastifyReply | undefined>
  }
}
