import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { Config, TrustProxy } from './config.js'
import { errorBody, errorHandler } from './errors.js'

export interface BuildAppOptions {
  config: Config
  /** Fastify logger setting; off by default so tests stay quiet. */
  logger?: FastifyServerOptions['logger']
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
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
export function buildApp({ config, logger = false }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger, trustProxy: fastifyTrustProxy(config.trustProxy) })

  app.decorate('config', config)
  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(errorBody('NOT_FOUND', 'Not found')),
  )

  app.get('/api/health', async () => ({ status: 'ok' }))

  return app
}
