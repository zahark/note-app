import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { conflict, notFound } from '../errors.js'
import {
  createNote,
  deleteNote,
  getNote,
  getNoteSummary,
  renameNote,
} from '../repos/notes.js'
import { saveContentWithAttachments } from '../services/attachments.js'
import { RateLimiter, type Clock } from '../services/rateLimiter.js'
import { moveNote } from '../services/tree.js'
import { MIB, MINUTE_MS } from '../units.js'
import { idParams, moveError, optionalFolderId, targetFolderId } from './schemas.js'

const noteTitle = z.string().max(500)

/**
 * Per-account write limits (→ 429 with Retry-After). Autosave sends at most about one save per second
 * per open note, so normal editing stays far below them; they cap how fast one account can write.
 */
export const NOTE_LIMITS = {
  creates: { limit: 60, windowMs: 15 * MINUTE_MS },
  contentSaves: { limit: 600, windowMs: 15 * MINUTE_MS },
} as const

export interface NoteRoutesOptions {
  /** Clock for the write limits; a test seam. */
  now?: Clock | undefined
}

/**
 * Body limit of the content save (Fastify's default elsewhere is 1 MiB). Images are attachments, so this
 * bounds text and structure only; a larger body gets 413 PAYLOAD_TOO_LARGE.
 */
export const NOTE_CONTENT_BODY_LIMIT = 5 * MIB

const createNoteBody = z.strictObject({
  folder_id: optionalFolderId,
  title: noteTitle.optional(),
})

/** Rename only: no `version`, so a rename never takes part in (or is reverted by) autosave. */
const renameNoteBody = z.strictObject({ title: noteTitle })

/** Move only: `folder_id` is required (null = root); no `version`, so a move never conflicts with autosave. */
const moveNoteBody = z.strictObject({ folder_id: targetFolderId })

/** Content only: a `title` (or any other field) is rejected, so autosave can never overwrite a rename. */
const saveContentBody = z.strictObject({
  // a TipTap document; its inner structure is the editor's business
  content: z.looseObject({ type: z.literal('doc') }),
  version: z.number().int().positive(),
})

/** An `onRequest` hook counting the caller's requests against `limiter`, before the body is read. */
function perUserLimit(limiter: RateLimiter, message: string) {
  return async (request: FastifyRequest): Promise<void> => {
    limiter.enforce(request.user!.id, message)
  }
}

/**
 * `POST /api/notes`, `GET|PATCH|DELETE /api/notes/:id`, `PUT /api/notes/:id/content`,
 * `PATCH /api/notes/:id/move`.
 * Every route requires a session; creates and content saves are rate-limited per account (`NOTE_LIMITS`).
 */
export async function noteRoutes(
  app: FastifyInstance,
  { now = Date.now }: NoteRoutesOptions = {},
): Promise<void> {
  // route-level onRequest hooks run after this one, so `request.user` is set when they count
  app.addHook('onRequest', app.requireAuth)
  const limitCreates = perUserLimit(
    new RateLimiter({ ...NOTE_LIMITS.creates, now }),
    'Too many notes created, try again in a few minutes',
  )
  const limitSaves = perUserLimit(
    new RateLimiter({ ...NOTE_LIMITS.contentSaves, now }),
    'Too many saves, try again in a few minutes',
  )

  app.post('/api/notes', { onRequest: limitCreates }, async (request, reply) => {
    const { folder_id, title } = createNoteBody.parse(request.body ?? {})
    // the repo checks the folder's ownership in the insert itself: foreign or missing → nothing inserted
    const note = createNote(app.db, request.user!.id, { folderId: folder_id, title })
    if (!note) throw notFound('Folder not found')
    return reply.status(201).send({ note })
  })

  app.get('/api/notes/:id', async (request) => {
    const { id } = idParams.parse(request.params)
    const note = getNote(app.db, request.user!.id, id)
    if (!note) throw notFound('Note not found')
    return { note }
  })

  app.patch('/api/notes/:id', async (request) => {
    const { id } = idParams.parse(request.params)
    const { title } = renameNoteBody.parse(request.body)
    const userId = request.user!.id
    if (!renameNote(app.db, userId, id, title)) throw notFound('Note not found')
    return { note: getNoteSummary(app.db, userId, id) }
  })

  app.patch('/api/notes/:id/move', async (request) => {
    const { id } = idParams.parse(request.params)
    const { folder_id } = moveNoteBody.parse(request.body)
    const userId = request.user!.id
    const result = moveNote(app.db, userId, id, folder_id)
    if (!result.ok) throw moveError(result.reason, 'Note')
    return { note: getNoteSummary(app.db, userId, id) }
  })

  app.put('/api/notes/:id/content', { bodyLimit: NOTE_CONTENT_BODY_LIMIT, onRequest: limitSaves }, async (request) => {
    const { id } = idParams.parse(request.params)
    const { content, version } = saveContentBody.parse(request.body)
    // also rebuilds the note's attachment references from the content, in the same transaction
    const result = saveContentWithAttachments(app.db, request.user!.id, id, content, version)
    if (result.ok) return { version: result.version }
    if (result.reason === 'conflict') {
      throw conflict('The note was changed elsewhere; reload it', 'VERSION_CONFLICT')
    }
    throw notFound('Note not found')
  })

  app.delete('/api/notes/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    if (!deleteNote(app.db, request.user!.id, id)) throw notFound('Note not found')
    return reply.status(204).send()
  })
}
