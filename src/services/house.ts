import type { House } from '../generated/prisma/client'
import { prisma, nullIfNotFound } from '../lib/prisma'
import { softDeleteDeviceStates } from './device'

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
): Promise<House | null> {
  // No match (missing, cross-tenant, or soft-deleted via the readGuard) throws P2025;
  // nullIfNotFound turns that into null so the route renders 404 at its own call site.
  return nullIfNotFound(
    prisma.house.update({ where: { publicId: housePublicId, userId }, data: patch })
  )
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
    // Grab the live devices before soft-deleting them, so their state rows cascade too.
    const devices = await tx.device.findMany({
      where: { houseId: house.id, deletedAt: null },
      select: { id: true, deviceType: true }
    })
    await softDeleteDeviceStates(tx, devices, now)
    // Soft-delete exactly the rows we cascaded state for, not a re-derived houseId set:
    // under READ COMMITTED a device inserted mid-transaction would otherwise be killed
    // without its state row.
    await tx.device.updateMany({
      where: { id: { in: devices.map((device) => device.id) } },
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
