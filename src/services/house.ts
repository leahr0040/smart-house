import type { House } from '../generated/prisma/client'

type CreateHouseInput = {
  userId: bigint
  name: string
  address?: string | null
}

type UpdateHousePatch = {
  name?: string
  address?: string
}

// Bodies filled in Task 3 (green). Params are prefixed `_` until then so the
// strict tsconfig's noUnusedParameters doesn't fail the scaffold build.
export async function createHouse(_input: CreateHouseInput): Promise<House> {
  throw new Error('not implemented')
}

export async function listHouses(_userId: bigint): Promise<House[]> {
  throw new Error('not implemented')
}

export async function getHouse(_housePublicId: string, _userId: bigint): Promise<House | null> {
  throw new Error('not implemented')
}

export async function updateHouse(
  _housePublicId: string,
  _userId: bigint,
  _patch: UpdateHousePatch
): Promise<House | null> {
  throw new Error('not implemented')
}

export async function deleteHouse(_housePublicId: string, _userId: bigint): Promise<House | null> {
  throw new Error('not implemented')
}
