import bcrypt from 'bcrypt'
import { prisma } from '../lib/prisma'

type CreateUserInput = {
  email: string
  password: string
  name?: string
}

export async function createUser(input: CreateUserInput) {
  const hashedPassword = await bcrypt.hash(input.password, 10)
  return prisma.user.create({
    data: {
      email: input.email,
      password: hashedPassword,
      name: input.name ?? null
    }
  })
}

export async function getUserById(id: number) {
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true }
  })
}
