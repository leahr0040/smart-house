import fp from 'fastify-plugin'
import type { FastifyError } from 'fastify'

export default fp(async function (fastify, _opts) {
  fastify.setErrorHandler(function (error: FastifyError, _request, reply) {
    this.log.error(error)

    reply.status(error.statusCode || 500).send({
      error: error.name || 'InternalServerError',
      message: error.message || 'Something went wrong',
      statusCode: error.statusCode || 500
    })
  })
})
