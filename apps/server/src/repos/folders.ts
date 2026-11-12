// Owner-scoped folder queries: every function takes the caller's userId and only ever matches that
// user's rows, so another user's folder is indistinguishable from a missing one (routes answer 404).
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'
import { requireUserId } from './scope.js'

export interface FolderRow {
  id: string
  user_id: string
  name: string
  /** NULL = root. */
  parent_folder_id: string | null
  created_at: number
}

export interface NewFolder {
  name: string
  /** NULL = root; otherwise must be a folder owned by the same user. */
  parentFolderId: string | null
}

export function listFolders(db: Db, userId: string): FolderRow[] {
  requireUserId(userId)
  return db
    .prepare('SELECT * FROM folders WHERE user_id = ? ORDER BY created_at, id')
    .all(userId) as FolderRow[]
}

export function getFolder(db: Db, userId: string, folderId: string): FolderRow | undefined {
  requireUserId(userId)
  return db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(folderId, userId) as
    | FolderRow
    | undefined
}

/**
 * Creates a folder. Returns undefined, inserting nothing, when `parentFolderId` is not a folder of
 * `userId` (another user's or missing). The ownership check and the insert are one statement.
 */
export function createFolder(db: Db, userId: string, input: NewFolder): FolderRow | undefined {
  requireUserId(userId)
  const id = randomUUID()
  const { changes } = db
    .prepare(
      `INSERT INTO folders (id, user_id, name, parent_folder_id)
       SELECT @id, @userId, @name, @parent
        WHERE @parent IS NULL
           OR EXISTS (SELECT 1 FROM folders WHERE id = @parent AND user_id = @userId)`,
    )
    .run({ id, userId, name: input.name, parent: input.parentFolderId })
  return changes === 1 ? getFolder(db, userId, id) : undefined
}

/** Returns false when the folder is not the caller's (or missing). */
export function renameFolder(db: Db, userId: string, folderId: string, name: string): boolean {
  requireUserId(userId)
  return (
    db.prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?').run(name, folderId, userId)
      .changes === 1
  )
}

/**
 * Deletes the folder and, through the FK cascade, its whole subtree of folders and notes (and those
 * notes' attachment references). Returns false when the folder is not the caller's (or missing).
 */
export function deleteFolder(db: Db, userId: string, folderId: string): boolean {
  requireUserId(userId)
  return db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(folderId, userId).changes === 1
}
