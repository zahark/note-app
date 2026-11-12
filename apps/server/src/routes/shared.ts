// The public shared API: what an anonymous visitor of a shared note can reach. It never reads the
// session cookie; the only credentials are a PIN-unlock token (in the `Authorization` header) or a
// signed link's `exp`/`sig` (query params). Apart from 429 (and 503 when the server is busy hashing),
// every failure is the identical `unavailable()` response, so nothing reveals whether a note exists,
// is shared, or in which mode.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { getSharedAttachment, getSharedNote } from '../repos/publicShare.js'
import { uploadsDir } from '../services/attachments.js'
import { unavailable } from '../services/share.js'

/** Matches every URL of the public shared API (`/api/shared`, `/api/shared/...`, `/api/shared?...`). */
const SHARED_API_URL = /^\/api\/shared(?:[/?]|$)/

/**
 * `onSend` hook for the root instance: every `/api/shared/*` response, including errors and unknown
 * paths, is kept out of referrers, search indexes and caches.
 */
export async function sharedApiHeaders(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!SHARED_API_URL.test(request.url)) return
  reply.header('referrer-policy', 'no-referrer')
  reply.header('x-robots-tag', 'noindex')
  reply.header('cache-control', 'no-store')
}

const noteParams = z.object({ id: z.string().min(1).max(100) })
const attachmentParams = noteParams.extend({ aid: z.string().min(1).max(100) })
const unlockBody = z.strictObject({ pin: z.string().min(1).max(64) })

/** Parses path params; a malformed id is just another id that is unavailable. */
function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params)
  if (!parsed.success) throw unavailable()
  return parsed.data
}

/** The PIN-unlock token from `Authorization: Bearer <token>` (never from the URL). */
function bearerToken(request: FastifyRequest): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? '')
  return match?.[1]
}

/** A single-valued query param (a repeated or missing one is undefined). */
function queryParam(request: FastifyRequest, name: string): string | undefined {
  const value = (request.query as Record<string, unknown> | undefined)?.[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Throws `unavailable()` unless the request carries a valid credential for note `noteId`: a token
 * unlocked with the note's current PIN, or an unexpired link signed with its current nonce.
 */
function authorize(app: FastifyInstance, request: FastifyRequest, noteId: string): void {
  const token = bearerToken(request)
  if (token !== undefined && app.share.verifyToken(noteId, token)) return
  if (app.share.verifySignedLink(noteId, queryParam(request, 'exp'), queryParam(request, 'sig'))) return
  throw unavailable()
}

/**
 * `POST /api/shared/:id/unlock {pin}` → `{token, expires_at}`;
 * `GET /api/shared/:id` → `{note:{title, content, attachment_ids}}`;
 * `GET /api/shared/:id/attachments/:aid` → image bytes, only when `note_attachments` links `:aid` to `:id`.
 */
export async function sharedRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/shared/:id/unlock', async (request) => {
    const { id } = parseParams(noteParams, request.params)
    const { pin } = unlockBody.parse(request.body)
    const { token, expiresAt } = await app.share.unlock({ noteId: id, pin, ip: request.ip })
    return { token, expires_at: expiresAt }
  })

  app.get('/api/shared/:id', async (request) => {
    const { id } = parseParams(noteParams, request.params)
    authorize(app, request, id)
    const note = getSharedNote(app.db, id)
    if (!note) throw unavailable()
    return { note: { title: note.title, content: note.content, attachment_ids: note.attachment_ids } }
  })

  app.get('/api/shared/:id/attachments/:aid', async (request, reply) => {
    const { id, aid } = parseParams(attachmentParams, request.params)
    authorize(app, request, id)
    const attachment = getSharedAttachment(app.db, id, aid)
    if (!attachment) throw unavailable()
    let bytes: Buffer
    try {
      bytes = await readFile(path.join(uploadsDir(app.config.dataDir), attachment.storage_name))
    } catch {
      throw unavailable()
    }
    return reply.type(attachment.mime).header('x-content-type-options', 'nosniff').send(bytes)
  })
}
