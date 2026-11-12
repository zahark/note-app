import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'
import type { Config, TrustProxy } from './config.js'
import type { Db } from './db/index.js'
import { errorBody, errorHandler } from './errors.js'
import { registerSession } from './plugins/session.js'
import { attachmentRoutes } from './routes/attachments.js'
import { authRoutes } from './routes/auth.js'
import { folderRoutes } from './routes/folders.js'
import { noteRoutes } from './routes/notes.js'
import { shareRoutes } from './routes/share.js'
import { sharedApiHeaders, sharedRoutes } from './routes/shared.js'
import { treeRoutes } from './routes/tree.js'
import { sweepAttachments } from './services/attachments.js'
import { AuthService } from './services/auth.js'
import type { HashLimiter } from './services/hashLimiter.js'
import type { PasswordHasher } from './services/password.js'
import type { Clock } from './services/ratelimit.js'
import { ShareService } from './services/share.js'

export interface BuildAppOptions {
  config: Config
  /** Open, migrated database (see `openDb`). The caller owns it and closes it. */
  db: Db
  /** Fastify logger setting; off by default so tests stay quiet. */
  logger?: FastifyServerOptions['logger']
  /**
   * Test seams for the auth service (and the share service, which shares its hasher, limiter and clock);
   * production uses argon2id, the default limiter and the real clock.
   */
  auth?: { hasher?: PasswordHasher; hashLimiter?: HashLimiter; now?: Clock }
  /**
   * Run the attachment sweep once when the app is ready and then daily. Off by default so tests never
   * touch an uploads directory they did not set up; the server entry point turns it on.
   */
  attachmentSweep?: boolean
  /**
   * Directory with the built web app (`index.html` + assets). When set, its files are served and every
   * other GET of a non-API path falls back to `index.html`; when unset the app serves the API only.
   */
  webDir?: string
}

/** Where the built SPA lives relative to this module: `apps/web/dist` from both `src/` and `dist/`. */
export function defaultWebDir(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url))
}

/** Matches every API URL (`/api`, `/api/...`, `/api?...`); these never fall back to the SPA. */
const API_URL = /^\/api(?:[/?]|$)/
/** Matches the shared-note page (`/shared`, `/shared/...`, `/shared?...`). */
const SHARED_PAGE_URL = /^\/shared(?:[/?]|$)/
const SPA_INDEX = 'index.html'

/** How often the attachment sweep runs after the boot-time run. */
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
    db: Db
    share: ShareService
  }
}

/**
 * Converts the parsed TRUST_PROXY into Fastify's `trustProxy` option.
 * A hop count becomes an explicit `(addr, i) => i < hops` function: Fastify 5 treats a bare number
 * as "trust nothing" (it fails closed because a hop count cannot validate the peer), whereas the
 * documented deployment contract is that with TRUST_PROXY set the port is reachable only via the proxy.
 */
export function fastifyTrustProxy(
  trustProxy: TrustProxy,
): false | string[] | ((addr: string, hop: number) => boolean) {
  if (typeof trustProxy === 'number') {
    const hops = trustProxy
    return (_addr, hop) => hop < hops
  }
  return trustProxy
}

/**
 * Builds the Fastify app without listening, so tests can drive it with `app.inject`.
 * Dependencies are injected; nothing here reads process.env.
 */
export function buildApp({
  config,
  db,
  logger = false,
  auth = {},
  attachmentSweep = false,
  webDir,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger, trustProxy: fastifyTrustProxy(config.trustProxy) })

  app.decorate('config', config)
  app.decorate('db', db)
  app.setErrorHandler(errorHandler)
  // no-referrer / noindex / no-store on every public shared API response, errors and 404s included
  app.addHook('onSend', sharedApiHeaders)
  if (webDir === undefined) {
    app.setNotFoundHandler((_request, reply) => sendNotFound(reply))
  } else {
    registerWebApp(app, webDir)
  }

  // cookies, the CSRF Origin check and the auth guard come before every route
  const authService = new AuthService({ db, config, ...auth })
  registerSession(app, authService)
  // PIN hashing and unlock verification go through the same argon2 concurrency cap as passwords
  app.decorate('share', new ShareService({ db, config, passwords: authService.passwords, now: auth.now }))

  app.get('/api/health', async () => ({ status: 'ok' }))
  app.register(authRoutes)
  // private, owner-scoped API: each plugin installs the auth guard on its own routes
  app.register(treeRoutes)
  app.register(folderRoutes)
  app.register(noteRoutes)
  app.register(attachmentRoutes)
  app.register(shareRoutes)
  // public shared API: no session, a share token or signed link is the only credential
  app.register(sharedRoutes)

  if (attachmentSweep) scheduleAttachmentSweep(app)

  return app
}

function sendNotFound(reply: FastifyReply): FastifyReply {
  return reply.status(404).send(errorBody('NOT_FOUND', 'Not found'))
}

/**
 * True for requests the SPA should answer: a GET/HEAD of a non-API path whose last segment has no
 * file extension (a missing `/assets/x.js` stays a 404 instead of returning HTML as JavaScript).
 */
function isClientRoute(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (API_URL.test(request.url)) return false
  const pathname = request.url.split('?', 1)[0] ?? ''
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  return !lastSegment.includes('.')
}

/**
 * Serves the built web app from `webDir` with an SPA fallback: client routes (`/`, `/login`,
 * `/shared/:id`, ...) get `index.html`; unknown API paths, other methods and missing files get the
 * JSON 404. The HTML shell is `no-cache` so a new deploy is picked up, and the shared-note page is kept
 * out of referrers (its URL can carry a signed link's `sig`) and search indexes.
 */
function registerWebApp(app: FastifyInstance, webDir: string): void {
  app.register(fastifyStatic, {
    root: webDir,
    // the HTML shell (served for `/` and the fallback) must be revalidated; hashed assets keep the defaults
    setHeaders: (reply, filePath) => {
      if (path.basename(filePath) === SPA_INDEX) reply.header('cache-control', 'no-cache')
    },
  })
  app.setNotFoundHandler((request, reply) => {
    if (!isClientRoute(request)) return sendNotFound(reply)
    return reply.sendFile(SPA_INDEX)
  })
  app.addHook('onSend', async (request, reply) => {
    if (!SHARED_PAGE_URL.test(request.url)) return
    reply.header('referrer-policy', 'no-referrer')
    reply.header('x-robots-tag', 'noindex')
  })
}

/** Runs the attachment sweep at boot (once the app is ready) and then every 24 hours; failures are logged, never fatal. */
function scheduleAttachmentSweep(app: FastifyInstance): void {
  const run = async () => {
    try {
      const result = await sweepAttachments(app.db, app.config.dataDir, Math.floor(Date.now() / 1000))
      app.log.info(result, 'attachment sweep finished')
    } catch (err) {
      app.log.error({ err }, 'attachment sweep failed')
    }
  }
  let timer: NodeJS.Timeout | undefined
  app.addHook('onReady', async () => {
    void run()
    timer = setInterval(() => void run(), SWEEP_INTERVAL_MS)
    timer.unref()
  })
  app.addHook('onClose', async () => {
    clearInterval(timer)
  })
}
