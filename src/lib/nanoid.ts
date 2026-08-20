import { nanoid } from 'nanoid'

// Default nanoid() is 21 chars — matches the public_id columns' @db.VarChar(21).
export const generatePublicId = (): string => nanoid()
