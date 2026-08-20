import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import { faker } from '@faker-js/faker'
import { build } from '../helper'
import { closeDb, resetDb, createTwoTestUsers, seedHouse, seedRoom, seedDevice, DEVICE_TYPES } from '../helpers/fixtures'
import { prisma, prismaRaw } from '../../lib/prisma'

beforeEach(resetDb)
after(closeDb)

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` }
}

const STATE_MODEL: Record<(typeof DEVICE_TYPES)[number], 'lightState' | 'acState' | 'heaterState' | 'sensorState'> = {
  light: 'lightState',
  ac: 'acState',
  heater: 'heaterState',
  sensor: 'sensorState'
}

test('POST /rooms/:roomPublicId/devices creates a device owned by the caller', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)

  const res = await app.inject({
    method: 'POST',
    url: `/rooms/${room.publicId}/devices`,
    headers: authHeader(userA.token),
    payload: { name: 'Living Room Light', deviceType: 'light', manufacturer: 'Philips', model: 'Hue' }
  })

  assert.strictEqual(res.statusCode, 201)
  const body = JSON.parse(res.payload)
  assert.strictEqual(typeof body.publicId, 'string')
  assert.strictEqual(body.name, 'Living Room Light')
  assert.strictEqual(body.deviceType, 'light')
  assert.strictEqual(body.manufacturer, 'Philips')
  assert.strictEqual(body.model, 'Hue')
  assert.ok(!('id' in body), 'response must not expose the internal id')
})

test('device create inserts exactly one matching per-type state row with defaults (STATE-01)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)

  for (const deviceType of DEVICE_TYPES) {
    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${room.publicId}/devices`,
      headers: authHeader(userA.token),
      payload: { name: `Test ${deviceType}`, deviceType }
    })
    assert.strictEqual(res.statusCode, 201, `create ${deviceType} must succeed`)
    const body = JSON.parse(res.payload)

    const device = await prisma.device.findUnique({ where: { publicId: body.publicId } })
    assert.ok(device, 'device row must exist')

    const delegate = prisma[STATE_MODEL[deviceType]] as unknown as {
      findUnique: (args: { where: { deviceId: bigint } }) => Promise<Record<string, unknown> | null>
    }
    const state = await delegate.findUnique({ where: { deviceId: device!.id } })
    assert.ok(state, `${deviceType} must have exactly one matching state row`)

    if (deviceType === 'light') {
      assert.strictEqual(state?.isOn, false)
      assert.strictEqual(state?.brightness, 0)
    } else if (deviceType === 'ac') {
      assert.strictEqual(state?.isOn, false)
      assert.strictEqual(state?.mode, 'auto')
      assert.strictEqual(state?.targetTemp, 22)
    } else if (deviceType === 'heater') {
      assert.strictEqual(state?.isOn, false)
      assert.strictEqual(state?.targetTemp, 20)
    } else {
      assert.strictEqual(Number(state?.reading), 0)
      assert.strictEqual(state?.unit, '')
    }
  }
})

test('POST and GET /devices/:id return the per-type state (STATE-01)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)

  const expected: Record<(typeof DEVICE_TYPES)[number], Record<string, unknown>> = {
    light: { isOn: false, brightness: 0 },
    ac: { isOn: false, targetTemp: 22, mode: 'auto' },
    heater: { isOn: false, targetTemp: 20 },
    sensor: { reading: 0, unit: '' }
  }

  for (const deviceType of DEVICE_TYPES) {
    const postRes = await app.inject({
      method: 'POST',
      url: `/rooms/${room.publicId}/devices`,
      headers: authHeader(userA.token),
      payload: { name: `State ${deviceType}`, deviceType }
    })
    assert.strictEqual(postRes.statusCode, 201, `create ${deviceType}`)
    const created = JSON.parse(postRes.payload)
    // deepStrictEqual over the whole object: proves the union serialized exactly the
    // right keys for this type and no others (no bleed across state shapes).
    assert.deepStrictEqual(created.state, expected[deviceType], `POST ${deviceType} state`)

    const getRes = await app.inject({
      method: 'GET',
      url: `/devices/${created.publicId}`,
      headers: authHeader(userA.token)
    })
    assert.strictEqual(getRes.statusCode, 200)
    assert.deepStrictEqual(JSON.parse(getRes.payload).state, expected[deviceType], `GET ${deviceType} state`)
  }
})

test('POST /rooms/:roomPublicId/devices with an unknown device_type returns 400 (DEV-05)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)

  const res = await app.inject({
    method: 'POST',
    url: `/rooms/${room.publicId}/devices`,
    headers: authHeader(userA.token),
    payload: { name: 'Mystery Device', deviceType: 'toaster' }
  })

  assert.strictEqual(res.statusCode, 400)
})

