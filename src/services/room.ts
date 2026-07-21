import type { Room } from '../generated/prisma/client'

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

export async function createRoom(_input: CreateRoomInput): Promise<Room | null> {
  throw new Error('not implemented')
}

export async function listRooms(_housePublicId: string, _userId: bigint): Promise<Room[] | null> {
  throw new Error('not implemented')
}

export async function getRoom(_roomPublicId: string, _userId: bigint): Promise<Room | null> {
  throw new Error('not implemented')
}

export async function updateRoom(
  _roomPublicId: string,
  _userId: bigint,
  _patch: UpdateRoomPatch
): Promise<Room | null> {
  throw new Error('not implemented')
}

export async function deleteRoom(_roomPublicId: string, _userId: bigint): Promise<boolean> {
  throw new Error('not implemented')
}
