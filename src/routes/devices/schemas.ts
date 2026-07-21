import { Type, type Static } from '@fastify/type-provider-typebox'
import type { Device } from '../../generated/prisma/client'
import { DEVICE_TYPES } from '../../services/device'

export const DeviceTypeSchema = Type.Union(DEVICE_TYPES.map((t) => Type.Literal(t)))

export const CreateDeviceSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 191 }),
    deviceType: DeviceTypeSchema,
    manufacturer: Type.Optional(Type.String({ maxLength: 191 })),
    model: Type.Optional(Type.String({ maxLength: 191 }))
  },
  { additionalProperties: false }
)
export type CreateDeviceBody = Static<typeof CreateDeviceSchema>

// deviceType intentionally omitted: PATCH is metadata-only, additionalProperties:false
// rejects a deviceType change with 400 (D-06) instead of silently ignoring it.
export const PatchDeviceSchema = Type.Partial(
  Type.Object({
    name: Type.String({ minLength: 1, maxLength: 191 }),
    manufacturer: Type.String({ maxLength: 191 }),
    model: Type.String({ maxLength: 191 })
  }),
  { additionalProperties: false }
)
export type PatchDeviceBody = Static<typeof PatchDeviceSchema>

export const RoomDevicesParamsSchema = Type.Object({
  roomPublicId: Type.String()
})
export type RoomDevicesParams = Static<typeof RoomDevicesParamsSchema>

export const HouseDevicesParamsSchema = Type.Object({
  housePublicId: Type.String()
})
export type HouseDevicesParams = Static<typeof HouseDevicesParamsSchema>

export const DeviceParamsSchema = Type.Object({
  devicePublicId: Type.String()
})
export type DeviceParams = Static<typeof DeviceParamsSchema>

// No id/stateId field: fast-json-stringify then structurally can't leak the internal
// BigInt id or the morph state pointer (F3).
export const DeviceResponseSchema = Type.Object(
  {
    publicId: Type.String(),
    name: Type.String(),
    deviceType: DeviceTypeSchema,
    manufacturer: Type.Union([Type.String(), Type.Null()]),
    model: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String()
  },
  { additionalProperties: false }
)
export type DeviceResponse = Static<typeof DeviceResponseSchema>

export const DeviceListResponseSchema = Type.Array(DeviceResponseSchema)

// Producer for the schema above — kept adjacent so the two can't drift.
export const toDeviceResponse = (device: Device): DeviceResponse => ({
  publicId: device.publicId,
  name: device.name,
  deviceType: device.deviceType as DeviceResponse['deviceType'],
  manufacturer: device.manufacturer,
  model: device.model,
  createdAt: device.createdAt.toISOString(),
  updatedAt: device.updatedAt.toISOString()
})
