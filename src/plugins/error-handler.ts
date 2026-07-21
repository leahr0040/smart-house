import fp from 'fastify-plugin'
import type { FastifyError } from 'fastify'

export default fp(async function (fastify, _opts) {
  fastify.setErrorHandler(function (error: FastifyError, _request, reply) {
    this.log.error(error)

    // "Not found / not owned" is decided at the service call site (nullIfNotFound → 404),
    // not here — so a P2025 that reaches this handler is a genuine 500, not a 404.
    reply.status(error.statusCode || 500).send({
      error: error.name || 'InternalServerError',
      message: error.message || 'Something went wrong',
      statusCode: error.statusCode || 500
    })
  })
})

