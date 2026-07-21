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
      id: string
      email: string
      name: string | null
    }
  }
}

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
    // id as string, not bigint: a raw bigint throws in JSON.stringify and Number(id) would round
    // past 2^53 and mint a token for the wrong user. Read side does BigInt(request.user.id).
    const accessToken = fastify.jwt.sign({ id: user.id.toString(), email: user.email, name: user.name })
    const refreshToken = await generateRefreshToken(user.id)
    return { accessToken, refreshToken, expiresAt }
  })
})