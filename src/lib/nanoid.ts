import { nanoid } from 'nanoid'

// External, non-enumerable identity for user-facing entities (House/Room/Device/
// Command). Default nanoid() is 21 chars, which is exactly what the public_id
// columns are sized for (@db.VarChar(21)). Never used for internal PKs — those
// stay BigInt autoincrement.
export const generatePublicId = (): string => nanoid()
