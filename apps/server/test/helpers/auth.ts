// Shared fixtures for the auth tests: an app with a fake clock, a counting/blocking fake hasher,
// and small request helpers.
import type { FastifyInstance, LightMyRequestResponse, RouteOptions } from 'fastify'
import { buildApp } from '../../src/app.js'
import { loadConfig, type Config } from '../../src/config.js'
import { openDb, type Db } from '../../src/db/index.js'
import { createUser } from '../../src/repos/users.js'
import { HashLimiter } from '../../src/services/hashLimiter.js'
import type { PasswordHasher } from '../../src/services/password.js'

export const ORIGIN = 'http://localhost:3000'
export const PASSWORD = 'correct horse battery'

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    SESSION_SECRET: 'a'.repeat(32),
    SHARE_HMAC_KEY: 'b'.repeat(32),
    PUBLIC_ORIGIN: ORIGIN,
    ...env,
  })
}

/**
 * Stand-in for argon2: counts every call, tracks how many run at once, and can hold calls for chosen
 * passwords until `release()` so tests can occupy hash slots.
 */
export class FakeHasher implements PasswordHasher {
  hashCalls = 0
  verifyCalls = 0
  active = 0
  maxActive = 0
  /** Calls whose password is in this set block until `release()`. */
  readonly blocked = new Set<string>()
  private waiting: Array<() => void> = []

  get calls(): number {
    return this.hashCalls + this.verifyCalls
  }

  release(): void {
    const waiting = this.waiting
    this.waiting = []
    for (const resume of waiting) resume()
  }

  private async work(password: string): Promise<void> {
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      if (this.blocked.has(password)) await new Promise<void>((r) => this.waiting.push(r))
      else await Promise.resolve()
    } finally {
      this.active--
    }
  }

  async hash(password: string): Promise<string> {
    this.hashCalls++
    await this.work(password)
    return `fake$${password}`
  }

  async verify(hash: string, password: string): Promise<boolean> {
    this.verifyCalls++
    await this.work(password)
    return hash === `fake$${password}`
  }
}

export class FakeClock {
  t = 1_800_000_000_000
  readonly now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
}

export interface TestApp {
  app: FastifyInstance
  db: Db
  hasher: FakeHasher
  clock: FakeClock
  config: Config
}

export async function makeApp(
  opts: {
    env?: Record<string, string>
    hashWaitMs?: number
    /** Called for every route registered (an `onRoute` hook installed before the app is ready). */
    onRoute?: (route: RouteOptions) => void
  } = {},
): Promise<TestApp> {
  const db = openDb(':memory:')
  const hasher = new FakeHasher()
  const clock = new FakeClock()
  const config = testConfig(opts.env)
  const hashLimiter = new HashLimiter({ maxWaitMs: opts.hashWaitMs ?? 2000 })
  const app = buildApp({ config, db, auth: { hasher, hashLimiter, now: clock.now } })
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute)
  await app.ready()
  return { app, db, hasher, clock, config }
}

export async function closeApp(t: TestApp): Promise<void> {
  t.hasher.release()
  await t.app.close()
  t.db.close()
}

/** Inserts a user directly (bypassing signup limits) with a password the fake hasher accepts. */
export function seedUser(db: Db, email: string, password = PASSWORD): string {
  return createUser(db, email, `fake$${password}`).id
}

export interface AuthRequest {
  email: string
  password?: string
  ip?: string
  cookies?: Record<string, string>
  origin?: string | null
}

const authHeaders = (origin: string | null | undefined): Record<string, string> =>
  origin === null ? {} : { origin: origin ?? ORIGIN }

export function login(app: FastifyInstance, r: AuthRequest): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: r.ip ?? '127.0.0.1',
    headers: authHeaders(r.origin),
    cookies: r.cookies ?? {},
    payload: { email: r.email, password: r.password ?? PASSWORD },
  })
}

export function signup(app: FastifyInstance, r: AuthRequest): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    remoteAddress: r.ip ?? '127.0.0.1',
    headers: authHeaders(r.origin),
    cookies: r.cookies ?? {},
    payload: { email: r.email, password: r.password ?? PASSWORD },
  })
}

export function me(app: FastifyInstance, sid: string | undefined): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: '/api/auth/me', cookies: sid ? { sid } : {} })
}

export function cookie(res: LightMyRequestResponse, name: string) {
  return res.cookies.find((c) => c.name === name)
}

export function cookieValue(res: LightMyRequestResponse, name: string): string {
  const c = cookie(res, name)
  if (!c) throw new Error(`response has no ${name} cookie`)
  return c.value
}

export const errorCode = (res: LightMyRequestResponse): string =>
  (res.json() as { error: { code: string } }).error.code

export interface ChangePasswordRequest {
  sid: string
  currentPassword?: string
  newPassword: string
  cookies?: Record<string, string>
}

export function changePassword(app: FastifyInstance, r: ChangePasswordRequest): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { origin: ORIGIN },
    cookies: { ...r.cookies, sid: r.sid },
    payload: { currentPassword: r.currentPassword ?? PASSWORD, newPassword: r.newPassword },
  })
}
