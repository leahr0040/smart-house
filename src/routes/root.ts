import { FastifyPluginAsync } from 'fastify'

const plugin: FastifyPluginAsync = async function (fastify) {
  fastify.get('/', async function () {
    return { root: true }
  })
}

export default plugin
