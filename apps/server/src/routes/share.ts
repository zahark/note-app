import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { SIGNED_TTL_OPTIONS, type SignedTtlOption } from '../services/share.js'
import { idParams } from './schemas.js'

const ttlOptions = Object.keys(SIGNED_TTL_OPTIONS) as [SignedTtlOption, ...SignedTtlOption[]]

/** Enable or regenerate a share: a PIN share, or a signed link with one of the fixed expiry options. */
const shareBody = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('password_protected') }),
  z.strictObject({ type: z.literal('signed_url'), expires_in: z.enum(ttlOptions) }),
])

/**
 * `POST /api/notes/:id/share` (enable or regenerate; the PIN or link is returned once) and
 * `DELETE /api/notes/:id/share` (stop sharing). Owner-only: another user's note is 404.
 */
export async function shareRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireAuth)

  app.post('/api/notes/:id/share', async (request) => {
    const { id } = idParams.parse(request.params)
    const body = shareBody.parse(request.body)
    const userId = request.user!.id
    const share =
      body.type === 'password_protected'
        ? await app.share.enablePin(userId, id)
        : app.share.enableSigned(userId, id, SIGNED_TTL_OPTIONS[body.expires_in])
    return { share }
  })

  app.delete('/api/notes/:id/share', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    app.share.stop(request.user!.id, id)
    return reply.status(204).send()
  })
}
