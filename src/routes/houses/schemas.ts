import { Type, type Static } from '@fastify/type-provider-typebox'

export const CreateHouseSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 191 }),
    address: Type.Optional(Type.String({ maxLength: 191 }))
  },
  { additionalProperties: false }
)
export type CreateHouseBody = Static<typeof CreateHouseSchema>

// PATCH: Type.Partial(...) — no hand-rolled optional fields (D-04)
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

// publicId + safe metadata ONLY — no internal `id` field, so fast-json-stringify
// structurally cannot serialize the BigInt id even if a handler ever leaked it (review F3).
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
