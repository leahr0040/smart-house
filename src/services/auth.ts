import bcrypt from 'bcrypt'
import { prisma } from '../lib/prisma'

type LoginUserInput = {
  email: string
  password: string
}

export async function loginUser(input: LoginUserInput) {
  const user = await prisma.user.findUnique({
    where: { email: input.email }
  })

  if (!user || user.deletedAt) {
    return null
  }

  const isValid = await bcrypt.compare(input.password, user.password)

  if (!isValid) {
    return null
  }

  return user
}
