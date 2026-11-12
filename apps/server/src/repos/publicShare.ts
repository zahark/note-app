// The ONLY repo module allowed to query without a userId. Every function here documents why it is
// unscoped. It is read-only apart from the attachment sweep's deletes.
//
// Task 9 adds the sweep queries; Task 11 adds the public share lookups.
import type { Db } from '../db/index.js'

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
