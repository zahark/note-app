// Note sharing: PIN-protected shares (argon2-hashed PIN, unlock yields a short-lived HMAC token) and
// signed expiring links (`sig = HMAC-SHA256(SHARE_HMAC_KEY, note_id|exp|nonce)`, nonce in
// `share_secret`). Regenerating or stopping a share replaces the secret, which revokes every PIN, token
// and link issued before.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { AppError, badRequest, notFound } from '../errors.js'
import { getNoteSummary, updateNoteShare } from '../repos/notes.js'
import { getNoteShareState, type NoteShareState } from '../repos/publicShare.js'
import { DAY_SEC, HOUR_SEC, MINUTE_MS } from '../units.js'
import { ipKey } from './ipKey.js'
import type { PasswordService } from './password.js'
import { RateLimiter, type Clock } from './rateLimiter.js'

export const PIN_LENGTH = 8
/** Upper-case letters and digits without the look-alikes 0/O and 1/I: 32 symbols, 40 bits per PIN. */
export const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Lifetime of the token a correct PIN unlocks. */
export const SHARE_TOKEN_TTL_SEC = 30 * 60
/** Longest a signed link may live. */
export const MAX_SIGNED_TTL_SEC = 30 * DAY_SEC

/** The expiry choices offered for signed links. */
export const SIGNED_TTL_OPTIONS = {
  '1h': HOUR_SEC,
  '1d': DAY_SEC,
  '7d': 7 * DAY_SEC,
  '30d': MAX_SIGNED_TTL_SEC,
} as const
export type SignedTtlOption = keyof typeof SIGNED_TTL_OPTIONS

/** PIN unlock limits; both are checked before any database lookup or argon2 work. */
export const UNLOCK_LIMITS = {
  /** Failures per requested note id, whether or not the note exists or is PIN-shared. */
  failuresPerNote: { limit: 5, windowMs: 15 * MINUTE_MS },
  /** Attempts per client IP key (same normalization as login). */
  attemptsPerIp: { limit: 30, windowMs: 15 * MINUTE_MS },
} as const

const TOO_MANY_ATTEMPTS = 'Too many attempts, try again later'

/** The single failure response of the public share surface: wrong PIN, expired, revoked, missing. */
export const unavailable = () => new AppError(404, 'UNAVAILABLE', 'This shared note is unavailable')

/** An 8-character PIN drawn from a CSPRNG. */
export function generatePin(): string {
  let pin = ''
  for (let i = 0; i < PIN_LENGTH; i++) pin += PIN_ALPHABET[randomInt(PIN_ALPHABET.length)]
  return pin
}

/** Canonical form of a PIN typed by a visitor: trimmed, upper-case. */
export const normalizePin = (pin: string): string => pin.trim().toUpperCase()

const hmac = (key: string, message: string): string =>
  createHmac('sha256', key).update(message).digest('base64url')

/** Constant-time string comparison (false on a length mismatch). */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** `sig` of a signed link: HMAC-SHA256(key, `note_id|exp|nonce`), base64url. */
export function signLink(key: string, noteId: string, exp: number, nonce: string): string {
  return hmac(key, `${noteId}|${exp}|${nonce}`)
}

/**
 * MAC of a PIN-unlock token, bound to the note id and to the stored PIN hash (which changes on every
 * regenerate), so a token dies with the PIN it was issued for. The `token|` prefix keeps it apart from
 * link signatures made with the same key.
 */
function tokenMac(key: string, noteId: string, exp: number, secretHash: string): string {
  return hmac(key, `token|${noteId}|${exp}|${secretHash}`)
}

/** A whole number of seconds written in plain digits (no sign, exponent or fraction). */
function parseUnixSec(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,12}$/.test(value)) return undefined
  return Number(value)
}

export interface SignedShare {
  type: 'signed_url'
  /** Unix seconds. */
  exp: number
  sig: string
  /** Absolute link to the shared page. */
  url: string
}

export interface PinShare {
  type: 'password_protected'
  /** Shown to the owner once; only its argon2 hash is stored. */
  pin: string
}

export interface UnlockInput {
  noteId: string
  pin: string
  /** Client address (`request.ip`); normalized with `ipKey`. */
  ip: string
}

export interface UnlockResult {
  token: string
  /** Unix seconds. */
  expiresAt: number
}

export interface ShareServiceOptions {
  db: Db
  config: Config
  /** The app's password service, so PIN hashing shares the global argon2 concurrency cap. */
  passwords: PasswordService
  now?: Clock
}

export class ShareService {
  private readonly limits: { [K in keyof typeof UNLOCK_LIMITS]: RateLimiter }
  private readonly db: Db
  private readonly config: Config
  private readonly passwords: PasswordService
  private readonly now: Clock