test('GET /rooms/:roomPublicId/devices lists only devices in that room', async (t) => {
  const app = await build(t)
  const { userA, userB } = await createTwoTestUsers(app)
  const houseA = await seedHouse(userA.userId)
  const houseB = await seedHouse(userB.userId)
  const roomA = await seedRoom(userA.userId, houseA.id)
  const roomB = await seedRoom(userB.userId, houseB.id)

  const deviceA = await seedDevice(userA.userId, roomA.id, houseA.id, 'light')
  await seedDevice(userB.userId, roomB.id, houseB.id, 'light')

  const res = await app.inject({
    method: 'GET',
    url: `/rooms/${roomA.publicId}/devices`,
    headers: authHeader(userA.token)
  })

  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.payload) as Array<Record<string, unknown>>
  assert.ok(Array.isArray(body), 'list response must be a bare array (D-02)')
  assert.strictEqual(body.length, 1)
  assert.strictEqual(body[0]?.publicId, deviceA.publicId)
})

test('GET /houses/:housePublicId/devices aggregates devices across rooms via houseId (DATA-02)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room1 = await seedRoom(userA.userId, house.id)
  const room2 = await seedRoom(userA.userId, house.id)

  const device1 = await seedDevice(userA.userId, room1.id, house.id, 'light')
  const device2 = await seedDevice(userA.userId, room2.id, house.id, 'ac')

  const res = await app.inject({
    method: 'GET',
    url: `/houses/${house.publicId}/devices`,
    headers: authHeader(userA.token)
  })

  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.payload) as Array<Record<string, unknown>>
  const ids = body.map((d) => d.publicId)
  assert.ok(ids.includes(device1.publicId), 'device from room1 must be included')
  assert.ok(ids.includes(device2.publicId), 'device from room2 must be included')
  assert.strictEqual(body.length, 2)
})

test('GET /devices/:devicePublicId returns the device for its owner', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)
  const device = await seedDevice(userA.userId, room.id, house.id, 'sensor', { name: 'Hallway Sensor' })

  const res = await app.inject({
    method: 'GET',
    url: `/devices/${device.publicId}`,
    headers: authHeader(userA.token)
  })

  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.strictEqual(body.publicId, device.publicId)
  assert.strictEqual(body.name, 'Hallway Sensor')
  assert.strictEqual(body.deviceType, 'sensor')
})

test('PATCH /devices/:devicePublicId updates only metadata fields', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)
  const device = await seedDevice(userA.userId, room.id, house.id, 'light', {
    name: 'Old Name',
    manufacturer: 'OldCo',
    model: 'X1'
  })

  const res = await app.inject({
    method: 'PATCH',
    url: `/devices/${device.publicId}`,
    headers: authHeader(userA.token),
    payload: { name: 'New Name' }
  })

  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.strictEqual(body.name, 'New Name')
  assert.strictEqual(body.manufacturer, 'OldCo', 'omitted fields must remain untouched')
  assert.strictEqual(body.model, 'X1', 'omitted fields must remain untouched')
  assert.strictEqual(body.deviceType, 'light')
})

test('PATCH /devices/:devicePublicId cannot change device_type (D-06)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)
  const device = await seedDevice(userA.userId, room.id, house.id, 'light')

  const res = await app.inject({
    method: 'PATCH',
    url: `/devices/${device.publicId}`,
    headers: authHeader(userA.token),
    payload: { name: 'Renamed', deviceType: 'ac' }
  })

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(JSON.parse(res.payload).name, 'Renamed', 'the allowed field must apply')

  const raw = await prismaRaw.device.findUnique({ where: { publicId: device.publicId } })
  assert.strictEqual(raw?.deviceType, 'light', 'device_type must be immutable via PATCH')
})

test('DELETE /devices/:devicePublicId soft-deletes the device and cascades to its state (TEST-05)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)
  const device = await seedDevice(userA.userId, room.id, house.id, 'light')

  const deleteRes = await app.inject({
    method: 'DELETE',
    url: `/devices/${device.publicId}`,
    headers: authHeader(userA.token)
  })
  assert.strictEqual(deleteRes.statusCode, 204)
  assert.strictEqual(deleteRes.payload, '', 'DELETE must return an empty body')

  const getRes = await app.inject({
    method: 'GET',
    url: `/devices/${device.publicId}`,
    headers: authHeader(userA.token)
  })
  assert.strictEqual(getRes.statusCode, 404, 'soft-deleted device must be excluded from GET /devices/:id')

  const listRes = await app.inject({
    method: 'GET',
    url: `/rooms/${room.publicId}/devices`,
    headers: authHeader(userA.token)
  })
  const listBody = JSON.parse(listRes.payload)
  assert.ok(
    !listBody.some((d: { publicId: string }) => d.publicId === device.publicId),
    'soft-deleted device must be excluded from GET /rooms/:roomPublicId/devices'
  )

  // prismaRaw, not prisma: the guarded client hides soft-deleted rows, so it can't tell
  // a soft-delete from a hard delete — this proves the leaf row survives with deletedAt set (review F1).
  const rawDevice = await prismaRaw.device.findFirst({ where: { id: device.id } })
  assert.ok(rawDevice, 'the device row must still exist after DELETE')
  assert.ok(rawDevice?.deletedAt, 'the device row must have deletedAt set')

  // The state row is the device's child — delete must cascade to it (soft, not hard).
  const rawState = await prismaRaw.lightState.findFirst({ where: { deviceId: device.id } })
  assert.ok(rawState, 'the state row must still exist after cascade (soft, not hard, delete)')
  assert.ok(rawState?.deletedAt, 'the state row must have deletedAt set by the cascade')
})

