const userResponseSchema = {
  type: 'object',
  required: ['id', 'email', 'name'],
  properties: {
    id: { type: 'number' },
    email: { type: 'string' },
    name: { type: ['string', 'null'] }
  }
} as const

const authResponseSchema = {
  type: 'object',
  required: ['accessToken', 'expiresAt', 'user'],
  properties: {
    accessToken: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
    user: userResponseSchema
  }
} as const

const logoutResponseSchema = {
  type: 'object',
  required: ['message'],
  properties: {
    message: { type: 'string' }
  }
} as const

export const registerRouteSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 191 },
      password: { type: 'string', minLength: 6 },
      name: { type: 'string', maxLength: 191 }
    }
  },
  response: {
    200: authResponseSchema
  }
} as const

export const loginRouteSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 191 },
      password: { type: 'string' }
    }
  },
  response: {
    200: authResponseSchema
  }
} as const

export const meRouteSchema = {
  response: {
    200: userResponseSchema
  }
} as const

export const refreshRouteSchema = {
  response: {
    200: authResponseSchema
  }
} as const

export const logoutRouteSchema = {
  response: {
    200: logoutResponseSchema
  }
} as const