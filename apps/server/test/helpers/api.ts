// Fixtures for the private API tests: logged-in users and an authenticated request helper.
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { cookieValue, login, ORIGIN, seedUser, type TestApp } from './auth.js'

export interface TestUser {
  id: string
  sid: string
}

/** Seeds a user and logs them in, returning their id and session token. */
export async function loginAs(t: TestApp, email: string): Promise<TestUser> {
  const id = seedUser(t.db, email)
  const res = await login(t.app, { email })
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`)
  return { id, sid: cookieValue(res, 'sid') }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** An authenticated request (session cookie plus the exact Origin every mutating request needs). */
export function api(
  app: FastifyInstance,
  user: TestUser | null,
  method: Method,
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { origin: ORIGIN },
    cookies: user ? { sid: user.sid } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
}

export const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})
