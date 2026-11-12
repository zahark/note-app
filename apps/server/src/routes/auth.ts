import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  clearSessionCookie,
  DEVICE_COOKIE,
  SESSION_COOKIE,
  setAuthCookies,
  setDeviceCookie,
} from '../plugins/session.js'

const signupBody = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Invalid email address')),
  // the password policy itself is applied by validatePassword in the service
  password: z.string().max(4096),
})

const loginBody = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  // no policy check at login, just a bound on the work a request can ask for
  password: z.string().min(1).max(1024),
})

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  // the policy is applied by validatePassword in the service
  newPassword: z.string().max(4096),
})

/** `POST /api/auth/signup|login|logout|change-password`, `GET /api/auth/me`. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/signup', async (request, reply) => {
    const { email, password } = signupBody.parse(request.body)
    const result = await app.auth.signup({ email, password, ip: request.ip })
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

  app.post('/api/auth/change-password', { preHandler: app.requireAuth }, async (request, reply) => {
    const { currentPassword, newPassword } = changePasswordBody.parse(request.body)
    const { deviceToken } = await app.auth.changePassword({ user: request.user!, currentPassword, newPassword })
    setDeviceCookie(reply, app.config, deviceToken)
    return reply.status(204).send()
  })

  app.get('/api/auth/me', { preHandler: app.requireAuth }, async (request) => {
    const { id, email, isOwner } = request.user!
    return { user: { id, email, isOwner } }
  })
}
