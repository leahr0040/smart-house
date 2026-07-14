import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import { build } from '../helper'
import { closeDb, resetDb, createTestUser } from '../helpers/fixtures'
import { prisma } from '../../lib/prisma'

beforeEach(resetDb)
after(closeDb)

// TEST-05 (auth clause). readGuard injects `deletedAt: null` into user lookups,
// so loginUser's findUnique cannot see a soft-deleted row. This locks in that
// pre-existing behavior: deleting a user must actually revoke their ability to
// authenticate, not merely hide them from listings.
test('a soft-deleted user cannot log in', async (t) => {
  const app = await build(t)
  const { userId, email, password } = await createTestUser(app)

  // Sanity: the account works before deletion, so a 401 afterwards can only be
  // caused by the soft delete.
  const before = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password }
  })
  assert.strictEqual(before.statusCode, 200, 'login should succeed before deletion')

  // The extension rewrites delete -> update { deletedAt }, so the row survives.
  await prisma.user.delete({ where: { id: userId } })

  const afterDelete = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password }
  })

  assert.strictEqual(afterDelete.statusCode, 401, 'soft-deleted user must not authenticate')
})

test('soft delete hides the user from reads but keeps the row', async (t) => {
  const app = await build(t)
  const { userId, email } = await createTestUser(app)

  await prisma.user.delete({ where: { id: userId } })

  // Guarded read: gone.
  const guarded = await prisma.user.findUnique({ where: { email } })
  assert.strictEqual(guarded, null, 'readGuard must exclude soft-deleted rows')

  // Escape hatch (caller mentions deletedAt): still there, with a timestamp.
  const raw = await prisma.user.findFirst({
    where: { email, deletedAt: { not: null } },
    select: { id: true, deletedAt: true }
  })
  assert.ok(raw, 'the row must still exist (soft, not hard, delete)')
  assert.ok(raw.deletedAt instanceof Date, 'deletedAt must be stamped')
})