  constructor({ db, config, passwords, now = Date.now }: ShareServiceOptions) {
    this.db = db
    this.config = config
    this.passwords = passwords
    this.now = now
    this.limits = {
      failuresPerNote: new RateLimiter({ ...UNLOCK_LIMITS.failuresPerNote, now }),
      attemptsPerIp: new RateLimiter({ ...UNLOCK_LIMITS.attemptsPerIp, now }),
    }
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000)
  }

  // --- owner side (owner-scoped: a foreign or missing note is 404) -------------------------------------

  /** Enables (or regenerates) a PIN share; the PIN is returned once and stored only as an argon2 hash. */
  async enablePin(userId: string, noteId: string): Promise<PinShare> {
    // no hashing for a note that is not the caller's
    if (!getNoteSummary(this.db, userId, noteId)) throw notFound('Note not found')
    const pin = generatePin()
    const hash = await this.passwords.hash(pin)
    if (!updateNoteShare(this.db, userId, noteId, { type: 'password_protected', secret: hash, expiresAt: null })) {
      throw notFound('Note not found')
    }
    return { type: 'password_protected', pin }
  }

  /** Enables (or regenerates) a signed link valid for `ttlSec` (at most 30 days), with a fresh nonce. */
  enableSigned(userId: string, noteId: string, ttlSec: number): SignedShare {
    if (!Number.isInteger(ttlSec) || ttlSec <= 0 || ttlSec > MAX_SIGNED_TTL_SEC) {
      throw badRequest('Links can be valid for at most 30 days', 'INVALID_EXPIRY')
    }
    const nonce = randomBytes(16).toString('base64url')
    const exp = this.nowSec() + ttlSec
    if (!updateNoteShare(this.db, userId, noteId, { type: 'signed_url', secret: nonce, expiresAt: exp })) {
      throw notFound('Note not found')
    }
    const sig = signLink(this.config.shareHmacKey, noteId, exp, nonce)
    const query = new URLSearchParams({ exp: String(exp), sig })
    return { type: 'signed_url', exp, sig, url: `${this.config.publicOrigin}/shared/${noteId}?${query}` }
  }

  /** Stops sharing: back to `private`, secret dropped, so every PIN, token and link stops working. */
  stop(userId: string, noteId: string): void {
    if (!updateNoteShare(this.db, userId, noteId, { type: 'private', secret: null, expiresAt: null })) {
      throw notFound('Note not found')
    }
  }

  // --- public side ---------------------------------------------------------------------------------------

  /**
   * Exchanges a PIN for a token. Order: limiter (per note id, then per IP key) → load note → argon2
   * verify. A locked id answers 429 even for the correct PIN, without touching the database or argon2.
   * Every other failure is the identical `unavailable()`; missing and non-PIN notes run a dummy verify
   * and count as failures exactly like a wrong PIN.
   */
  async unlock({ noteId, pin, ip }: UnlockInput): Promise<UnlockResult> {
    const perNote = this.limits.failuresPerNote
    const perIp = this.limits.attemptsPerIp
    const ipk = ipKey(ip)
    // Attempts still verifying are reserved as failures-to-be, so a burst of parallel guesses cannot
    // exceed the limit. The checks and the reservation below run before the first await.
    perNote.check(noteId, TOO_MANY_ATTEMPTS)
    perIp.enforce(ipk, TOO_MANY_ATTEMPTS)
    perNote.reserve(noteId)

    let ok = false
    let verified = false
    let state: NoteShareState | undefined
    try {
      state = getNoteShareState(this.db, noteId)
      const hash = state?.share_type === 'password_protected' ? state.share_secret : null
      ok = await this.passwords.verify(hash, normalizePin(pin))
      verified = true
    } finally {
      perNote.release(noteId)
      // only a completed wrong verification counts (a 503 from the hash limiter is not a guess)
      if (verified && !ok) perNote.hit(noteId)
    }
    // re-read: the share may have been regenerated or stopped while we were hashing
    const current = getNoteShareState(this.db, noteId)
    if (!ok || current?.share_type !== 'password_protected' || current.share_secret !== state?.share_secret) {
      throw unavailable()
    }
    const expiresAt = this.nowSec() + SHARE_TOKEN_TTL_SEC
    const mac = tokenMac(this.config.shareHmacKey, noteId, expiresAt, current.share_secret!)
    return { token: `${expiresAt}.${mac}`, expiresAt }
  }

  /** True when `token` was issued by `unlock` for `noteId`'s current PIN and has not expired. */
  verifyToken(noteId: string, token: string | undefined): boolean {
    const dot = token?.indexOf('.') ?? -1
    if (!token || dot < 0) return false
    const exp = parseUnixSec(token.slice(0, dot))
    if (exp === undefined || exp <= this.nowSec()) return false
    const state = getNoteShareState(this.db, noteId)
    if (state?.share_type !== 'password_protected' || !state.share_secret) return false
    return safeEqual(token.slice(dot + 1), tokenMac(this.config.shareHmacKey, noteId, exp, state.share_secret))
  }

  /** True when `exp`/`sig` form an unexpired link signed with `noteId`'s current nonce. */
  verifySignedLink(noteId: string, exp: string | undefined, sig: string | undefined): boolean {
    const expSec = parseUnixSec(exp)
    if (expSec === undefined || !sig || expSec <= this.nowSec()) return false
    const state = getNoteShareState(this.db, noteId)
    if (state?.share_type !== 'signed_url' || !state.share_secret) return false
    return safeEqual(sig, signLink(this.config.shareHmacKey, noteId, expSec, state.share_secret))
  }
}
