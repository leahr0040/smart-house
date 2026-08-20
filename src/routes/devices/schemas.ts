import { Type, type Static } from '@fastify/type-provider-typebox'
import { DeviceType, DEVICE_TYPES, type Device, type LoadedState } from '../../services/device'

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

// deviceType omitted: PATCH is metadata-only, so ajv strips a deviceType change before
// it reaches the update — the type stays immutable (D-06).
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

// No id field: fast-json-stringify then structurally can't leak the internal BigInt id (F3).
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
  deviceType: device.deviceType,
  manufacturer: device.manufacturer,
  model: device.model,
  createdAt: device.createdAt.toISOString(),
  updatedAt: device.updatedAt.toISOString()
})

// Per-type state shapes. Distinct required keys + additionalProperties:false let
// fast-json-stringify pick the right union member from the row alone (no discriminator).
const LightStateResponseSchema = Type.Object(
  { isOn: Type.Boolean(), brightness: Type.Integer() },
  { additionalProperties: false }
)
const AcStateResponseSchema = Type.Object(
  { isOn: Type.Boolean(), targetTemp: Type.Integer(), mode: Type.String() },
  { additionalProperties: false }
)
const HeaterStateResponseSchema = Type.Object(
  { isOn: Type.Boolean(), targetTemp: Type.Integer() },
  { additionalProperties: false }
)
const SensorStateResponseSchema = Type.Object(
  { reading: Type.Number(), unit: Type.String() },
  { additionalProperties: false }
)

export const DeviceStateSchema = Type.Union([
  LightStateResponseSchema,
  AcStateResponseSchema,
  HeaterStateResponseSchema,
  SensorStateResponseSchema
])

// GET /devices/:id and POST return the device plus its resolved morph state; the lists don't.
export const DeviceDetailResponseSchema = Type.Composite([
  DeviceResponseSchema,
  Type.Object({ state: DeviceStateSchema })
])
export type DeviceDetailResponse = Static<typeof DeviceDetailResponseSchema>

const toStateResponse = (loaded: LoadedState): Static<typeof DeviceStateSchema> => {
  switch (loaded.kind) {
    case DeviceType.Light:
      return { isOn: loaded.state.isOn, brightness: loaded.state.brightness }
    case DeviceType.Ac:
      return { isOn: loaded.state.isOn, targetTemp: loaded.state.targetTemp, mode: loaded.state.mode }
    case DeviceType.Heater:
      return { isOn: loaded.state.isOn, targetTemp: loaded.state.targetTemp }
    case DeviceType.Sensor:
      // Decimal(6,2) → number: max 9999.99, well within float precision.
      return { reading: Number(loaded.state.reading), unit: loaded.state.unit }
  }
}

export const toDeviceDetailResponse = (device: Device, loaded: LoadedState): DeviceDetailResponse => ({
  ...toDeviceResponse(device),
  state: toStateResponse(loaded)
})
