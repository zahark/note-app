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

/**
 * Makes the note's `note_attachments` rows equal to `attachmentIds`, keeping only ids of attachments
 * owned by `userId` (another user's or unknown ids are ignored, so nobody can link someone else's image
 * into their note or share). Removed rows fire the `note_attachments_unlinked` trigger, which stamps
 * `last_unlinked_at`. Returns false, changing nothing, when the note is not the caller's.
 * Call it inside the content-save transaction.
 */
export function setNoteAttachments(
  db: Db,
  userId: string,
  noteId: string,
  attachmentIds: readonly string[],
): boolean {
  requireUserId(userId)
  const owned = db
    .prepare('SELECT EXISTS (SELECT 1 FROM notes WHERE id = ? AND user_id = ?)')
    .pluck()
    .get(noteId, userId)
  if (owned !== 1) return false
  const params = { note: noteId, userId, ids: JSON.stringify(attachmentIds) }
  db.prepare(
    `DELETE FROM note_attachments
      WHERE note_id = @note
        AND attachment_id NOT IN (SELECT value FROM json_each(@ids))`,
  ).run(params)
  db.prepare(
    `INSERT OR IGNORE INTO note_attachments (note_id, attachment_id)
     SELECT @note, a.id FROM attachments a
      WHERE a.user_id = @userId AND a.id IN (SELECT value FROM json_each(@ids))`,
  ).run(params)
  return true
}

/** Ids of the attachments linked to the caller's note (empty for another user's or a missing note). */
export function listNoteAttachmentIds(db: Db, userId: string, noteId: string): string[] {
  requireUserId(userId)
  return db
    .prepare(
      `SELECT na.attachment_id FROM note_attachments na
         JOIN notes n ON n.id = na.note_id
        WHERE na.note_id = ? AND n.user_id = ?
        ORDER BY na.attachment_id`,
    )
    .pluck()
    .all(noteId, userId) as string[]
}
