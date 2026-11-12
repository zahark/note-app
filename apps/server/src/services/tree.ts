// Tree moves. Every id the caller supplies (the moved item and the target folder) must be the
// caller's, and a folder can never be moved into itself or anything below it.
import type { Db } from '../db/index.js'
import { getFolder, updateFolderParent } from '../repos/folders.js'
import { getNoteSummary, updateNoteFolder } from '../repos/notes.js'
import { requireUserId } from '../repos/scope.js'

export type MoveResult =
  | { ok: true }
  /** `not_found`: the moved item; `target_not_found`: the destination folder; `cycle`: folders only. */
  | { ok: false; reason: 'not_found' | 'target_not_found' | 'cycle' }

/**
 * True when `candidateId` is `rootFolderId` itself or any folder below it. Recursive CTE over the
 * caller's folders only; `UNION` (not `UNION ALL`) makes it terminate even on a corrupt, cyclic tree.
 */
export function isInFolderSubtree(db: Db, userId: string, rootFolderId: string, candidateId: string): boolean {
  requireUserId(userId)
  const found = db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM folders WHERE id = @root AND user_id = @userId
         UNION
         SELECT f.id FROM folders f JOIN subtree s ON f.parent_folder_id = s.id
          WHERE f.user_id = @userId
       )
       SELECT EXISTS (SELECT 1 FROM subtree WHERE id = @candidate)`,
    )
    .pluck()
    .get({ root: rootFolderId, userId, candidate: candidateId })
  return found === 1
}

/**
 * Moves a folder (with its whole subtree) under `targetParentId` (null = root). Checks run in this
 * order inside one write transaction: the folder is the caller's (else `not_found`, so a foreign
 * folder never reaches the cycle check and is never revealed by a 409), the target is the caller's
 * (else `target_not_found`), the target is not the folder or one of its descendants (else `cycle`).
 */
export function moveFolder(db: Db, userId: string, folderId: string, targetParentId: string | null): MoveResult {
  requireUserId(userId)
  const move = db.transaction((): MoveResult => {
    if (!getFolder(db, userId, folderId)) return { ok: false, reason: 'not_found' }
    if (targetParentId !== null) {
      if (!getFolder(db, userId, targetParentId)) return { ok: false, reason: 'target_not_found' }
      if (isInFolderSubtree(db, userId, folderId, targetParentId)) return { ok: false, reason: 'cycle' }
    }
    // the update re-checks both ids' ownership itself; with the checks above it cannot miss
    return updateFolderParent(db, userId, folderId, targetParentId)
      ? { ok: true }
      : { ok: false, reason: 'not_found' }
  })
  return move.immediate()
}

/** Moves a note into `targetFolderId` (null = root). Never touches the note's `version`. */
export function moveNote(db: Db, userId: string, noteId: string, targetFolderId: string | null): MoveResult {
  requireUserId(userId)
  const move = db.transaction((): MoveResult => {
    if (!getNoteSummary(db, userId, noteId)) return { ok: false, reason: 'not_found' }
    if (targetFolderId !== null && !getFolder(db, userId, targetFolderId)) {
      return { ok: false, reason: 'target_not_found' }
    }
    return updateNoteFolder(db, userId, noteId, targetFolderId)
      ? { ok: true }
      : { ok: false, reason: 'not_found' }
  })
  return move.immediate()
}
