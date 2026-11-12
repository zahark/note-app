import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { Config, TrustProxy } from './config.js'
import type { Db } from './db/index.js'
import { errorBody, errorHandler } from './errors.js'
import { registerSession } from './plugins/session.js'
import { authRoutes } from './routes/auth.js'
import { AuthService } from './services/auth.js'
import type { HashLimiter } from './services/hashLimiter.js'
import type { PasswordHasher } from './services/password.js'
import type { Clock } from './services/ratelimit.js'

export interface BuildAppOptions {
  config: Config
  /** Open, migrated database (see `openDb`). The caller owns it and closes it. */
  db: Db
  /** Fastify logger setting; off by default so tests stay quiet. */
  logger?: FastifyServerOptions['logger']
  /** Test seams for the auth service; production uses argon2id, the default limiter and the real clock. */
  auth?: { hasher?: PasswordHasher; hashLimiter?: HashLimiter; now?: Clock }
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
    db: Db
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
export function buildApp({ config, db, logger = false, auth = {} }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger, trustProxy: fastifyTrustProxy(config.trustProxy) })

  app.decorate('config', config)
  app.decorate('db', db)
  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(errorBody('NOT_FOUND', 'Not found')),
  )

  // cookies, the CSRF Origin check and the auth guard come before every route
  registerSession(app, new AuthService({ db, config, ...auth }))

  app.get('/api/health', async () => ({ status: 'ok' }))
  app.register(authRoutes)

  return app
}
