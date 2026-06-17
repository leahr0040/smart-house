import { test } from 'node:test'
import assert from 'node:assert'
import Fastify from 'fastify'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Support = require('../../plugins/support')

test('support works standalone', async () => {
  const fastify = Fastify()
  fastify.register(Support)

  await fastify.ready()
  assert.equal((fastify as any).someSupport(), 'hugs')
})
