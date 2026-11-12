import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  clearSessionCookie,
  DEVICE_COOKIE,
  SESSION_COOKIE,
  setAuthCookies,
  setDeviceCookie,
} from '../plugins/session.js'
import { normalizeEmail } from '../services/auth.js'

/** Emails are normalized once, by the same `normalizeEmail` the reset-password CLI uses. */
const email = z.string().transform(normalizeEmail)

const signupBody = z.object({
  email: email.pipe(z.email('Invalid email address').max(254)),
  // the password policy itself is applied by validatePassword in the service
  password: z.string().max(4096),
})

const loginBody = z.object({
  email: email.pipe(z.string().min(1).max(254)),
  // no policy check at login, just a bound on the work a request can ask for
  password: z.string().min(1).max(1024),
})

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  // the policy is applied by validatePassword in the service
  newPassword: z.string().max(4096),
})

/** `POST /api/auth/signup|login|logout|change-password`, `GET /api/auth/me|signup-status`. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // public: lets the login page offer "Create account" only when signup would be accepted
  app.get('/api/auth/signup-status', async () => ({ open: app.auth.signupOpen() }))

  app.post('/api/auth/signup', async (request, reply) => {
    const { email, password } = signupBody.parse(request.body)
    const result = await app.auth.signup({
      email,
      password,
      ip: request.ip,
      deviceToken: request.cookies[DEVICE_COOKIE],
    })
    setAuthCookies(reply, app.config, result)
    return reply.status(201).send({ user: result.user })
  })

  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = loginBody.parse(request.body)
    const result = await app.auth.login({
      email,
      password,
      ip: request.ip,
      deviceToken: request.cookies[DEVICE_COOKIE],
    })
    setAuthCookies(reply, app.config, result)
    return { user: result.user }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    app.auth.logout(request.cookies[SESSION_COOKIE])
    clearSessionCookie(reply, app.config)
    return reply.status(204).send()
  })

  app.post('/api/auth/change-password', { onRequest: app.requireAuth }, async (request, reply) => {
    const { currentPassword, newPassword } = changePasswordBody.parse(request.body)
    const { deviceToken } = await app.auth.changePassword({
      user: request.user!,
      currentPassword,
      newPassword,
      deviceToken: request.cookies[DEVICE_COOKIE],
    })
    setDeviceCookie(reply, app.config, deviceToken)
    return reply.status(204).send()
  })

  app.get('/api/auth/me', { onRequest: app.requireAuth }, async (request) => {
    const { id, email, isOwner } = request.user!
    return { user: { id, email, isOwner } }
  })
}
