// Owner-scoped attachment queries: every function takes the caller's userId and only ever matches
// that user's rows. Attachments belong to the user, not to a note; they are deleted only by the
// sweep, which lives in the unscoped `publicShare.ts`.
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'
import { requireUserId } from './scope.js'

export interface AttachmentRow {
  id: string
  user_id: string
  /** Display only; never used in a filesystem path. */
  original_name: string
  /** Random on-disk file name under DATA_DIR/uploads. */
  storage_name: string
  mime: string
  size: number
  created_at: number
  last_unlinked_at: number | null
}

export interface NewAttachment {
  originalName: string
  storageName: string
  mime: string
  size: number
}

export function createAttachment(db: Db, userId: string, input: NewAttachment): AttachmentRow {
  requireUserId(userId)
  const id = randomUUID()
  db.prepare(
    `INSERT INTO attachments (id, user_id, original_name, storage_name, mime, size)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, input.originalName, input.storageName, input.mime, input.size)
  const row = getAttachment(db, userId, id)
  if (!row) throw new Error('attachment vanished after insert')
  return row
}

export function getAttachment(db: Db, userId: string, attachmentId: string): AttachmentRow | undefined {
  requireUserId(userId)
  return db
    .prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?')
    .get(attachmentId, userId) as AttachmentRow | undefined
}
