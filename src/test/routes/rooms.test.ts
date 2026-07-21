import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import { build } from '../helper'
import { closeDb, resetDb, createTwoTestUsers, seedHouse, seedRoom, seedDevice } from '../helpers/fixtures'
import { prisma, prismaRaw } from '../../lib/prisma'

beforeEach(resetDb)
after(closeDb)

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` }
}

test('POST /houses/:housePublicId/rooms creates a room owned by the caller', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)

  const res = await app.inject({
    method: 'POST',
    url: `/houses/${house.publicId}/rooms`,
    headers: authHeader(userA.token),
    payload: { name: 'Living Room', floor: 1, roomType: 'living' }
  })

  assert.strictEqual(res.statusCode, 201)
  const body = JSON.parse(res.payload)
  assert.strictEqual(body.name, 'Living Room')
  assert.strictEqual(body.floor, 1)
  assert.strictEqual(body.roomType, 'living')
  assert.strictEqual(typeof body.publicId, 'string')
  assert.ok(!('id' in body), 'response must not expose the internal id')
})

test('GET /houses/:housePublicId/rooms lists only rooms in that house', async (t) => {
  const app = await build(t)
  const { userA, userB } = await createTwoTestUsers(app)
  const houseA = await seedHouse(userA.userId)
  const houseB = await seedHouse(userB.userId)

  const roomA = await seedRoom(userA.userId, houseA.id)
  await seedRoom(userB.userId, houseB.id)

  const res = await app.inject({
    method: 'GET',
    url: `/houses/${houseA.publicId}/rooms`,
    headers: authHeader(userA.token)
  })

  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.payload) as Array<Record<string, unknown>>
  assert.ok(Array.isArray(body), 'list response must be a bare array (D-02)')

  const mine = body.find((r) => r.publicId === roomA.publicId)
  assert.ok(mine, 'the caller\'s own room must appear in the list')
  assert.ok(!('id' in mine), 'response must not expose the internal id')
})

test('GET /rooms/:roomPublicId returns the room for its owner', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id, { name: 'Kitchen', floor: 0, roomType: 'kitchen' })

  const res = await app.inject({
    method: 'GET',
    url: `/rooms/${room.publicId}`,
    headers: authHeader(userA.token)
  })

  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.strictEqual(body.publicId, room.publicId)
  assert.strictEqual(body.name, 'Kitchen')
  assert.strictEqual(body.floor, 0)
  assert.strictEqual(body.roomType, 'kitchen')
  assert.ok(!('id' in body))
})

test('PATCH /rooms/:roomPublicId updates only the given fields', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id, { name: 'Old Name', floor: 2, roomType: 'office' })

  const res = await app.inject({
    method: 'PATCH',
    url: `/rooms/${room.publicId}`,
    headers: authHeader(userA.token),
    payload: { name: 'New Name' }
  })

  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.strictEqual(body.name, 'New Name')
  assert.strictEqual(body.floor, 2, 'omitted fields must remain untouched')
  assert.strictEqual(body.roomType, 'office', 'omitted fields must remain untouched')
})

test('DELETE /rooms/:roomPublicId soft-deletes and excludes the room from subsequent reads (TEST-05)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)

  const deleteRes = await app.inject({
    method: 'DELETE',
    url: `/rooms/${room.publicId}`,
    headers: authHeader(userA.token)
  })
  assert.strictEqual(deleteRes.statusCode, 204)
  assert.strictEqual(deleteRes.payload, '', 'DELETE must return an empty body')

  const listRes = await app.inject({
    method: 'GET',
    url: `/houses/${house.publicId}/rooms`,
    headers: authHeader(userA.token)
  })
  const listBody = JSON.parse(listRes.payload)
  assert.ok(
    !listBody.some((r: { publicId: string }) => r.publicId === room.publicId),
    'soft-deleted room must be excluded from GET /houses/:housePublicId/rooms'
  )

  const getRes = await app.inject({
    method: 'GET',
    url: `/rooms/${room.publicId}`,
    headers: authHeader(userA.token)
  })
  assert.strictEqual(getRes.statusCode, 404, 'soft-deleted room must be excluded from GET /rooms/:id')
})

test('POST /houses/:housePublicId/rooms against a house owned by another user returns 404 (parent-ownership bypass, ROOM-01)', async (t) => {
  const app = await build(t)
  const { userA, userB } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)

  const res = await app.inject({
    method: 'POST',
    url: `/houses/${house.publicId}/rooms`,
    headers: authHeader(userB.token),
    payload: { name: 'Intruder Room' }
  })
  assert.strictEqual(res.statusCode, 404)

  const rooms = await prismaRaw.room.findMany({ where: { houseId: house.id } })
  assert.strictEqual(rooms.length, 0, 'no orphan room must be created under a foreign house')
})

test('cross-tenant access to another user\'s room returns 404, not 403 (TEST-01)', async (t) => {
  const app = await build(t)
  const { userA, userB } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)

  const getRes = await app.inject({
    method: 'GET',
    url: `/rooms/${room.publicId}`,
    headers: authHeader(userB.token)
  })
  assert.strictEqual(getRes.statusCode, 404)

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/rooms/${room.publicId}`,
    headers: authHeader(userB.token),
    payload: { name: 'Hijacked' }
  })
  assert.strictEqual(patchRes.statusCode, 404)

  const deleteRes = await app.inject({
    method: 'DELETE',
    url: `/rooms/${room.publicId}`,
    headers: authHeader(userB.token)
  })
  assert.strictEqual(deleteRes.statusCode, 404)

  const stillThere = await prisma.room.findUnique({ where: { publicId: room.publicId } })
  assert.ok(stillThere, 'cross-tenant requests must not mutate a room they do not own')
  assert.strictEqual(stillThere?.name, room.name)
})

