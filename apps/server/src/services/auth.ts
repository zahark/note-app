import { createHmac, randomBytes } from 'node:crypto'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { AppError, conflict, tooManyRequests, unauthorized } from '../errors.js'
import {
  createKnownDevice,
  deleteExpiredKnownDevices,
  deleteUserKnownDevices,
  findKnownDevice,
  touchKnownDevice,
  type KnownDeviceRow,
} from '../repos/knownDevices.js'
import {
  createSession,
  deleteExpiredSessions,
  deleteSessionByTokenHash,
  deleteUserSessions,
  extendSession,
  findSession,
  sessionExists,
} from '../repos/sessions.js'
import {
  createUser,
  EmailTakenError,
  findUserByEmail,
  findUserById,
  hasUsers,
  NotFirstUserError,
  updatePasswordHash,
  type UserRow,
} from '../repos/users.js'
import { DAY_SEC, MINUTE_MS } from '../units.js'
import { HashLimiter } from './hashLimiter.js'
import { ipKey } from './ipKey.js'
import { LoginGate } from './loginGate.js'
import { argon2Hasher, assertValidPassword, PasswordService, type PasswordHasher } from './password.js'
import { RateLimiter, type Clock } from './rateLimiter.js'

export const SESSION_TTL_SEC = 30 * DAY_SEC
/** A session used with less than this left is extended to a full `SESSION_TTL_SEC` again (sliding). */
export const SESSION_RENEW_BELOW_SEC = SESSION_TTL_SEC / 2
export const DEVICE_TTL_SEC = 365 * DAY_SEC

/** Rate limits (all checked before any argon2 work). */
export const AUTH_LIMITS = {
  loginFailuresPerIp: { limit: 30, windowMs: 15 * MINUTE_MS },
  loginFailuresPerAccountIp: { limit: 10, windowMs: 15 * MINUTE_MS },
  loginSuccessesPerAccount: { limit: 20, windowMs: 15 * MINUTE_MS },
  loginSuccessesPerIp: { limit: 20, windowMs: 15 * MINUTE_MS },
  signupsPerIp: { limit: 5, windowMs: 60 * MINUTE_MS },
  changePasswordPerUser: { limit: 5, windowMs: 15 * MINUTE_MS },
} as const

const TOO_MANY_ATTEMPTS = 'Too many attempts, try again later'

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
  /**
   * Raw device token for the device cookie (the presented one when it was reused). Undefined when the
   * browser holds a still-valid device cookie of another account: that cookie is kept, not replaced.
   */
  deviceToken: string | undefined
}

