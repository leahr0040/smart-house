import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@fastify/type-provider-typebox'
import {
  CreateHouseSchema,
  PatchHouseSchema,
  HouseParamsSchema,
  HouseResponseSchema,
  HouseListResponseSchema,
  toHouseResponse
} from './schemas'
import { createHouse, listHouses, getHouse, updateHouse, deleteHouse } from '../../services/house'

// Without this, AutoLoad would mount every route below under /houses/houses.
export const prefixOverride = ''

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post('/houses', {
    preHandler: fastify.authenticate,
    schema: { body: CreateHouseSchema, response: { 201: HouseResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const house = await createHouse({ userId, name: request.body.name, address: request.body.address ?? null })
    reply.code(201).send(toHouseResponse(house))
  })

  fastify.get('/houses', {
    preHandler: fastify.authenticate,
    schema: { response: { 200: HouseListResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const houses = await listHouses(userId)
    reply.send(houses.map(toHouseResponse))
  })

  fastify.get('/houses/:housePublicId', {
    preHandler: fastify.authenticate,
    schema: { params: HouseParamsSchema, response: { 200: HouseResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const house = await getHouse(request.params.housePublicId, userId)
    if (!house) throw fastify.httpErrors.notFound()
    reply.send(toHouseResponse(house))
  })

  fastify.patch('/houses/:housePublicId', {
    preHandler: fastify.authenticate,
    schema: { params: HouseParamsSchema, body: PatchHouseSchema, response: { 200: HouseResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const house = await updateHouse(request.params.housePublicId, userId, request.body)
    if (!house) throw fastify.httpErrors.notFound()
    reply.send(toHouseResponse(house))
  })

  fastify.delete('/houses/:housePublicId', {
    preHandler: fastify.authenticate,
    schema: { params: HouseParamsSchema, response: { 204: Type.Null() } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const deleted = await deleteHouse(request.params.housePublicId, userId)
    if (!deleted) throw fastify.httpErrors.notFound()
    reply.code(204).send(null)
  })
}

export default plugin