test('every /rooms and /houses/:housePublicId/rooms route returns 401 without a valid JWT (TEST-08)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)

  const cases: Array<{ method: 'POST' | 'GET' | 'PATCH' | 'DELETE'; url: string; payload: Record<string, unknown> }> = [
    { method: 'POST', url: `/houses/${house.publicId}/rooms`, payload: { name: 'Nope' } },
    { method: 'GET', url: `/houses/${house.publicId}/rooms`, payload: {} },
    { method: 'GET', url: `/rooms/${room.publicId}`, payload: {} },
    { method: 'PATCH', url: `/rooms/${room.publicId}`, payload: {} },
    { method: 'DELETE', url: `/rooms/${room.publicId}`, payload: {} }
  ]

  for (const c of cases) {
    const noToken = await app.inject({ method: c.method, url: c.url, payload: c.payload })
    assert.strictEqual(noToken.statusCode, 401, `${c.method} ${c.url} without a token must 401`)

    const invalidToken = await app.inject({
      method: c.method,
      url: c.url,
      payload: c.payload,
      headers: { authorization: 'Bearer definitelyfake' }
    })
    assert.strictEqual(invalidToken.statusCode, 401, `${c.method} ${c.url} with an invalid token must 401`)
  }
})

test('DELETE /rooms/:roomPublicId cascades a soft-delete to its devices atomically (ROOM-04)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)
  await seedDevice(userA.userId, room.id, house.id)
  await seedDevice(userA.userId, room.id, house.id)

  const res = await app.inject({
    method: 'DELETE',
    url: `/rooms/${room.publicId}`,
    headers: authHeader(userA.token)
  })
  assert.strictEqual(res.statusCode, 204)

  // prismaRaw, not prisma: the guarded client hides soft-deleted rows, so it can't tell
  // a cascade from a hard delete — this proves the rows survive with deletedAt set.
  const rawRoom = await prismaRaw.room.findFirst({ where: { id: room.id } })
  const rawDevices = await prismaRaw.device.findMany({ where: { roomId: room.id } })

  assert.ok(rawRoom?.deletedAt, 'the room itself must be soft-deleted')
  assert.strictEqual(rawDevices.length, 2, 'both devices must still exist (soft, not hard, delete)')
  assert.ok(rawDevices.every((d) => d.deletedAt !== null), 'every cascaded device must have deletedAt set')

  const guardedDevices = await prisma.device.findMany({ where: { roomId: room.id } })
  assert.strictEqual(guardedDevices.length, 0, 'cascaded devices must be excluded from guarded reads')
})
