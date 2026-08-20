import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@fastify/type-provider-typebox'
import {
  CreateDeviceSchema,
  PatchDeviceSchema,
  RoomDevicesParamsSchema,
  HouseDevicesParamsSchema,
  DeviceParamsSchema,
  DeviceResponseSchema,
  DeviceListResponseSchema,
  DeviceDetailResponseSchema,
  toDeviceResponse,
  toDeviceDetailResponse
} from './schemas'
import {
  createDevice,
  listDevicesByRoom,
  listDevicesByHouse,
  getDevice,
  updateDevice,
  deleteDevice
} from '../../services/device'

// Without this, AutoLoad would mount every route below under /devices/devices.
export const prefixOverride = ''

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post('/rooms/:roomPublicId/devices', {
    preHandler: fastify.authenticate,
    schema: { params: RoomDevicesParamsSchema, body: CreateDeviceSchema, response: { 201: DeviceDetailResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const result = await createDevice({
      roomPublicId: request.params.roomPublicId,
      userId,
      name: request.body.name,
      deviceType: request.body.deviceType,
      manufacturer: request.body.manufacturer ?? null,
      model: request.body.model ?? null
    })
    if (!result) throw fastify.httpErrors.notFound()
    reply.code(201).send(toDeviceDetailResponse(result.device, result.state))
  })

  fastify.get('/rooms/:roomPublicId/devices', {
    preHandler: fastify.authenticate,
    schema: { params: RoomDevicesParamsSchema, response: { 200: DeviceListResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const devices = await listDevicesByRoom(request.params.roomPublicId, userId)
    if (!devices) throw fastify.httpErrors.notFound()
    reply.send(devices.map(toDeviceResponse))
  })

  fastify.get('/houses/:housePublicId/devices', {
    preHandler: fastify.authenticate,
    schema: { params: HouseDevicesParamsSchema, response: { 200: DeviceListResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const devices = await listDevicesByHouse(request.params.housePublicId, userId)
    if (!devices) throw fastify.httpErrors.notFound()
    reply.send(devices.map(toDeviceResponse))
  })

  fastify.get('/devices/:devicePublicId', {
    preHandler: fastify.authenticate,
    schema: { params: DeviceParamsSchema, response: { 200: DeviceDetailResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const result = await getDevice(request.params.devicePublicId, userId)
    if (!result) throw fastify.httpErrors.notFound()
    reply.send(toDeviceDetailResponse(result.device, result.state))
  })

  fastify.patch('/devices/:devicePublicId', {
    preHandler: fastify.authenticate,
    schema: { params: DeviceParamsSchema, body: PatchDeviceSchema, response: { 200: DeviceResponseSchema } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const device = await updateDevice(request.params.devicePublicId, userId, request.body)
    if (!device) throw fastify.httpErrors.notFound()
    reply.send(toDeviceResponse(device))
  })

  fastify.delete('/devices/:devicePublicId', {
    preHandler: fastify.authenticate,
    schema: { params: DeviceParamsSchema, response: { 204: Type.Null() } }
  }, async (request, reply) => {
    const userId = BigInt(request.user.id)
    const deleted = await deleteDevice(request.params.devicePublicId, userId)
    if (!deleted) throw fastify.httpErrors.notFound()
    reply.code(204).send(null)
  })
}

export default plugin
