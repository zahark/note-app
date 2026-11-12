import fastifyCookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import { AppError, unauthorized } from '../errors.js'
import { DEVICE_TTL_SEC, SESSION_TTL_SEC, type AuthResult, type AuthService, type AuthUser } from '../services/auth.js'

export const SESSION_COOKIE = 'sid'
export const DEVICE_COOKIE = 'did'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

declare module 'fastify' {
  interface FastifyInstance {
    auth: AuthService
    /** Auth guard for private routes: `{ preHandler: app.requireAuth }`. Sets `request.user` or throws 401. */
    requireAuth: (request: FastifyRequest) => Promise<void>
  }
  interface FastifyRequest {
    /** Set by `requireAuth`; null on routes without the guard. */
    user: (AuthUser & { sessionId: string }) | null
  }
}

const cookieOptions = (config: Config, maxAge: number) =>
  ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge,
  }) as const

/** Sets the session cookie and the long-lived device cookie after a signup or login. */
export function setAuthCookies(reply: FastifyReply, config: Config, result: AuthResult): void {
  reply.setCookie(SESSION_COOKIE, result.sessionToken, cookieOptions(config, SESSION_TTL_SEC))
  reply.setCookie(DEVICE_COOKIE, result.deviceToken, cookieOptions(config, DEVICE_TTL_SEC))
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(config, 0))
}

/**
 * Registers cookie parsing, the CSRF Origin check and the `requireAuth` guard on the root instance.
 * Must be called before any route that relies on them is registered.
 */
export function registerSession(app: FastifyInstance, auth: AuthService): void {
  app.register(fastifyCookie)
  app.decorate('auth', auth)
  app.decorateRequest('user', null)

  // CSRF: on top of SameSite=Lax, every mutating request must carry an Origin exactly equal to
  // PUBLIC_ORIGIN; a missing Origin is rejected too.
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return
    if (request.headers.origin !== app.config.publicOrigin) {
      throw new AppError(403, 'BAD_ORIGIN', 'Cross-origin request rejected')
    }
  })

  app.decorate('requireAuth', async (request: FastifyRequest) => {
    const user = auth.sessionUser(request.cookies[SESSION_COOKIE])
    if (!user) throw unauthorized()
    request.user = user
  })
}
