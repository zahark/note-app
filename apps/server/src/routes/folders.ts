import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { notFound } from '../errors.js'
import { createFolder, deleteFolder, getFolder, renameFolder } from '../repos/folders.js'
import { moveFolder } from '../services/tree.js'
import { idParams, moveError, optionalFolderId, targetFolderId } from './schemas.js'

const folderName = z.string().trim().min(1, 'Name is required').max(255)

const createFolderBody = z.strictObject({
  name: folderName,
  parent_folder_id: optionalFolderId,
})

const renameFolderBody = z.strictObject({ name: folderName })

/** Move only: `parent_folder_id` is required (null = root), so an empty body never silently moves to root. */
const moveFolderBody = z.strictObject({ parent_folder_id: targetFolderId })

/** `POST /api/folders`, `PATCH|DELETE /api/folders/:id`, `PATCH /api/folders/:id/move`. Every route requires a session. */
export async function folderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireAuth)

  app.post('/api/folders', async (request, reply) => {
    const { name, parent_folder_id } = createFolderBody.parse(request.body)
    // the repo checks the parent's ownership in the insert itself: foreign or missing → nothing inserted
    const folder = createFolder(app.db, request.user!.id, { name, parentFolderId: parent_folder_id })
    if (!folder) throw notFound('Folder not found')
    return reply.status(201).send({ folder })
  })

  app.patch('/api/folders/:id', async (request) => {
    const { id } = idParams.parse(request.params)
    const { name } = renameFolderBody.parse(request.body)
    const userId = request.user!.id
    if (!renameFolder(app.db, userId, id, name)) throw notFound('Folder not found')
    return { folder: getFolder(app.db, userId, id) }
  })

  app.patch('/api/folders/:id/move', async (request) => {
    const { id } = idParams.parse(request.params)
    const { parent_folder_id } = moveFolderBody.parse(request.body)
    const userId = request.user!.id
    const result = moveFolder(app.db, userId, id, parent_folder_id)
    if (!result.ok) throw moveError(result.reason, 'Folder')
    return { folder: getFolder(app.db, userId, id) }
  })

  app.delete('/api/folders/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    if (!deleteFolder(app.db, request.user!.id, id)) throw notFound('Folder not found')
    return reply.status(204).send()
  })
}
