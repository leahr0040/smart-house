import '../env' // must be first (see src/test/env.ts)
import { faker } from '@faker-js/faker'
import type { FastifyInstance } from 'fastify'
import { prisma, prismaRaw } from '../../lib/prisma'

// Prisma's pool keeps the event loop alive; without this every DB-touching file hangs
// instead of exiting. Each such file must `after(closeDb)`.
export async function closeDb(): Promise<void> {
  await prismaRaw.$disconnect()
}

// relationMode="prisma" → no DB-level FKs, so truncation order is irrelevant.
const TABLES = [
  'events',
  'command_targets',
  'commands',
  'light_states',
  'ac_states',
  'heater_states',
  'sensor_states',
  'devices',
  'rooms',
  'houses',
  'refresh_tokens',
  'users'
] as const

export async function resetDb(): Promise<void> {
  for (const table of TABLES) {
    await prismaRaw.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``)
  }
}

// uuid suffix: users.email is @unique and faker's pool repeats, so faker alone collides (P2002).
export function uniqueEmail(): string {
  const local = faker.internet.username().replace(/[^a-zA-Z0-9._-]/g, '')
  return `${local}.${faker.string.uuid()}@example.test`.toLowerCase()
}

export const DEVICE_TYPES = ['light', 'ac', 'heater', 'sensor'] as const
export type DeviceType = (typeof DEVICE_TYPES)[number]

export type TestUser = {
  token: string
  userId: bigint
  email: string
  password: string
}

export async function createTestUser(
  app: FastifyInstance,
  overrides: Partial<{ email: string; password: string; name: string }> = {}
): Promise<TestUser> {
  const email = overrides.email ?? uniqueEmail()
  const password = overrides.password ?? faker.internet.password({ length: 16 })
  const name = overrides.name ?? faker.person.fullName()

  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password, name }
  })

  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`createTestUser: register failed (${res.statusCode}): ${res.payload}`)
  }

  const { accessToken } = JSON.parse(res.payload) as { accessToken: string }

  // Look the id up rather than read it off the payload: the payload exposes Number(id),
  // which loses precision and is the very leak this phase removes. Factories need the bigint.
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } })
  if (!user) {
    throw new Error(`createTestUser: user ${email} not found after register`)
  }

  return { token: accessToken, userId: user.id, email, password }
}

export async function createTwoTestUsers(app: FastifyInstance): Promise<{
  userA: TestUser
  userB: TestUser
}> {
  return {
    userA: await createTestUser(app),
    userB: await createTestUser(app)
  }
}

export async function seedHouse(
  userId: bigint,
  overrides: Partial<{ name: string; address: string | null }> = {}
) {
  return prisma.house.create({
    data: {
      userId,
      name: overrides.name ?? `${faker.person.lastName()} House`,
      address: overrides.address ?? faker.location.streetAddress()
    }
  })
}

export async function seedRoom(
  userId: bigint,
  houseId: bigint,
  overrides: Partial<{ name: string; floor: number; roomType: string | null }> = {}
) {
  return prisma.room.create({
    data: {
      userId,
      houseId,
      name:
        overrides.name ??
        faker.helpers.arrayElement([
          'Living Room',
          'Kitchen',
          'Bedroom',
          'Bathroom',
          'Office',
          'Garage'
        ]),
      floor: overrides.floor ?? faker.number.int({ min: 0, max: 3 }),
      roomType: overrides.roomType ?? null
    }
  })
}

export async function seedDevice(
  userId: bigint,
  roomId: bigint,
  houseId: bigint,
  deviceType: DeviceType = 'light',
  overrides: Partial<{ name: string; manufacturer: string | null; model: string | null }> = {}
) {
  return prisma.device.create({
    data: {
      userId,
      roomId,
      houseId,
      deviceType,
      name: overrides.name ?? `${faker.commerce.productAdjective()} ${deviceType}`,
      manufacturer: overrides.manufacturer ?? faker.company.name(),
      model: overrides.model ?? faker.string.alphanumeric(6).toUpperCase()
    }
  })
}
