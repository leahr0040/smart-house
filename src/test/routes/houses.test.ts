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

test('POST /houses creates a house owned by the caller', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)

  const res = await app.inject({
    method: 'POST',
    url: '/houses',
    headers: authHeader(userA.token),
    payload: { name: 'Beach House', address: '1 Ocean Ave' }
  })

  assert.strictEqual(res.statusCode, 201)
  const body = JSON.parse(res.payload)
  assert.strictEqual(body.name, 'Beach House')
  assert.strictEqual(body.address, '1 Ocean Ave')
  assert.strictEqual(typeof body.publicId, 'string')
  assert.ok(!('id' in body), 'response must not expose the internal id')
})

test('GET /houses lists only the caller\'s own houses', async (t) => {
  const app = await build(t)
  const { userA, userB } = await createTwoTestUsers(app)

  const houseA = await seedHouse(userA.userId)
  const houseB = await seedHouse(userB.userId)

  const res = await app.inject({
    method: 'GET',
    url: '/houses',
    headers: authHeader(userA.token)
  })

  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.payload) as Array<Record<string, unknown>>
  assert.ok(Array.isArray(body), 'list response must be a bare array (D-02)')

  // Scoped to the rows this test created — the suite runs against the shared dev
  // DB, so an absolute row count would be asserting on unrelated leftovers.
  const mine = body.find((h) => h.publicId === houseA.publicId)
  assert.ok(mine, 'the caller\'s own house must appear in the list')
  assert.ok(!('id' in mine), 'response must not expose the internal id')
  assert.ok(
    !body.some((h) => h.publicId === houseB.publicId),
    'another user\'s house must never appear in the list'
  )
})

test('GET /houses/:housePublicId returns the house for its owner', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId, { name: 'Cabin', address: 'Woods Rd' })

  const res = await app.inject({
    method: 'GET',
    url: `/houses/${house.publicId}`,
    headers: authHeader(userA.token)
  })

  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.strictEqual(body.publicId, house.publicId)
  assert.strictEqual(body.name, 'Cabin')
  assert.strictEqual(body.address, 'Woods Rd')
  assert.ok(!('id' in body))
})

test('PATCH /houses/:housePublicId updates only the given fields', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId, { name: 'Old Name', address: 'Old Address' })

  const res = await app.inject({
    method: 'PATCH',
    url: `/houses/${house.publicId}`,
    headers: authHeader(userA.token),
    payload: { name: 'New Name' }
  })

  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.strictEqual(body.name, 'New Name')
  assert.strictEqual(body.address, 'Old Address', 'omitted fields must remain untouched')
})

test('DELETE /houses/:housePublicId soft-deletes and excludes the house from subsequent reads', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)

  const deleteRes = await app.inject({
    method: 'DELETE',
    url: `/houses/${house.publicId}`,
    headers: authHeader(userA.token)
  })
  assert.strictEqual(deleteRes.statusCode, 204)
  assert.strictEqual(deleteRes.payload, '', 'DELETE must return an empty body')

  const listRes = await app.inject({
    method: 'GET',
    url: '/houses',
    headers: authHeader(userA.token)
  })
  const listBody = JSON.parse(listRes.payload)
  assert.ok(
    !listBody.some((h: { publicId: string }) => h.publicId === house.publicId),
    'soft-deleted house must be excluded from GET /houses (TEST-05)'
  )

  const getRes = await app.inject({
    method: 'GET',
    url: `/houses/${house.publicId}`,
    headers: authHeader(userA.token)
  })
  assert.strictEqual(getRes.statusCode, 404, 'soft-deleted house must be excluded from GET /houses/:id (TEST-05)')
})

test('cross-tenant access to another user\'s house returns 404, not 403', async (t) => {
  const app = await build(t)
  const { userA, userB } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)

  const getRes = await app.inject({
    method: 'GET',
    url: `/houses/${house.publicId}`,
    headers: authHeader(userB.token)
  })
  assert.strictEqual(getRes.statusCode, 404)

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/houses/${house.publicId}`,
    headers: authHeader(userB.token),
    payload: { name: 'Hijacked' }
  })
  assert.strictEqual(patchRes.statusCode, 404)

  const deleteRes = await app.inject({
    method: 'DELETE',
    url: `/houses/${house.publicId}`,
    headers: authHeader(userB.token)
  })
  assert.strictEqual(deleteRes.statusCode, 404)

  // The house must still exist and be untouched — a cross-tenant 404 must not
  // have side-effected a delete/update.
  const stillThere = await prisma.house.findUnique({ where: { publicId: house.publicId } })
  assert.ok(stillThere, 'cross-tenant requests must not mutate a house they do not own')
  assert.strictEqual(stillThere?.name, house.name)
})

test('every /houses route returns 401 without a valid JWT (TEST-08)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)

  const cases: Array<{ method: 'POST' | 'GET' | 'PATCH' | 'DELETE'; url: string; payload: Record<string, unknown> }> = [
    { method: 'POST', url: '/houses', payload: { name: 'Nope' } },
    { method: 'GET', url: '/houses', payload: {} },
    { method: 'GET', url: `/houses/${house.publicId}`, payload: {} },
    { method: 'PATCH', url: `/houses/${house.publicId}`, payload: {} },
    { method: 'DELETE', url: `/houses/${house.publicId}`, payload: {} }
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

test('DELETE /houses/:housePublicId cascades a soft-delete to its rooms and devices atomically (HOUSE-04)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)

  const house = await seedHouse(userA.userId)
  const room1 = await seedRoom(userA.userId, house.id)
  const room2 = await seedRoom(userA.userId, house.id)
  await seedDevice(userA.userId, room1.id, house.id)
  await seedDevice(userA.userId, room2.id, house.id)

  const res = await app.inject({
    method: 'DELETE',
    url: `/houses/${house.publicId}`,
    headers: authHeader(userA.token)
  })
  assert.strictEqual(res.statusCode, 204)

  // Read through prismaRaw (the un-extended client): the extended `prisma`'s readGuard
  // auto-injects deletedAt:null and would return an empty set whether the rows were
  // cascaded or never existed at all — a false green. prismaRaw proves the rows still
  // exist and are soft- (not hard-) deleted.
  const rawRooms = await prismaRaw.room.findMany({ where: { houseId: house.id } })
  const rawDevices = await prismaRaw.device.findMany({ where: { houseId: house.id } })

  assert.strictEqual(rawRooms.length, 2, 'both rooms must still exist (soft, not hard, delete)')
  assert.ok(rawRooms.every((r) => r.deletedAt !== null), 'every cascaded room must have deletedAt set')

  assert.strictEqual(rawDevices.length, 2, 'both devices must still exist (soft, not hard, delete)')
  assert.ok(rawDevices.every((d) => d.deletedAt !== null), 'every cascaded device must have deletedAt set')

  // Excluded from reads through the readGuard-protected client — the layer any future
  // /rooms, /devices route reads through.
  const guardedRooms = await prisma.room.findMany({ where: { houseId: house.id } })
  const guardedDevices = await prisma.device.findMany({ where: { houseId: house.id } })
  assert.strictEqual(guardedRooms.length, 0, 'cascaded rooms must be excluded from guarded reads')
  assert.strictEqual(guardedDevices.length, 0, 'cascaded devices must be excluded from guarded reads')
})
