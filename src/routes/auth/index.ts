import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '../../generated/prisma/client'
import { loginUser } from '../../services/auth'
import { createUser, getUserById } from '../../services/user'
import { REFRESH_TOKEN_EXPIRES_DAYS } from '../../services/refresh-token'
import { loginRouteSchema, meRouteSchema, registerRouteSchema, refreshRouteSchema, logoutRouteSchema } from './schemas'

type RegisterBody = {
  email: string
  password: string
  name?: string
}

type LoginBody = {
  email: string
  password: string
}

const plugin: FastifyPluginAsync = async (fastify, _opts) => {
  function setRefreshCookie(reply: { setCookie: (name: string, value: string, options: Record<string, unknown>) => void }, token: string) {
    reply.setCookie('refreshToken', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth',
      maxAge: REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60
    })
  }

  function clearRefreshCookie(reply: { clearCookie: (name: string, options: Record<string, unknown>) => void }) {
    reply.clearCookie('refreshToken', { path: '/auth' })
  }

  fastify.post<{ Body: RegisterBody }>('/register', {
    schema: registerRouteSchema
  }, async (request, reply) => {
    let user
    try {
      user = await createUser(request.body)
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw fastify.httpErrors.conflict('Email already in use')
      }
      throw err
    }

    const { accessToken, refreshToken, expiresAt } = await fastify.generateTokens(user)
    setRefreshCookie(reply, refreshToken)

    reply.send({ accessToken, expiresAt, user: { id: user.id, email: user.email, name: user.name } })
  })

  fastify.post<{ Body: LoginBody }>('/login', {
    schema: loginRouteSchema
  }, async (request, reply) => {
    const user = await loginUser(request.body)

    if (!user) {
      throw fastify.httpErrors.unauthorized('Invalid credentials')
    }

    const { accessToken, refreshToken, expiresAt } = await fastify.generateTokens(user)
    setRefreshCookie(reply, refreshToken)

    reply.send({ accessToken, expiresAt, user: { id: user.id, email: user.email, name: user.name } })
  })

  fastify.get('/me', {
    preHandler: fastify.authenticate,
    schema: meRouteSchema
  }, async (request, reply) => {
    const user = await getUserById(request.user.id)

    if (!user) {
      throw fastify.httpErrors.notFound('User not found')
    }

    reply.send({ id: user.id, email: user.email, name: user.name })
  })

  fastify.post('/refresh', {
    schema: refreshRouteSchema
  }, async (request, reply) => {
    const raw = request.cookies.refreshToken

    if (!raw) {
      throw fastify.httpErrors.unauthorized('Missing refresh token')
    }

    const user = await fastify.verifyRefreshToken(raw)

    if (!user) {
      clearRefreshCookie(reply)
      throw fastify.httpErrors.unauthorized('Invalid or expired refresh token')
    }

    await fastify.revokeRefreshToken(raw)

    const { accessToken, refreshToken, expiresAt } = await fastify.generateTokens(user)
    setRefreshCookie(reply, refreshToken)

    reply.send({ accessToken, expiresAt, user })
  })

  fastify.post('/logout', {
    schema: logoutRouteSchema
  }, async (request, reply) => {
    const raw = request.cookies.refreshToken

    if (raw) {
      await fastify.revokeRefreshToken(raw)
    }

    clearRefreshCookie(reply)
    reply.send({ message: 'Logged out' })
  })
}

export default plugin