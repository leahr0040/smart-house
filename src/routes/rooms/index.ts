import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@fastify/type-provider-typebox'
import {
  CreateRoomSchema,
  PatchRoomSchema,
  HouseRoomsParamsSchema,
  RoomParamsSchema,
  RoomResponseSchema,
  RoomListResponseSchema,
  toRoomResponse
} from './schemas'
import { createRoom, listRooms, getRoom, updateRoom, deleteRoom } from '../../services/room'

// Without this, AutoLoad would mount every route below under /rooms/rooms.
export const prefixOverride = ''

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post('/houses/:housePublicId/rooms', {
    preHandler: fastify.authenticate,
    schema: { params: HouseRoomsParamsSchema, body: CreateRoomSchema, response: { 201: RoomResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const room = await createRoom({
      housePublicId: request.params.housePublicId,
      userId,
      name: request.body.name,
      floor: request.body.floor,
      roomType: request.body.roomType ?? null
    })
    if (!room) throw fastify.httpErrors.notFound()
    reply.code(201).send(toRoomResponse(room))
  })

  fastify.get('/houses/:housePublicId/rooms', {
    preHandler: fastify.authenticate,
    schema: { params: HouseRoomsParamsSchema, response: { 200: RoomListResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const rooms = await listRooms(request.params.housePublicId, userId)
    if (!rooms) throw fastify.httpErrors.notFound()
    reply.send(rooms.map(toRoomResponse))
  })

  fastify.get('/rooms/:roomPublicId', {
    preHandler: fastify.authenticate,
    schema: { params: RoomParamsSchema, response: { 200: RoomResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const room = await getRoom(request.params.roomPublicId, userId)
    if (!room) throw fastify.httpErrors.notFound()
    reply.send(toRoomResponse(room))
  })

  fastify.patch('/rooms/:roomPublicId', {
    preHandler: fastify.authenticate,
    schema: { params: RoomParamsSchema, body: PatchRoomSchema, response: { 200: RoomResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const room = await updateRoom(request.params.roomPublicId, userId, request.body)
    if (!room) throw fastify.httpErrors.notFound()
    reply.send(toRoomResponse(room))
  })

  fastify.delete('/rooms/:roomPublicId', {
    preHandler: fastify.authenticate,
    schema: { params: RoomParamsSchema, response: { 204: Type.Null() } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const deleted = await deleteRoom(request.params.roomPublicId, userId)
    if (!deleted) throw fastify.httpErrors.notFound()
    reply.code(204).send(null)
  })
}

export default plugin
