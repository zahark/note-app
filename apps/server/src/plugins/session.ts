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
    /**
     * Auth guard for private routes, attached as an `onRequest` hook (`app.addHook('onRequest', app.requireAuth)`
     * or `{ onRequest: app.requireAuth }`) so an unauthenticated request is rejected before its body is parsed.
     * Sets `request.user` or throws 401.
     */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
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

/**
 * Sets the session cookie and the long-lived device cookie after a signup or login (the device cookie
 * only when the result carries one: another account's valid device cookie is left in place).
 */
export function setAuthCookies(reply: FastifyReply, config: Config, result: AuthResult): void {
  setSessionCookie(reply, config, result.sessionToken)
  setDeviceCookie(reply, config, result.deviceToken)
}

function setSessionCookie(reply: FastifyReply, config: Config, sessionToken: string): void {
  reply.setCookie(SESSION_COOKIE, sessionToken, cookieOptions(config, SESSION_TTL_SEC))
}

/** Replaces the device cookie (after a password change issues a fresh device); no-op without a token. */
export function setDeviceCookie(reply: FastifyReply, config: Config, deviceToken: string | undefined): void {
  if (deviceToken) reply.setCookie(DEVICE_COOKIE, deviceToken, cookieOptions(config, DEVICE_TTL_SEC))
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

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE]
    const found = auth.sessionUser(token)
    if (!found || !token) throw unauthorized()
    request.user = found.user
    // sliding expiry: the session was extended, so the cookie gets the full lifetime again
    if (found.renewed) setSessionCookie(reply, app.config, token)
  })
}
