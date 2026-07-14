import type { House } from '../generated/prisma/client'
import { prisma } from '../lib/prisma'

type CreateHouseInput = {
  userId: bigint
  name: string
  address?: string | null
}

type UpdateHousePatch = {
  name?: string
  address?: string
}

export async function createHouse(input: CreateHouseInput): Promise<House> {
  // publicId is minted by the create hook in src/lib/prisma.ts — never set here.
  return prisma.house.create({
    data: { userId: input.userId, name: input.name, address: input.address ?? null }
  })
}

export async function listHouses(userId: bigint): Promise<House[]> {
  // readGuard injects deletedAt:null — soft-deleted houses are excluded for free.
  return prisma.house.findMany({ where: { userId } })
}

// Ownership is embedded in the where clause, so a house owned by someone else is
// indistinguishable from one that does not exist: both return null, and the route
// turns that into a 404 — never a 403, which would confirm the house exists (HOUSE-05).
export async function getHouse(housePublicId: string, userId: bigint): Promise<House | null> {
  return prisma.house.findFirst({ where: { publicId: housePublicId, userId } })
}

export async function updateHouse(
  housePublicId: string,
  userId: bigint,
  patch: UpdateHousePatch
): Promise<House | null> {
  const house = await prisma.house.findFirst({
    where: { publicId: housePublicId, userId },
    select: { id: true }
  })
  if (!house) return null

  // Fields are copied one by one, never spread from the request body — a spread
  // would let a client write userId/deletedAt (mass assignment). Omitted fields
  // are left out of `data` entirely, so PATCH stays partial (D-04).
  const data: { name?: string; address?: string } = {}
  if (patch.name !== undefined) data.name = patch.name
  if (patch.address !== undefined) data.address = patch.address

  return prisma.house.update({ where: { id: house.id }, data })
}

// Cascade soft-delete: the house, its rooms, and its devices — in one transaction (D-07).
//
// updateMany is called DIRECTLY here rather than tx.device.delete()/deleteMany().
// The extension's delete->update conversion re-dispatches through the separately
// captured, un-extended `base` client, which does not join the active transaction,
// so the cascade would silently run outside it. updateMany carries no hook at all,
// so it stays on `tx` end to end.
export async function deleteHouse(housePublicId: string, userId: bigint): Promise<House | null> {
  return prisma.$transaction(async (tx) => {
    const house = await tx.house.findFirst({ where: { publicId: housePublicId, userId } })
    if (!house) return null

    const now = new Date()
    await tx.device.updateMany({ where: { houseId: house.id }, data: { deletedAt: now } })
    await tx.room.updateMany({ where: { houseId: house.id }, data: { deletedAt: now } })
    await tx.house.updateMany({ where: { id: house.id }, data: { deletedAt: now } })

    return house
  })
}
