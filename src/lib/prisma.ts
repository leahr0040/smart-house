import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { PrismaClient, Prisma } from '../generated/prisma/client'
import { env } from './env'
import { generatePublicId } from './nanoid'
import { lowerFirst } from './strings'

// Exhaustive by construction: Record<Prisma.ModelName, …> makes TS error if a
// schema model is missing here. Add the row when you add the model.
// publicId: does this model carry an externally-exposed NanoID public_id?
// (user-facing entities only — internal-only tables are addressed by BigInt id)
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

// Read: inject deletedAt:null unless the caller already mentioned deletedAt
// (escape hatch — lets you query soft-deleted rows deliberately). Generic so it
// returns the exact args type the operation's `query()` callback expects.
function readGuard<T>(model: string, args: T): T {
  if (!isSoftDeletable(model)) return args

  const readArgs = (args ?? {}) as { where?: Record<string, unknown> }
  if (readArgs.where && 'deletedAt' in readArgs.where) return args // caller filters it themselves

  return { ...readArgs, where: { ...readArgs.where, deletedAt: null } } as T
}

const base = new PrismaClient({ adapter: new PrismaMariaDb(env.DATABASE_URL) })

// delete → update, deleteMany → updateMany. The extension `query()` callback
// cannot change the operation, so we re-dispatch through the un-extended `base`
// delegate (avoids recursion + init-order issues with the exported client).
function softDelete<A>(
  model: string,
  args: A,
  query: (args: A) => Promise<unknown>,
  many: boolean
) {
  if (!isSoftDeletable(model)) return query(args) // non-soft-delete models hard-delete
  const delegate = (base as Record<string, any>)[lowerFirst(model)]
  const withData = { ...args, data: { deletedAt: new Date() } }
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

      // Mint the external public_id app-side. Unlike softDelete() this goes
      // through the query() continuation rather than a captured `base` delegate,
      // so it stays inside any active $transaction.
      create({ model, args, query }) {
        if (!needsPublicId(model)) return query(args)
        const createArgs = args as { data?: Record<string, unknown> }
        const withData = {
          ...args,
          data: { ...createArgs.data, publicId: generatePublicId() }
        } as typeof args
        return query(withData)
      },

      delete({ model, args, query }) { return softDelete(model, args, query, false) },
      deleteMany({ model, args, query }) { return softDelete(model, args, query, true) }
    }
  }
})

// Un-extended client for the rare genuine hard delete / raw access.
export const prismaRaw = base
