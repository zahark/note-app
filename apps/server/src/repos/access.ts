// Access resolution: the seam for future multi-user collaboration. Today a note is reachable only by
// its owner; later this is where shared/collaborator roles get resolved.
import type { Db } from '../db/index.js'
import { requireUserId } from './scope.js'

export type Access = 'owner' | 'none'

/** `owner` when `userId` owns `noteId`; `none` for another user's note or a missing one. */
export function resolveAccess(db: Db, userId: string, noteId: string): Access {
  requireUserId(userId)
  const owned = db
    .prepare('SELECT EXISTS (SELECT 1 FROM notes WHERE id = ? AND user_id = ?)')
    .pluck()
    .get(noteId, userId)
  return owned === 1 ? 'owner' : 'none'
}
