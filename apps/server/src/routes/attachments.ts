import fastifyMultipart from '@fastify/multipart'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError, badRequest, notFound, unsupportedMediaType } from '../errors.js'
import { getAttachment } from '../repos/attachments.js'
import {
  assertWithinQuota,
  attachmentResponseHeaders,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_UPLOAD_BYTES,
  readAttachmentFile,
  storeUpload,
  UPLOAD_LIMIT,
} from '../services/attachments.js'
import { RateLimiter, type Clock } from '../services/rateLimiter.js'
import { MIB } from '../units.js'
import { entityId } from './schemas.js'

const attachmentParams = z.object({ aid: entityId })

/** The 413 for a file cut off at the multipart limit, before its kind is known. */
const uploadTooLarge = () =>
  new AppError(
    413,
    'PAYLOAD_TOO_LARGE',
    `Files are limited to ${MAX_FILE_BYTES / MIB} MB (images to ${MAX_IMAGE_BYTES / MIB} MB)`,
  )

export interface AttachmentRoutesOptions {
  /** Clock for the upload rate limit; a test seam. */
  now?: Clock | undefined
}

/**
 * `POST /api/attachments` (multipart upload of one image, PDF or GPX file; returns
 * `{id, kind, mime, size, name}` with the kind detected from the content, which the client uses to
 * pick the node, whatever the file's extension or declared type said) and
 * `GET /api/attachments/:aid` (the caller's own attachment bytes; images inline, other kinds as a
 * sandboxed download, see `attachmentResponseHeaders`). Every route requires a session;
 * another user's attachment is indistinguishable from a missing one (404). Uploads are limited to
 * `UPLOAD_LIMIT` per account (429) and to `UPLOAD_QUOTA_MB` of stored attachments per account (413).
 */
export async function attachmentRoutes(
  app: FastifyInstance,
  { now = Date.now }: AttachmentRoutesOptions = {},
): Promise<void> {
  const uploadsPerUser = new RateLimiter({ ...UPLOAD_LIMIT, now })
  app.addHook('onRequest', app.requireAuth)
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
  })

  app.post('/api/attachments', async (request, reply) => {
    if (!request.isMultipart()) {
      throw unsupportedMediaType('Expected a multipart/form-data upload')
    }
    const userId = request.user!.id
    // both checks run before the body is read: a limited or full account costs no disk or memory
    uploadsPerUser.enforce(userId, 'Too many uploads, try again in a few minutes')
    assertWithinQuota(app.db, userId, app.config.uploadQuotaMb, 1)
    const part = await request.file()
    if (!part) throw badRequest('No file uploaded')
    // throws once the file exceeds MAX_UPLOAD_BYTES; storeUpload checks the per-kind limit
    let data: Buffer
    try {
      data = await part.toBuffer()
    } catch (err) {
      if (err instanceof app.multipartErrors.RequestFileTooLargeError) throw uploadTooLarge()
      throw err
    }
    const attachment = await storeUpload(
      app.db,
      app.config.dataDir,
      userId,
      { originalName: part.filename, data },
      app.config.uploadQuotaMb,
    )
    const { id, kind, mime, size, original_name: name } = attachment
    return reply.status(201).send({ id, kind, mime, size, name })
  })

  app.get('/api/attachments/:aid', async (request, reply) => {
    const { aid } = attachmentParams.parse(request.params)
    const attachment = getAttachment(app.db, request.user!.id, aid)
    if (!attachment) throw notFound('Attachment not found')
    const bytes = await readAttachmentFile(app.config.dataDir, attachment.storage_name)
    if (!bytes) throw notFound('Attachment not found')
    return reply
      .headers(attachmentResponseHeaders(attachment))
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(bytes)
  })
}
