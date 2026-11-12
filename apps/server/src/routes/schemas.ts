// zod pieces shared by the private folder/note routes.
import { z } from 'zod'

/**
 * `:id` path param. Any string is accepted: an id that is malformed, missing or another user's is
 * simply not found by the owner-scoped repo, so every such case answers the same 404.
 */
export const idParams = z.object({ id: z.string().min(1).max(100) })

/** A folder id supplied in a body (`parent_folder_id`, `folder_id`); absent or null = root. */
export const optionalFolderId = z
  .string()
  .min(1)
  .max(100)
  .nullish()
  .transform((v) => v ?? null)
