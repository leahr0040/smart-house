import type { LightState, AcState, HeaterState, SensorState } from '../generated/prisma/client'
import { Prisma } from '../generated/prisma/client'
import { prisma, nullIfNotFound } from '../lib/prisma'

// The result-extended Device (see src/lib/prisma.ts): deviceType is DeviceType, not string.
export type Device = Awaited<ReturnType<typeof prisma.device.findUniqueOrThrow>>

// prisma is client-extended (see src/lib/prisma.ts), so the tx handed to
// $transaction callbacks carries the extension's hooks (publicId minting, readGuard) —
// it is NOT Prisma.TransactionClient (that type is generated against the base,
// unextended client and structurally mismatches under exactOptionalPropertyTypes).
type ExtendedTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export const DeviceType = {
  Light: 'light',
  Ac: 'ac',
  Heater: 'heater',
  Sensor: 'sensor'
} as const
export type DeviceType = (typeof DeviceType)[keyof typeof DeviceType]
export const DEVICE_TYPES = Object.values(DeviceType)

export const isDeviceType = (value: string): value is DeviceType =>
  (DEVICE_TYPES as readonly string[]).includes(value)

// The device's per-type state (table selected by deviceType) resolved to its concrete
// row, tagged so the response producer can narrow without casting.
export type LoadedState =
  | { kind: typeof DeviceType.Light; state: LightState }
  | { kind: typeof DeviceType.Ac; state: AcState }
  | { kind: typeof DeviceType.Heater; state: HeaterState }
  | { kind: typeof DeviceType.Sensor; state: SensorState }

export type DeviceWithState = { device: Device; state: LoadedState }

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

// The device columns shared by every type; the per-type state clause is added by
// createWithState below.
type DeviceBaseData = {
  userId: bigint
  roomId: bigint
  houseId: bigint
  name: string
  deviceType: DeviceType
  manufacturer: string | null
  model: string | null
}

// Explicit, one entry per DeviceType (CLAUDE.md "explicit over magic") — tsc enforces
// exhaustiveness over the DeviceType union, no $allOperations-style catch-all dispatch.
// createWithState inserts the device and its per-type state row in ONE nested create,
// supplying only columns with no schema @default (targetTemp, mode, reading, unit);
// isOn/brightness keep their Phase 1 schema @default values (review F6).
export const deviceStateConfig: Record<
  DeviceType,
  {
    createWithState: (base: DeviceBaseData) => Promise<{ device: Device; state: LoadedState }>
    loadState: (deviceId: bigint) => Promise<LoadedState | null>
    softDeleteState: (
      tx: ExtendedTransactionClient,
      deviceIds: bigint[],
      deletedAt: Date
    ) => Promise<Prisma.BatchPayload>
  }
> = {
  [DeviceType.Light]: {
    createWithState: async (base) => {
      const device = await prisma.device.create({
        data: { ...base, lightState: { create: {} } },
        include: { lightState: true }
      })
      return { device, state: { kind: DeviceType.Light, state: device.lightState! } }
    },
    loadState: async (deviceId) => {
      const state = await prisma.lightState.findUnique({ where: { deviceId } })
      return state ? { kind: DeviceType.Light, state } : null
    },
    softDeleteState: (tx, deviceIds, deletedAt) =>
      tx.lightState.updateMany({ where: { deviceId: { in: deviceIds }, deletedAt: null }, data: { deletedAt } })
  },
  [DeviceType.Ac]: {
    createWithState: async (base) => {
      const device = await prisma.device.create({
        data: { ...base, acState: { create: { targetTemp: 22, mode: 'auto' } } },
        include: { acState: true }
      })
      return { device, state: { kind: DeviceType.Ac, state: device.acState! } }
    },
    loadState: async (deviceId) => {
      const state = await prisma.acState.findUnique({ where: { deviceId } })
      return state ? { kind: DeviceType.Ac, state } : null
    },
    softDeleteState: (tx, deviceIds, deletedAt) =>
      tx.acState.updateMany({ where: { deviceId: { in: deviceIds }, deletedAt: null }, data: { deletedAt } })
  },
  [DeviceType.Heater]: {
    createWithState: async (base) => {
      const device = await prisma.device.create({
        data: { ...base, heaterState: { create: { targetTemp: 20 } } },
        include: { heaterState: true }
      })
      return { device, state: { kind: DeviceType.Heater, state: device.heaterState! } }
    },
    loadState: async (deviceId) => {
      const state = await prisma.heaterState.findUnique({ where: { deviceId } })
      return state ? { kind: DeviceType.Heater, state } : null
    },
    softDeleteState: (tx, deviceIds, deletedAt) =>
      tx.heaterState.updateMany({ where: { deviceId: { in: deviceIds }, deletedAt: null }, data: { deletedAt } })
  },
  [DeviceType.Sensor]: {
    createWithState: async (base) => {
      const device = await prisma.device.create({
        data: { ...base, sensorState: { create: { reading: 0, unit: '' } } },
        include: { sensorState: true }
      })
      return { device, state: { kind: DeviceType.Sensor, state: device.sensorState! } }
    },
    loadState: async (deviceId) => {
      const state = await prisma.sensorState.findUnique({ where: { deviceId } })
      return state ? { kind: DeviceType.Sensor, state } : null
    },
    softDeleteState: (tx, deviceIds, deletedAt) =>
      tx.sensorState.updateMany({ where: { deviceId: { in: deviceIds }, deletedAt: null }, data: { deletedAt } })
  }
}

