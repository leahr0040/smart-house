import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { PrismaClient } from '../generated/prisma/client'
import { env } from './env'

const adapter = new PrismaMariaDb(env.DATABASE_URL)

export const prisma = new PrismaClient({ adapter })
