import { createHmac, randomBytes } from 'node:crypto'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { AppError, conflict, tooManyRequests } from '../errors.js'
import { createKnownDevice, findKnownDevice, touchKnownDevice, type KnownDeviceRow } from '../repos/knownDevices.js'
import {
  createSession,
  deleteExpiredSessions,
  deleteSessionByTokenHash,
  findSession,
} from '../repos/sessions.js'
import { createUser, EmailTakenError, findUserByEmail, type UserRow } from '../repos/users.js'
import { HashLimiter } from './hashLimiter.js'
import { ipKey } from './ipKey.js'
import { LoginGate } from './loginGate.js'
import { argon2Hasher, assertValidPassword, PasswordService, type PasswordHasher } from './password.js'
import { RateLimiter, type Clock } from './ratelimit.js'

export const SESSION_TTL_SEC = 30 * 24 * 60 * 60
export const DEVICE_TTL_SEC = 365 * 24 * 60 * 60

const MINUTE = 60_000
/** Rate limits (all checked before any argon2 work). */
export const AUTH_LIMITS = {
  loginFailuresPerIp: { limit: 30, windowMs: 15 * MINUTE },
  loginFailuresPerAccountIp: { limit: 10, windowMs: 15 * MINUTE },
  loginSuccessesPerAccount: { limit: 20, windowMs: 15 * MINUTE },
  loginSuccessesPerIp: { limit: 20, windowMs: 15 * MINUTE },
  signupsPerIp: { limit: 5, windowMs: 60 * MINUTE },
} as const

/** The authenticated user as exposed to routes and the API. */
export interface AuthUser {
  id: string
  email: string
  isOwner: boolean
}

export interface AuthResult {
  user: AuthUser
  /** Raw session token for the session cookie. */
  sessionToken: string
  /** Raw device token for the device cookie (the presented one when it was reused). */
  deviceToken: string
}

export interface Credentials {
  /** Normalized (trimmed, lower-cased) email. */
  email: string
  password: string
  /** Client address (`request.ip`); normalized with `ipKey` for the per-IP limits. */
  ip: string
  /** Raw device-cookie value, if the browser sent one. */
  deviceToken?: string | undefined
}

export interface AuthServiceOptions {
  db: Db
  config: Config
  hasher?: PasswordHasher
  hashLimiter?: HashLimiter
  now?: Clock
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')

const toAuthUser = (u: Pick<UserRow, 'id' | 'email' | 'is_owner'>): AuthUser => ({
  id: u.id,
  email: u.email,
  isOwner: u.is_owner === 1,
})

/** Signup, login, logout and session lookup, with every limit from the plan's Technical Details. */
export class AuthService {
  readonly passwords: PasswordService
  readonly gate: LoginGate
  readonly limits: { [K in keyof typeof AUTH_LIMITS]: RateLimiter }
  private readonly db: Db
  private readonly config: Config
  private readonly now: Clock

  constructor({ db, config, hasher = argon2Hasher, hashLimiter = new HashLimiter(), now = Date.now }: AuthServiceOptions) {
    this.db = db
    this.config = config
    this.now = now
    this.passwords = new PasswordService(hasher, hashLimiter)
    this.gate = new LoginGate({ now })
    const limiter = (o: { limit: number; windowMs: number }) => new RateLimiter({ ...o, now })
    this.limits = {
      loginFailuresPerIp: limiter(AUTH_LIMITS.loginFailuresPerIp),
      loginFailuresPerAccountIp: limiter(AUTH_LIMITS.loginFailuresPerAccountIp),
      loginSuccessesPerAccount: limiter(AUTH_LIMITS.loginSuccessesPerAccount),
      loginSuccessesPerIp: limiter(AUTH_LIMITS.loginSuccessesPerIp),
      signupsPerIp: limiter(AUTH_LIMITS.signupsPerIp),
    }
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000)
  }

  /** Cookie tokens are stored only as HMAC-SHA256(SESSION_SECRET, token). */
  tokenHash(token: string): string {
    return createHmac('sha256', this.config.sessionSecret).update(token).digest('hex')
  }

  /** Throws 429 (with Retry-After) when `limiter` is exhausted for `key`. */
  private enforce(limiter: RateLimiter, key: string): void {
    if (limiter.isLimited(key)) {
      throw tooManyRequests('Too many attempts, try again later', limiter.retryAfterMs(key))
    }
  }

