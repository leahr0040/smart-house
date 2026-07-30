import type { Room } from '../generated/prisma/client'
import { prisma, nullIfNotFound } from '../lib/prisma'
import { cascadeSoftDeleteDevices } from './device'

type CreateRoomInput = {
  housePublicId: string
  userId: bigint
  name: string
  floor?: number | undefined
  roomType?: string | null
}

type UpdateRoomPatch = {
  name?: string
  floor?: number
  roomType?: string
}

// Verify the parent house is owned by the caller before inserting — a room under a
// house the caller doesn't own must 404, not be created (ROOM-01). No transaction: a
// single write has nothing to make atomic, and without FOR UPDATE it wouldn't close
// the parent-deleted-mid-insert race anyway.
export async function createRoom(input: CreateRoomInput): Promise<Room | null> {
  const house = await prisma.house.findFirst({
    where: { publicId: input.housePublicId, userId: input.userId },
    select: { id: true }
  })
  if (!house) return null

  return prisma.room.create({
    data: {
      userId: input.userId,
      houseId: house.id,
      name: input.name,
      ...(input.floor !== undefined ? { floor: input.floor } : {}),
      roomType: input.roomType ?? null
    }
  })
}

// Null means "no such house owned by this user" — the route turns that into 404,
// same as a cross-tenant room lookup (no 403 leak).
export async function listRooms(housePublicId: string, userId: bigint): Promise<Room[] | null> {
  const house = await prisma.house.findFirst({ where: { publicId: housePublicId, userId }, select: { id: true } })
  if (!house) return null
  return prisma.room.findMany({ where: { houseId: house.id, userId } })
}

export async function getRoom(roomPublicId: string, userId: bigint): Promise<Room | null> {
  return prisma.room.findFirst({ where: { publicId: roomPublicId, userId } })
}

export async function updateRoom(
  roomPublicId: string,
  userId: bigint,
  patch: UpdateRoomPatch
): Promise<Room | null> {
  // No match (missing, cross-tenant, or soft-deleted via the readGuard) throws P2025;
  // nullIfNotFound turns that into null so the route renders 404 at its own call site.
  return nullIfNotFound(
    prisma.room.update({ where: { publicId: roomPublicId, userId }, data: patch })
  )
}

export async function deleteRoom(roomPublicId: string, userId: bigint): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findFirst({
      where: { publicId: roomPublicId, userId },
      select: { id: true }
    })
    if (!room) return false

    // updateMany, not .delete(): the delete→update hook re-dispatches on the
    // un-extended client and would run outside this transaction.
    const now = new Date()
    await cascadeSoftDeleteDevices(tx, { roomId: room.id }, now)
    await tx.room.updateMany({
      where: { id: room.id, deletedAt: null },
      data: { deletedAt: now }
    })

    return true
  })
}
