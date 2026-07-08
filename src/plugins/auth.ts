import fp from 'fastify-plugin'
import type { FastifyRequest } from 'fastify'
import jwt from '@fastify/jwt'
import { generateRefreshToken } from '../services/refresh-token'
import { env } from '../lib/env'

const ACCESS_TOKEN_EXPIRES_MINUTES = 15

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>
    generateTokens: (user: { id: bigint; email: string; name: string | null }) => Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: {
      id: number
      email: string
      name: string | null
    }
  }
}

// Decorators here wrap operations that need the Fastify instance (jwt.sign / request.jwtVerify).
// Pure DB operations (verifyRefreshToken, revokeRefreshToken, etc.) live in services/ and are imported directly by routes.
export default fp(async function (fastify, _opts) {
  fastify.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: `${ACCESS_TOKEN_EXPIRES_MINUTES}m` }
  })

  fastify.decorate('authenticate', async function (request: FastifyRequest) {
    await request.jwtVerify()
  })

  fastify.decorate('generateTokens', async function (user: { id: bigint; email: string; name: string | null }) {
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_EXPIRES_MINUTES * 60 * 1000).toISOString()
    // Phase-1 minimal choice: Number(user.id) keeps the JWT payload JSON-safe (a raw bigint
    // throws in JSON.stringify). Safe for current small autoincrement ids; a global
    // BigInt-serialization strategy (or never exposing internal ids) is deferred to Phase 2
    // per RESEARCH Open Question 4.
    // Guard the deferred assumption: fail loudly rather than silently rounding an id that
    // exceeds JS safe-integer range, which would otherwise mint a token for the wrong user.
    if (user.id > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`user id ${user.id} exceeds safe JS integer range for JWT encoding`)
    }
    const accessToken = fastify.jwt.sign({ id: Number(user.id), email: user.email, name: user.name })
    const refreshToken = await generateRefreshToken(user.id)
    return { accessToken, refreshToken, expiresAt }
  })
})