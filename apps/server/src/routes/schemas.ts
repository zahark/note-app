// zod pieces shared by the private folder/note routes.
import { z } from 'zod'
import { conflict, notFound, type AppError } from '../errors.js'

/** Longest id a request may carry (ids are UUIDs; the bound only caps what a request can send). */
const MAX_ID_LENGTH = 100

/**
 * An entity id (note, folder, attachment) in a path param or body. Any string is accepted: an id that is
 * malformed, missing or another user's is simply not found by the owner-scoped repo, so every such case
 * answers the same 404.
 */
export const entityId = z.string().min(1).max(MAX_ID_LENGTH)

/** `:id` path param. */
export const idParams = z.object({ id: entityId })

/** A folder id supplied in a body (`parent_folder_id`, `folder_id`); absent or null = root. */
export const optionalFolderId = entityId.nullish().transform((v) => v ?? null)

/** A move target in a body (`folder_id`, `parent_folder_id`): required, null = root. */
export const targetFolderId = entityId.nullable()

/** Maps a failed tree-service move to its HTTP error; `what` names the moved item for the message. */
export function moveError(reason: 'not_found' | 'target_not_found' | 'cycle', what: string): AppError {
  if (reason === 'cycle') {
    return conflict('A folder cannot be moved into itself or one of its subfolders', 'FOLDER_CYCLE')
  }
  return notFound(reason === 'target_not_found' ? 'Target folder not found' : `${what} not found`)
}