  async signup({ email, password, ip }: Credentials): Promise<AuthResult> {
    if (!this.config.allowSignup) throw new AppError(403, 'SIGNUP_DISABLED', 'Signup is disabled')
    assertValidPassword(password)
    const ipk = ipKey(ip)
    this.enforce(this.limits.signupsPerIp, ipk)
    this.limits.signupsPerIp.hit(ipk)
    if (findUserByEmail(this.db, email)) throw conflict('Email already registered', 'EMAIL_TAKEN')

    const hash = await this.passwords.hash(password)
    let user: UserRow
    try {
      user = createUser(this.db, email, hash)
    } catch (err) {
      if (err instanceof EmailTakenError) throw conflict('Email already registered', 'EMAIL_TAKEN')
      throw err
    }
    return this.startSession(user, undefined)
  }

  async login({ email, password, ip, deviceToken }: Credentials): Promise<AuthResult> {
    const ipk = ipKey(ip)
    const pairKey = `${ipk}\n${email}`
    // every check below runs before any argon2 work
    this.enforce(this.limits.loginSuccessesPerAccount, email)
    this.enforce(this.limits.loginSuccessesPerIp, ipk)
    this.enforce(this.limits.loginFailuresPerIp, ipk)
    this.enforce(this.limits.loginFailuresPerAccountIp, pairKey)

    const user = findUserByEmail(this.db, email)
    const device = user && deviceToken ? this.knownDeviceFor(user.id, deviceToken) : undefined

    // A valid device cookie for this very account skips only the delay gate. Without one, the gate's
    // synchronous check-and-set must happen before the first await below.
    if (!device) {
      const entry = this.gate.tryEnter(email)
      if (!entry.ok) throw tooManyRequests('Too many attempts, try again later', entry.retryAfterMs)
    }

    const reserved = device !== undefined && user?.is_owner === 1
    const ok = await this.passwords.verify(user?.password_hash ?? null, password, { reserved })
    if (!ok || !user) {
      this.limits.loginFailuresPerIp.hit(ipk)
      this.limits.loginFailuresPerAccountIp.hit(pairKey)
      this.gate.recordFailure(email)
      throw invalidCredentials()
    }

    this.gate.recordSuccess(email)
    this.limits.loginSuccessesPerAccount.hit(email)
    this.limits.loginSuccessesPerIp.hit(ipk)
    return this.startSession(user, device && deviceToken ? { row: device, token: deviceToken } : undefined)
  }

  /** The `known_devices` row for `token` if it exists, belongs to `userId` and has not expired. */
  private knownDeviceFor(userId: string, token: string): KnownDeviceRow | undefined {
    const row = findKnownDevice(this.db, this.tokenHash(token))
    if (!row || row.user_id !== userId) return undefined
    if (row.last_used_at <= this.nowSec() - DEVICE_TTL_SEC) return undefined
    return row
  }

  /** Creates a session; reuses the presented device row or registers a new device. */
  private startSession(
    user: UserRow,
    device: { row: KnownDeviceRow; token: string } | undefined,
  ): AuthResult {
    const nowSec = this.nowSec()
    deleteExpiredSessions(this.db, nowSec)
    const sessionToken = randomBytes(32).toString('base64url')
    createSession(this.db, user.id, this.tokenHash(sessionToken), nowSec + SESSION_TTL_SEC)

    let deviceToken: string
    if (device) {
      touchKnownDevice(this.db, device.row.id, nowSec)
      deviceToken = device.token
    } else {
      deviceToken = randomBytes(32).toString('base64url')
      createKnownDevice(this.db, user.id, this.tokenHash(deviceToken), nowSec)
    }
    return { user: toAuthUser(user), sessionToken, deviceToken }
  }

  /** Deletes the session for `sessionToken`, if any. */
  logout(sessionToken: string | undefined): void {
    if (sessionToken) deleteSessionByTokenHash(this.db, this.tokenHash(sessionToken))
  }

  /** The user owning the unexpired session for `sessionToken`, or undefined. */
  sessionUser(sessionToken: string | undefined): (AuthUser & { sessionId: string }) | undefined {
    if (!sessionToken) return undefined
    const s = findSession(this.db, this.tokenHash(sessionToken), this.nowSec())
    if (!s) return undefined
    return { ...toAuthUser({ id: s.user_id, email: s.email, is_owner: s.is_owner }), sessionId: s.session_id }
  }
}