test('POST /rooms/:roomPublicId/devices against a room owned by another user returns 404 (parent-ownership bypass)', async (t) => {
  const app = await build(t)
  const { userA, userB } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)

  const res = await app.inject({
    method: 'POST',
    url: `/rooms/${room.publicId}/devices`,
    headers: authHeader(userB.token),
    payload: { name: 'Intruder Device', deviceType: 'light' }
  })
  assert.strictEqual(res.statusCode, 404)

  const devices = await prismaRaw.device.findMany({ where: { roomId: room.id } })
  assert.strictEqual(devices.length, 0, 'no orphan device must be created under a foreign room')
})

test('cross-tenant access to another user\'s device returns 404, not 403 (TEST-01)', async (t) => {
  const app = await build(t)
  const { userA, userB } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)
  const device = await seedDevice(userA.userId, room.id, house.id, 'light')

  const getRes = await app.inject({
    method: 'GET',
    url: `/devices/${device.publicId}`,
    headers: authHeader(userB.token)
  })
  assert.strictEqual(getRes.statusCode, 404)

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/devices/${device.publicId}`,
    headers: authHeader(userB.token),
    payload: { name: 'Hijacked' }
  })
  assert.strictEqual(patchRes.statusCode, 404)

  const deleteRes = await app.inject({
    method: 'DELETE',
    url: `/devices/${device.publicId}`,
    headers: authHeader(userB.token)
  })
  assert.strictEqual(deleteRes.statusCode, 404)

  const stillThere = await prisma.device.findUnique({ where: { publicId: device.publicId } })
  assert.ok(stillThere, 'cross-tenant requests must not mutate a device they do not own')
  assert.strictEqual(stillThere?.name, device.name)
})

test('a device row with an unknown device_type fails loudly on read (VARCHAR→union guard)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)

  // Plant a corrupt row via the un-extended client, bypassing the API union validation
  // and the minting/guard extension, to prove the seam rejects it on the way back out.
  const bogusType = faker.string.alpha(8) // letters only: safe to interpolate into the assertion regex
  const corrupt = await prismaRaw.device.create({
    data: {
      publicId: faker.string.alphanumeric(21),
      userId: userA.userId,
      roomId: room.id,
      houseId: house.id,
      name: faker.commerce.productName(),
      deviceType: bogusType
    }
  })

  // The guard lives in a lazy compute getter, so it fires on access, not on the await.
  const found = await prisma.device.findUnique({ where: { id: corrupt.id } })
  assert.throws(() => found!.deviceType, new RegExp(`unknown device_type ${bogusType}`))

  const getRes = await app.inject({
    method: 'GET',
    url: `/devices/${corrupt.publicId}`,
    headers: authHeader(userA.token)
  })
  assert.strictEqual(getRes.statusCode, 500, 'the route surfaces the corruption, not a half-typed device')
})

test('every device route returns 401 without a valid JWT (TEST-08)', async (t) => {
  const app = await build(t)
  const { userA } = await createTwoTestUsers(app)
  const house = await seedHouse(userA.userId)
  const room = await seedRoom(userA.userId, house.id)
  const device = await seedDevice(userA.userId, room.id, house.id, 'light')

  const cases: Array<{ method: 'POST' | 'GET' | 'PATCH' | 'DELETE'; url: string; payload: Record<string, unknown> }> = [
    { method: 'POST', url: `/rooms/${room.publicId}/devices`, payload: { name: 'Nope', deviceType: 'light' } },
    { method: 'GET', url: `/rooms/${room.publicId}/devices`, payload: {} },
    { method: 'GET', url: `/houses/${house.publicId}/devices`, payload: {} },
    { method: 'GET', url: `/devices/${device.publicId}`, payload: {} },
    { method: 'PATCH', url: `/devices/${device.publicId}`, payload: {} },
    { method: 'DELETE', url: `/devices/${device.publicId}`, payload: {} }
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
