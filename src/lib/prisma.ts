import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { PrismaClient, Prisma } from '../generated/prisma/client'
import { env } from './env'
import { generatePublicId } from './nanoid'
import { lowerFirst } from './strings'

const modelConfig: Record<Prisma.ModelName, { softDelete: boolean; publicId: boolean }> = {
  User: { softDelete: true, publicId: false },
  House: { softDelete: true, publicId: true },
  Room: { softDelete: true, publicId: true },
  Device: { softDelete: true, publicId: true },
  RefreshToken: { softDelete: false, publicId: false },
  Command: { softDelete: false, publicId: true },
  CommandTarget: { softDelete: false, publicId: false },
  LightState: { softDelete: false, publicId: false },
  AcState: { softDelete: false, publicId: false },
  HeaterState: { softDelete: false, publicId: false },
  SensorState: { softDelete: false, publicId: false },
  Event: { softDelete: false, publicId: false }
}

const isSoftDeletable = (model: string): boolean =>
  modelConfig[model as Prisma.ModelName]?.softDelete ?? false

const needsPublicId = (model: string): boolean =>
  modelConfig[model as Prisma.ModelName]?.publicId ?? false

// Escape hatch: a caller that names deletedAt itself gets to query dead rows deliberately.
function readGuard<T>(model: string, args: T): T {
  if (!isSoftDeletable(model)) return args

  const readArgs = (args ?? {}) as { where?: Record<string, unknown> }
  if (readArgs.where && 'deletedAt' in readArgs.where) return args

  return { ...readArgs, where: { ...readArgs.where, deletedAt: null } } as T
}

const base = new PrismaClient({ adapter: new PrismaMariaDb(env.DATABASE_URL) })

// delete → update: query() can't change the op, so re-dispatch on the un-extended base.
function softDelete<A>(
  model: string,
  args: A,
  query: (args: A) => Promise<unknown>,
  many: boolean
) {
  if (!isSoftDeletable(model)) return query(args)
  const delegate = (base as Record<string, any>)[lowerFirst(model)]
  const guarded = readGuard(model, args)
  const withData = { ...guarded, data: { deletedAt: new Date() } }
  return many ? delegate.updateMany(withData) : delegate.update(withData)
}

export const prisma = base.$extends({
  query: {
    $allModels: {
      findUnique({ model, args, query }) { return query(readGuard(model, args)) },
      findUniqueOrThrow({ model, args, query }) { return query(readGuard(model, args)) },
      findFirst({ model, args, query }) { return query(readGuard(model, args)) },
      findFirstOrThrow({ model, args, query }) { return query(readGuard(model, args)) },
      findMany({ model, args, query }) { return query(readGuard(model, args)) },
      count({ model, args, query }) { return query(readGuard(model, args)) },
      aggregate({ model, args, query }) { return query(readGuard(model, args)) },
      groupBy({ model, args, query }) { return query(readGuard(model, args)) },

      // Mint via the query() continuation (not a base delegate) so it stays inside any $transaction.
      create({ model, args, query }) {
        if (!needsPublicId(model)) return query(args)
        const createArgs = args as { data?: Record<string, unknown> }
        const withData = {
          ...args,
          data: { ...createArgs.data, publicId: generatePublicId() }
        } as typeof args
        return query(withData)
      },

      update({ model, args, query }) { return query(readGuard(model, args)) },
      updateMany({ model, args, query }) { return query(readGuard(model, args)) },
      upsert({ model, args, query }) {
        // ponytail: blocked — a dead row still holds the unique public_id, so the create
        // branch would P2002. Add explicit handling in a service if one ever needs it.
        if (isSoftDeletable(model)) throw new Error(`upsert is not supported on soft-deletable model ${model}`)
        return query(args)
      },

      delete({ model, args, query }) { return softDelete(model, args, query, false) },
      deleteMany({ model, args, query }) { return softDelete(model, args, query, true) }
    }
  }
})

// Un-extended client for raw access / genuine hard delete.
export const prismaRaw = base

// A guarded update/delete throws P2025 when it matches no row (missing, cross-tenant,
// or soft-deleted). Callers that read that as "not found" wrap the op to get null → 404.
export async function nullIfNotFound<T>(op: Promise<T>): Promise<T | null> {
  try {
    return await op
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return null
    }
    throw error
  }
}
