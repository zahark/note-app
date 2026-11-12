// The ONLY repo module allowed to query without a userId. Every function here documents why it is
// unscoped. It is read-only apart from the attachment sweep's deletes.
//
// Task 9 adds the sweep queries; Task 10 adds the share-state lookup used by unlock and link/token
// verification; Task 11 adds the remaining public share lookups.
import type { Db } from '../db/index.js'
import type { ShareType } from './notes.js'

/** The sharing columns of a note: everything the public share checks need, and nothing else. */
export interface NoteShareState {
  id: string
  share_type: ShareType
  /** argon2 hash of the PIN, or the signing nonce; null when private. */
  share_secret: string | null
  expires_at: number | null
}

/**
 * The sharing state of note `noteId`, or undefined when there is no such note.
 * Unscoped because the public shared API (PIN unlock, token and signed-link checks) runs for anonymous
 * visitors: there is no user identity, the share secret itself is the authorization.
 */
export function getNoteShareState(db: Db, noteId: string): NoteShareState | undefined {
  return db
    .prepare('SELECT id, share_type, share_secret, expires_at FROM notes WHERE id = ?')
    .get(noteId) as NoteShareState | undefined
}

/**
 * Deletes every attachment row that no note references and whose last activity
 * (`MAX(created_at, last_unlinked_at)`: upload, or the moment it lost its last reference) is older
 * than `cutoff` (unix seconds). Returns the deleted rows' storage names so the caller can remove the
 * files after this statement has committed.
 *
 * Unscoped because the sweep is a background job that covers every user's attachments.
 * The check and the delete are one statement, so a reference added concurrently is never lost.
 */
export function deleteSweepableAttachments(db: Db, cutoff: number): string[] {
  return db
    .prepare(
      `DELETE FROM attachments
        WHERE NOT EXISTS (SELECT 1 FROM note_attachments na WHERE na.attachment_id = attachments.id)
          AND MAX(created_at, COALESCE(last_unlinked_at, 0)) < ?
        RETURNING storage_name`,
    )
    .pluck()
    .all(cutoff) as string[]
}

/**
 * Every storage name that has an attachment row, so the sweep can recognise stray files.
 * Unscoped because the uploads directory holds every user's files.
 */
export function listAllStorageNames(db: Db): Set<string> {
  return new Set(db.prepare('SELECT storage_name FROM attachments').pluck().all() as string[])
}
