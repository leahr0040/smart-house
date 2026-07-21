import type { Device } from '../generated/prisma/client'
import { Prisma } from '../generated/prisma/client'

export const DEVICE_TYPES = ['light', 'ac', 'heater', 'sensor'] as const
export type DeviceType = (typeof DEVICE_TYPES)[number]

type CreateDeviceInput = {
  roomPublicId: string
  userId: bigint
  name: string
  deviceType: DeviceType
  manufacturer?: string | null
  model?: string | null
}

type UpdateDevicePatch = {
  name?: string
  manufacturer?: string
  model?: string
}

// Explicit, one entry per DeviceType (CLAUDE.md "explicit over magic") — tsc enforces
// exhaustiveness over the DeviceType union, no $allOperations-style catch-all dispatch.
// Each createDefaults supplies ONLY columns with no schema @default (targetTemp, mode,
// reading, unit); isOn/brightness keep their Phase 1 schema @default values (review F6).
export const deviceStateConfig: Record<
  DeviceType,
  {
    model: Extract<Prisma.ModelName, 'LightState' | 'AcState' | 'HeaterState' | 'SensorState'>
    createDefaults: (tx: Prisma.TransactionClient, deviceId: bigint) => Promise<{ id: bigint }>
  }
> = {
  light: {
    model: 'LightState',
    createDefaults: (tx, deviceId) => tx.lightState.create({ data: { deviceId }, select: { id: true } })
  },
  ac: {
    model: 'AcState',
    createDefaults: (tx, deviceId) =>
      tx.acState.create({ data: { deviceId, targetTemp: 22, mode: 'auto' }, select: { id: true } })
  },
  heater: {
    model: 'HeaterState',
    createDefaults: (tx, deviceId) =>
      tx.heaterState.create({ data: { deviceId, targetTemp: 20 }, select: { id: true } })
  },
  sensor: {
    model: 'SensorState',
    createDefaults: (tx, deviceId) =>
      tx.sensorState.create({ data: { deviceId, reading: 0, unit: '' }, select: { id: true } })
  }
}

// Bodies filled in Task 3 (green). Params are prefixed `_` until then so the strict
// tsconfig's noUnusedParameters doesn't fail the scaffold build.
export async function createDevice(_input: CreateDeviceInput): Promise<Device | null> {
  throw new Error('not implemented')
}

export async function listDevicesByRoom(_roomPublicId: string, _userId: bigint): Promise<Device[] | null> {
  throw new Error('not implemented')
}

export async function listDevicesByHouse(_housePublicId: string, _userId: bigint): Promise<Device[] | null> {
  throw new Error('not implemented')
}

export async function getDevice(_devicePublicId: string, _userId: bigint): Promise<Device | null> {
  throw new Error('not implemented')
}

export async function updateDevice(
  _devicePublicId: string,
  _userId: bigint,
  _patch: UpdateDevicePatch
): Promise<Device | null> {
  throw new Error('not implemented')
}

export async function deleteDevice(_devicePublicId: string, _userId: bigint): Promise<boolean> {
  throw new Error('not implemented')
}
