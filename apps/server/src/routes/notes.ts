import type { FastifyInstance } from 'fastify'
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
import { moveNote } from '../services/tree.js'
import { idParams, moveError, optionalFolderId, targetFolderId } from './schemas.js'

const noteTitle = z.string().max(500)

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

/**
 * `POST /api/notes`, `GET|PATCH|DELETE /api/notes/:id`, `PUT /api/notes/:id/content`,
 * `PATCH /api/notes/:id/move`.
 * Every route requires a session.
 */
export async function noteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireAuth)

  app.post('/api/notes', async (request, reply) => {
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

  app.put('/api/notes/:id/content', async (request) => {
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
