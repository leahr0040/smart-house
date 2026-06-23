import fp from 'fastify-plugin'
import type { FastifyRequest, FastifyReply } from 'fastify'
import jwt from '@fastify/jwt'
import { generateRefreshToken } from '../services/refresh-token'

const ACCESS_TOKEN_EXPIRES_MINUTES = 15

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>
    generateTokens: (user: { id: number; email: string; name: string | null }) => Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>
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
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required')
  }

  fastify.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: { expiresIn: `${ACCESS_TOKEN_EXPIRES_MINUTES}m` }
  })

  fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify()
    } catch (err) {
      reply.send(err)
      return reply
    }
  })

  fastify.decorate('generateTokens', async function (user: { id: number; email: string; name: string | null }) {
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_EXPIRES_MINUTES * 60 * 1000).toISOString()
    const accessToken = fastify.jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      { expiresIn: `${ACCESS_TOKEN_EXPIRES_MINUTES}m` }
    )
    const refreshToken = await generateRefreshToken(user.id)
    return { accessToken, refreshToken, expiresAt }
  })
})