import fp from 'fastify-plugin'
import type { FastifyError } from 'fastify'
import { Prisma } from '../generated/prisma/client'

export default fp(async function (fastify, _opts) {
  fastify.setErrorHandler(function (error: FastifyError, _request, reply) {
    this.log.error(error)

    // The guarded update/delete raises P2025 on a missing/cross-tenant/soft-deleted row → 404.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      reply.status(404).send({ error: 'NotFound', message: 'Resource not found', statusCode: 404 })
      return
    }

    reply.status(error.statusCode || 500).send({
      error: error.name || 'InternalServerError',
      message: error.message || 'Something went wrong',
      statusCode: error.statusCode || 500
    })
  })
})