/** An authenticated session: its user, and whether this lookup extended the session's expiry. */
export interface SessionLookup {
  user: AuthUser & { sessionId: string }
  renewed: boolean
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

export interface ChangePasswordInput {
  /** The signed-in user (from `requireAuth`); their current session is kept. */
  user: AuthUser & { sessionId: string }
  currentPassword: string
  newPassword: string
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

const signupDisabled = (): AppError => new AppError(403, 'SIGNUP_DISABLED', 'Signup is disabled')

const toAuthUser = (u: Pick<UserRow, 'id' | 'email' | 'is_owner'>): AuthUser => ({
  id: u.id,
  email: u.email,
  isOwner: u.is_owner === 1,
})

/** A fresh random cookie token (session or device); stored only as its `tokenHash`. */
const newToken = (): string => randomBytes(32).toString('base64url')

/**
 * Signup, login, logout, password change and session lookup, with their rate limits (`AUTH_LIMITS`),
 * the per-account login gate and the argon2 concurrency cap.
 */
export class AuthService {
  readonly passwords: PasswordService
  private readonly gate: LoginGate
  private readonly limits: { [K in keyof typeof AUTH_LIMITS]: RateLimiter }
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
      changePasswordPerUser: limiter(AUTH_LIMITS.changePasswordPerUser),
    }
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000)
  }

  /** Cookie tokens are stored only as HMAC-SHA256(SESSION_SECRET, token). */
  tokenHash(token: string): string {
    return createHmac('sha256', this.config.sessionSecret).update(token).digest('hex')
  }

  /**
   * Whether `POST /api/auth/signup` currently accepts new accounts: always with ALLOW_SIGNUP=true, never
   * with ALLOW_SIGNUP=false, and by default only while no account exists (the owner's first-run signup).
   */
  signupOpen(): boolean {
    const mode = this.config.signupMode
    return mode === 'open' || (mode === 'first-user' && !hasUsers(this.db))
  }

  async signup({ email, password, ip, deviceToken }: Credentials): Promise<AuthResult> {
    if (!this.signupOpen()) throw signupDisabled()
    assertValidPassword(password)
    const ipk = ipKey(ip)
    this.limits.signupsPerIp.enforce(ipk, TOO_MANY_ATTEMPTS)
    if (findUserByEmail(this.db, email)) throw conflict('Email already registered', 'EMAIL_TAKEN')

    const hash = await this.passwords.hash(password)
    let user: UserRow
    try {
      // first-user mode re-checks emptiness in the insert's transaction: of simultaneous first signups,
      // only one creates an account
      user = createUser(this.db, email, hash, { onlyIfFirst: this.config.signupMode === 'first-user' })
    } catch (err) {
      if (err instanceof NotFirstUserError) throw signupDisabled()
      if (err instanceof EmailTakenError) throw conflict('Email already registered', 'EMAIL_TAKEN')
      throw err
    }
    return this.startSession(user, undefined, deviceToken)
  }

  async login({ email, password, ip, deviceToken }: Credentials): Promise<AuthResult> {
    const ipk = ipKey(ip)
    const pairKey = `${ipk}\n${email}`
    const { loginFailuresPerIp, loginFailuresPerAccountIp } = this.limits
    // Every check and reservation below runs synchronously, before any argon2 work (the first await).
    // Attempts still verifying are reserved on the failure limits, so a parallel burst cannot exceed them.
    this.limits.loginSuccessesPerAccount.check(email, TOO_MANY_ATTEMPTS)
    this.limits.loginSuccessesPerIp.check(ipk, TOO_MANY_ATTEMPTS)
    loginFailuresPerIp.check(ipk, TOO_MANY_ATTEMPTS)
    loginFailuresPerAccountIp.check(pairKey, TOO_MANY_ATTEMPTS)

    const user = findUserByEmail(this.db, email)
    const device = user && deviceToken ? this.knownDeviceFor(user.id, deviceToken) : undefined

    // A valid device cookie for this very account skips only the delay gate.
    if (!device) {
      const entry = this.gate.tryEnter(email)
      if (!entry.ok) throw tooManyRequests(TOO_MANY_ATTEMPTS, entry.retryAfterMs)
    }
    const gated = !device
    loginFailuresPerIp.reserve(ipk)
    loginFailuresPerAccountIp.reserve(pairKey)

    let ok = false
    let verified = false
    try {
      const reserved = device !== undefined && user?.is_owner === 1
      ok = await this.passwords.verify(user?.password_hash ?? null, password, { reserved })
      verified = true
    } finally {
      loginFailuresPerIp.release(ipk)
      loginFailuresPerAccountIp.release(pairKey)
      // only a completed wrong verification is a failure (a 503 from the hash limiter is not a guess)
      if (verified && (!ok || !user)) {
        loginFailuresPerIp.hit(ipk)
        loginFailuresPerAccountIp.hit(pairKey)
        if (gated) this.gate.recordFailure(email)
      } else if (verified) {
        if (gated) this.gate.recordSuccess(email)
      } else if (gated) {
        this.gate.release(email)
      }
    }
    if (!ok || !user) throw invalidCredentials()

    this.limits.loginSuccessesPerAccount.hit(email)
    this.limits.loginSuccessesPerIp.hit(ipk)
    return this.startSession(user, device && deviceToken ? { row: device, token: deviceToken } : undefined, deviceToken)
  }

  /** The `known_devices` row for `token` if it exists, belongs to `userId` and has not expired. */
  private knownDeviceFor(userId: string, token: string): KnownDeviceRow | undefined {
    const row = findKnownDevice(this.db, this.tokenHash(token))
    if (!row || row.user_id !== userId) return undefined
    if (row.last_used_at <= this.nowSec() - DEVICE_TTL_SEC) return undefined
    return row
  }

  /**
   * True when `token` is a still-valid device of an account other than `userId`. Such a cookie is never
   * replaced, so an owner who signs in to a second account in the same browser keeps a known owner device.
   */
  private isOtherAccountsDevice(userId: string, token: string | undefined): boolean {
    if (!token) return false
    const row = findKnownDevice(this.db, this.tokenHash(token))
    return row !== undefined && row.user_id !== userId && row.last_used_at > this.nowSec() - DEVICE_TTL_SEC
  }

  /**
   * Creates a session; reuses the presented device row, keeps another account's valid device cookie
   * untouched (no device for this login), or registers a new device. Also prunes the user's expired
   * sessions' and devices' rows.
   */
  private startSession(
    user: UserRow,
    device: { row: KnownDeviceRow; token: string } | undefined,
    presentedDeviceToken: string | undefined,
  ): AuthResult {
    const nowSec = this.nowSec()
    deleteExpiredSessions(this.db, nowSec)
    deleteExpiredKnownDevices(this.db, user.id, nowSec - DEVICE_TTL_SEC)
    const sessionToken = newToken()
    createSession(this.db, user.id, this.tokenHash(sessionToken), nowSec + SESSION_TTL_SEC)

    let deviceToken: string | undefined
    if (device) {
      touchKnownDevice(this.db, device.row.id, nowSec)
      deviceToken = device.token
    } else if (!this.isOtherAccountsDevice(user.id, presentedDeviceToken)) {
      deviceToken = newToken()
      createKnownDevice(this.db, user.id, this.tokenHash(deviceToken), nowSec)
    }
    return { user: toAuthUser(user), sessionToken, deviceToken }
  }

  /**
   * Changes the signed-in user's password. Every other session and every known device of the user is
   * dropped; the current session is kept and gets a fresh device, whose raw token is returned for the
   * device cookie (undefined, and no device registered, when the browser holds another account's valid
   * device cookie, which is kept). Limited to 5 attempts / 15 min per user, checked before any argon2
   * work. Only an owner session may use the reserved hash slot.
   */
  async changePassword({
    user,
    currentPassword,
    newPassword,
    deviceToken: presentedDeviceToken,
  }: ChangePasswordInput): Promise<{ deviceToken: string | undefined }> {
    this.limits.changePasswordPerUser.check(user.id, TOO_MANY_ATTEMPTS)
    assertValidPassword(newPassword)
    this.limits.changePasswordPerUser.hit(user.id)

    const row = findUserById(this.db, user.id)
    if (!row) throw unauthorized()
    const reserved = row.is_owner === 1
    if (!(await this.passwords.verify(row.password_hash, currentPassword, { reserved }))) {
      throw new AppError(403, 'WRONG_PASSWORD', 'Current password is incorrect')
    }
    const hash = await this.passwords.hash(newPassword, { reserved })

    const keepOther = this.isOtherAccountsDevice(user.id, presentedDeviceToken)
    const deviceToken = keepOther ? undefined : newToken()
    this.db.transaction(() => {
      // the session may have been revoked (logout, reset CLI) while we were hashing
      if (!sessionExists(this.db, user.sessionId)) throw unauthorized()
      updatePasswordHash(this.db, user.id, hash)
      deleteUserSessions(this.db, user.id, user.sessionId)
      deleteUserKnownDevices(this.db, user.id)
      if (deviceToken) createKnownDevice(this.db, user.id, this.tokenHash(deviceToken), this.nowSec())
    }).immediate()
    return { deviceToken }
  }

  /** Deletes the session for `sessionToken`, if any. */
  logout(sessionToken: string | undefined): void {
    if (sessionToken) deleteSessionByTokenHash(this.db, this.tokenHash(sessionToken))
  }

  /**
   * The user owning the unexpired session for `sessionToken`, or undefined. Sliding expiry: a session
   * used with less than `SESSION_RENEW_BELOW_SEC` (15 days) left is extended to a full 30 days again
   * (`renewed`, so the caller re-sets the cookie).
   */
  sessionUser(sessionToken: string | undefined): SessionLookup | undefined {
    if (!sessionToken) return undefined
    const nowSec = this.nowSec()
    const s = findSession(this.db, this.tokenHash(sessionToken), nowSec)
    if (!s) return undefined
    const renewed = s.expires_at - nowSec < SESSION_RENEW_BELOW_SEC
    if (renewed) extendSession(this.db, s.session_id, nowSec + SESSION_TTL_SEC)
    return {
      user: { ...toAuthUser({ id: s.user_id, email: s.email, is_owner: s.is_owner }), sessionId: s.session_id },
      renewed,
    }
  }
}
