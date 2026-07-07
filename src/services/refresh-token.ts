import crypto from 'node:crypto'
import { prisma } from '../lib/prisma'

export const REFRESH_TOKEN_EXPIRES_DAYS = 7

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function generateRefreshToken(userId: bigint): Promise<string> {
  const raw = crypto.randomBytes(40).toString('hex')
  const tokenHash = hashToken(raw)

  await prisma.refreshToken.create({
    data: {
      tokenHash,
      userId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000)
    }
  })

  return raw
}

export async function verifyRefreshToken(
  raw: string
): Promise<{ id: bigint; email: string; name: string | null } | null> {
  const tokenHash = hashToken(raw)

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true }
  })

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    return null
  }

  return { id: stored.user.id, email: stored.user.email, name: stored.user.name }
}

export async function revokeRefreshToken(raw: string): Promise<boolean> {
  const tokenHash = hashToken(raw)
  const result = await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() }
  })
  return result.count > 0
}