// Cascade the soft-delete to the devices' per-type state rows (STATE-01). Groups the given
// devices by type, then issues one UPDATE per type PRESENT — a single-type delete hits one
// table, not four; a mixed room hits only the types it actually holds. Each type's
// softDeleteState names its own delegate (deviceStateConfig), so the write stays typed per table.
export function softDeleteDeviceStates(
  tx: ExtendedTransactionClient,
  devices: { id: bigint; deviceType: DeviceType }[],
  deletedAt: Date
) {
  const byType = Object.groupBy(devices, (device) => device.deviceType)
  return Promise.all(
    Object.entries(byType).map(([deviceType, group = []]) =>
      deviceStateConfig[deviceType as DeviceType].softDeleteState(
        tx,
        group.map((device) => device.id),
        deletedAt
      )
    )
  )
}

// The state row is created in the same transaction as the device, so its absence means
// data corruption, not a normal 404 — surface it loudly rather than returning a
// half-device.
async function loadDeviceState(device: Device): Promise<LoadedState> {
  const state = await deviceStateConfig[device.deviceType].loadState(device.id)
  if (!state) throw new Error(`device ${device.publicId} has no ${device.deviceType} state row`)
  return state
}

// Verify the parent room is owned by the caller before inserting (T-2-D01), then create
// the device and its per-type state row (STATE-01) in one nested create — Prisma runs the
// nested write atomically, so a device without its state row is never observable. No
// wrapping $transaction: the ownership read doesn't lock the room, so it earns nothing here.
export async function createDevice(input: CreateDeviceInput): Promise<DeviceWithState | null> {
  const room = await prisma.room.findFirst({
    where: { publicId: input.roomPublicId, userId: input.userId },
    select: { id: true, houseId: true }
  })
  if (!room) return null

  return deviceStateConfig[input.deviceType].createWithState({
    userId: input.userId,
    roomId: room.id,
    houseId: room.houseId,
    name: input.name,
    deviceType: input.deviceType,
    manufacturer: input.manufacturer ?? null,
    model: input.model ?? null
  })
}

// Null means "no such room owned by this user" — the route turns that into 404.
export async function listDevicesByRoom(roomPublicId: string, userId: bigint): Promise<Device[] | null> {
  const room = await prisma.room.findFirst({ where: { publicId: roomPublicId, userId }, select: { id: true } })
  if (!room) return null
  return prisma.device.findMany({ where: { roomId: room.id, userId } })
}

// Queries houseId directly — never joins through rooms (DATA-02).
export async function listDevicesByHouse(housePublicId: string, userId: bigint): Promise<Device[] | null> {
  const house = await prisma.house.findFirst({ where: { publicId: housePublicId, userId }, select: { id: true } })
  if (!house) return null
  return prisma.device.findMany({ where: { houseId: house.id, userId } })
}

export async function getDevice(devicePublicId: string, userId: bigint): Promise<DeviceWithState | null> {
  const device = await prisma.device.findFirst({ where: { publicId: devicePublicId, userId } })
  if (!device) return null
  return { device, state: await loadDeviceState(device) }
}

// Metadata-only (D-05/D-06): never touches deviceType/roomId/houseId.
export async function updateDevice(
  devicePublicId: string,
  userId: bigint,
  patch: UpdateDevicePatch
): Promise<Device | null> {
  return nullIfNotFound(
    prisma.device.update({ where: { publicId: devicePublicId, userId }, data: patch })
  )
}

// The device's per-type state row is its child (STATE-01), so delete cascades to it:
// the guarded update soft-deletes the device (P2025 → null → 404 for missing / cross-tenant
// / already-deleted), then its state row is soft-deleted with the same timestamp. Both
// writes share one transaction so a failure can't leave a live device with a dead state
// (a 500 on the next GET) or vice versa.
export async function deleteDevice(devicePublicId: string, userId: bigint): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const device = await nullIfNotFound(
      tx.device.update({
        where: { publicId: devicePublicId, userId },
        data: { deletedAt: now },
        select: { id: true, deviceType: true }
      })
    )
    if (!device) return false

    await softDeleteDeviceStates(tx, [device], now)
    return true
  })
}
