import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fastifyMultipart from '@fastify/multipart'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError, badRequest, notFound } from '../errors.js'
import { getAttachment } from '../repos/attachments.js'
import { MAX_ATTACHMENT_BYTES, storeUpload, uploadsDir } from '../services/attachments.js'

const attachmentParams = z.object({ aid: z.string().min(1).max(100) })

/**
 * `POST /api/attachments` (multipart upload of one image; returns `{id}`) and
 * `GET /api/attachments/:aid` (the caller's own attachment bytes). Every route requires a session;
 * another user's attachment is indistinguishable from a missing one (404).
 */
export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireAuth)
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 0, parts: 1 },
  })

  app.post('/api/attachments', async (request, reply) => {
    if (!request.isMultipart()) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected a multipart/form-data upload')
    }
    const part = await request.file()
    if (!part) throw badRequest('No file uploaded')
    // throws a 413 once the file exceeds MAX_ATTACHMENT_BYTES
    const data = await part.toBuffer()
    const attachment = await storeUpload(app.db, app.config.dataDir, request.user!.id, {
      originalName: part.filename,
      declaredMime: part.mimetype,
      data,
    })
    return reply.status(201).send({ id: attachment.id })
  })

  app.get('/api/attachments/:aid', async (request, reply) => {
    const { aid } = attachmentParams.parse(request.params)
    const attachment = getAttachment(app.db, request.user!.id, aid)
    if (!attachment) throw notFound('Attachment not found')
    let bytes: Buffer
    try {
      bytes = await readFile(path.join(uploadsDir(app.config.dataDir), attachment.storage_name))
    } catch {
      throw notFound('Attachment not found')
    }
    return reply
      .type(attachment.mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(bytes)
  })
}
