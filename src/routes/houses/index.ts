import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@fastify/type-provider-typebox'
import {
  CreateHouseSchema,
  PatchHouseSchema,
  HouseParamsSchema,
  HouseResponseSchema,
  HouseListResponseSchema
} from './schemas'
import { createHouse, listHouses, getHouse, updateHouse, deleteHouse } from '../../services/house'

// AutoLoad prefixes routes by directory name (this file lives at src/routes/houses/),
// so without this override every route below would be mounted under /houses/houses.
// Routes here declare their own absolute paths instead — do not delete this export.
export const prefixOverride = ''

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post('/houses', {
    preHandler: fastify.authenticate,
    schema: { body: CreateHouseSchema, response: { 201: HouseResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const house = await createHouse({ userId, name: request.body.name, address: request.body.address ?? null })
    reply.code(201).send({
      publicId: house.publicId,
      name: house.name,
      address: house.address,
      createdAt: house.createdAt.toISOString(),
      updatedAt: house.updatedAt.toISOString()
    })
  })

  fastify.get('/houses', {
    preHandler: fastify.authenticate,
    schema: { response: { 200: HouseListResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const houses = await listHouses(userId)
    reply.send(houses.map((house) => ({
      publicId: house.publicId,
      name: house.name,
      address: house.address,
      createdAt: house.createdAt.toISOString(),
      updatedAt: house.updatedAt.toISOString()
    })))
  })

  fastify.get('/houses/:housePublicId', {
    preHandler: fastify.authenticate,
    schema: { params: HouseParamsSchema, response: { 200: HouseResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const house = await getHouse(request.params.housePublicId, userId)
    if (!house) throw fastify.httpErrors.notFound()
    reply.send({
      publicId: house.publicId,
      name: house.name,
      address: house.address,
      createdAt: house.createdAt.toISOString(),
      updatedAt: house.updatedAt.toISOString()
    })
  })

  fastify.patch('/houses/:housePublicId', {
    preHandler: fastify.authenticate,
    schema: { params: HouseParamsSchema, body: PatchHouseSchema, response: { 200: HouseResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const house = await updateHouse(request.params.housePublicId, userId, request.body)
    if (!house) throw fastify.httpErrors.notFound()
    reply.send({
      publicId: house.publicId,
      name: house.name,
      address: house.address,
      createdAt: house.createdAt.toISOString(),
      updatedAt: house.updatedAt.toISOString()
    })
  })

  fastify.delete('/houses/:housePublicId', {
    preHandler: fastify.authenticate,
    schema: { params: HouseParamsSchema, response: { 204: Type.Null() } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const house = await deleteHouse(request.params.housePublicId, userId)
    if (!house) throw fastify.httpErrors.notFound()
    reply.code(204).send(null)
  })
}

export default plugin
