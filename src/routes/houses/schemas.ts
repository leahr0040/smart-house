import { Type, type Static } from '@fastify/type-provider-typebox'
import type { House } from '../../generated/prisma/client'

export const CreateHouseSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 191 }),
    address: Type.Optional(Type.String({ maxLength: 191 }))
  },
  { additionalProperties: false }
)
export type CreateHouseBody = Static<typeof CreateHouseSchema>

export const PatchHouseSchema = Type.Partial(
  Type.Object({
    name: Type.String({ minLength: 1, maxLength: 191 }),
    address: Type.String({ maxLength: 191 })
  }),
  { additionalProperties: false }
)
export type PatchHouseBody = Static<typeof PatchHouseSchema>

export const HouseParamsSchema = Type.Object({
  housePublicId: Type.String()
})
export type HouseParams = Static<typeof HouseParamsSchema>

// No id field: fast-json-stringify then structurally can't leak the internal BigInt id (F3).
export const HouseResponseSchema = Type.Object(
  {
    publicId: Type.String(),
    name: Type.String(),
    address: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String()
  },
  { additionalProperties: false }
)
export type HouseResponse = Static<typeof HouseResponseSchema>

export const HouseListResponseSchema = Type.Array(HouseResponseSchema)

// Producer for the schema above — kept adjacent so the two can't drift.
export const toHouseResponse = (house: House): HouseResponse => ({
  publicId: house.publicId,
  name: house.name,
  address: house.address,
  createdAt: house.createdAt.toISOString(),
  updatedAt: house.updatedAt.toISOString()
})
