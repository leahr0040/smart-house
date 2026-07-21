import { Type, type Static } from '@fastify/type-provider-typebox'
import type { Room } from '../../generated/prisma/client'

export const CreateRoomSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 191 }),
    floor: Type.Optional(Type.Integer()),
    roomType: Type.Optional(Type.String({ maxLength: 191 }))
  },
  { additionalProperties: false }
)
export type CreateRoomBody = Static<typeof CreateRoomSchema>

export const PatchRoomSchema = Type.Partial(
  Type.Object({
    name: Type.String({ minLength: 1, maxLength: 191 }),
    floor: Type.Integer(),
    roomType: Type.String({ maxLength: 191 })
  }),
  { additionalProperties: false }
)
export type PatchRoomBody = Static<typeof PatchRoomSchema>

export const HouseRoomsParamsSchema = Type.Object({
  housePublicId: Type.String()
})
export type HouseRoomsParams = Static<typeof HouseRoomsParamsSchema>

export const RoomParamsSchema = Type.Object({
  roomPublicId: Type.String()
})
export type RoomParams = Static<typeof RoomParamsSchema>

// No id/houseId field: fast-json-stringify then structurally can't leak the internal BigInt id (F3).
export const RoomResponseSchema = Type.Object(
  {
    publicId: Type.String(),
    name: Type.String(),
    floor: Type.Integer(),
    roomType: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String()
  },
  { additionalProperties: false }
)
export type RoomResponse = Static<typeof RoomResponseSchema>

export const RoomListResponseSchema = Type.Array(RoomResponseSchema)

// Producer for the schema above — kept adjacent so the two can't drift.
export const toRoomResponse = (room: Room): RoomResponse => ({
  publicId: room.publicId,
  name: room.name,
  floor: room.floor,
  roomType: room.roomType,
  createdAt: room.createdAt.toISOString(),
  updatedAt: room.updatedAt.toISOString()
})
