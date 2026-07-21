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
  return prisma.house.create({
    data: { userId: input.userId, name: input.name, address: input.address ?? null }
  })
}

export async function listHouses(userId: bigint): Promise<House[]> {
  return prisma.house.findMany({ where: { userId } })
}

// Non-owner and non-existent both resolve to null → 404, never 403: a 403 would
// confirm the house exists to someone who shouldn't know (HOUSE-05).
export async function getHouse(housePublicId: string, userId: bigint): Promise<House | null> {
  return prisma.house.findFirst({ where: { publicId: housePublicId, userId } })
}

export async function updateHouse(
  housePublicId: string,
  userId: bigint,
  patch: UpdateHousePatch
): Promise<House> {
  // No match (missing, cross-tenant, or soft-deleted via the readGuard) throws P2025 → 404.
  return prisma.house.update({ where: { publicId: housePublicId, userId }, data: patch })
}

export async function deleteHouse(housePublicId: string, userId: bigint): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const house = await tx.house.findFirst({
      where: { publicId: housePublicId, userId },
      select: { id: true }
    })
    if (!house) return false

    // updateMany, not .delete(): the delete→update hook re-dispatches on the
    // un-extended client and would run outside this transaction.
    const now = new Date()
    await tx.device.updateMany({
      where: { houseId: house.id, deletedAt: null },
      data: { deletedAt: now }
    })
    await tx.room.updateMany({
      where: { houseId: house.id, deletedAt: null },
      data: { deletedAt: now }
    })
    await tx.house.updateMany({
      where: { id: house.id, deletedAt: null },
      data: { deletedAt: now }
    })

    return true
  })
}
