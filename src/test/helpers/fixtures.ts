import '../env' // must be first — points prisma at the test database (see src/test/env.ts)
import { faker } from '@faker-js/faker'
import type { FastifyInstance } from 'fastify'
import { prisma, prismaRaw } from '../../lib/prisma'

// Prisma's connection pool keeps the event loop alive, so a DB-touching test
// file runs green and then hangs forever instead of exiting. Every DB-touching
// test file must release the pool: `after(closeDb)`.
export async function closeDb(): Promise<void> {
  await prismaRaw.$disconnect()
}

// Every table, listed explicitly (CLAUDE.md: explicit over magic — a new model
// must be added here deliberately, not discovered by reflection at runtime).
// relationMode="prisma" means MariaDB holds no FK constraints, so truncation
// order is irrelevant and no FOREIGN_KEY_CHECKS toggle is needed.
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

// Wipes the TEST database between tests so no test can see another's rows.
// Uses prismaRaw: the extended client's hooks are about soft-delete/publicId
// semantics and have nothing to say about raw DDL.
export async function resetDb(): Promise<void> {
  for (const table of TABLES) {
    await prismaRaw.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``)
  }
}

// Faker's name/email pools are small and repeat often, and `users.email` is
// @unique — so faker alone would eventually collide (P2002) across runs. The
// uuid suffix makes the address collision-proof while keeping it readable in
// failure output: realism comes from faker, uniqueness from the uuid.
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

// --- Factories -------------------------------------------------------------
// Each takes its required foreign keys positionally and everything else as
// overrides, so a test states only what it actually cares about and the rest is
// plausible-but-irrelevant data.

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

  // Resolve the bigint id with a direct lookup rather than reading it off the
  // register payload: that payload exposes Number(user.id) — the internal-id
  // leak this phase exists to remove — and yields a JS number, not the bigint
  // the seed factories need for foreign keys.
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } })
  if (!user) {
    throw new Error(`createTestUser: user ${email} not found after register`)
  }

  return { token: accessToken, userId: user.id, email, password }
}

// Two independent tenants — the setup every cross-tenant isolation test needs.
export async function createTwoTestUsers(app: FastifyInstance): Promise<{
  userA: TestUser
  userB: TestUser
}> {
  return {
    userA: await createTestUser(app),
    userB: await createTestUser(app)
  }
}

// The seed factories write parent/child rows straight through prisma so a
// slice's tests never depend on a sibling slice's routes existing.
// publicId is minted by the create hook — never passed in here.

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
