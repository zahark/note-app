import type { FastifyInstance } from 'fastify'
import { listFolders } from '../repos/folders.js'
import { listNoteSummaries } from '../repos/notes.js'

/**
 * `GET /api/tree`: the caller's folders and notes as two flat lists (notes without content).
 * The client builds the nested tree.
 */
export async function treeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireAuth)

  app.get('/api/tree', async (request) => {
    const userId = request.user!.id
    // one read transaction, so the two lists come from the same snapshot
    return app.db.transaction(() => ({
      folders: listFolders(app.db, userId),
      notes: listNoteSummaries(app.db, userId),
    }))()
  })
}
