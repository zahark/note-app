import fastifyMultipart from '@fastify/multipart'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { badRequest, notFound, unsupportedMediaType } from '../errors.js'
import { getAttachment } from '../repos/attachments.js'
import {
  assertWithinQuota,
  MAX_ATTACHMENT_BYTES,
  readAttachmentFile,
  storeUpload,
  UPLOAD_LIMIT,
} from '../services/attachments.js'
import { RateLimiter, type Clock } from '../services/rateLimiter.js'
import { entityId } from './schemas.js'

const attachmentParams = z.object({ aid: entityId })

export interface AttachmentRoutesOptions {
  /** Clock for the upload rate limit; a test seam. */
  now?: Clock | undefined
}

/**
 * `POST /api/attachments` (multipart upload of one image; returns `{id}`) and
 * `GET /api/attachments/:aid` (the caller's own attachment bytes). Every route requires a session;
 * another user's attachment is indistinguishable from a missing one (404). Uploads are limited to
 * `UPLOAD_LIMIT` per account (429) and to `UPLOAD_QUOTA_MB` of stored images per account (413).
 */
export async function attachmentRoutes(
  app: FastifyInstance,
  { now = Date.now }: AttachmentRoutesOptions = {},
): Promise<void> {
  const uploadsPerUser = new RateLimiter({ ...UPLOAD_LIMIT, now })
  app.addHook('onRequest', app.requireAuth)
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 0, parts: 1 },
  })

  app.post('/api/attachments', async (request, reply) => {
    if (!request.isMultipart()) {
      throw unsupportedMediaType('Expected a multipart/form-data upload')
    }
    const userId = request.user!.id
    // both checks run before the body is read: a limited or full account costs no disk or memory
    uploadsPerUser.enforce(userId, 'Too many image uploads, try again in a few minutes')
    assertWithinQuota(app.db, userId, app.config.uploadQuotaMb, 1)
    const part = await request.file()
    if (!part) throw badRequest('No file uploaded')
    // throws a 413 once the file exceeds MAX_ATTACHMENT_BYTES
    const data = await part.toBuffer()
    const attachment = await storeUpload(
      app.db,
      app.config.dataDir,
      userId,
      { originalName: part.filename, data },
      app.config.uploadQuotaMb,
    )
    return reply.status(201).send({ id: attachment.id })
  })

  app.get('/api/attachments/:aid', async (request, reply) => {
    const { aid } = attachmentParams.parse(request.params)
    const attachment = getAttachment(app.db, request.user!.id, aid)
    if (!attachment) throw notFound('Attachment not found')
    const bytes = await readAttachmentFile(app.config.dataDir, attachment.storage_name)
    if (!bytes) throw notFound('Attachment not found')
    return reply
      .type(attachment.mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(bytes)
  })
}
