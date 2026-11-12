import { tooManyRequests } from '../errors.js'

/** Clock in milliseconds; injectable so tests can move time. */
export type Clock = () => number

export interface RateLimiterOptions {
  /** Maximum number of hits allowed inside one window. */
  limit: number
  windowMs: number
  now?: Clock
}

/** How many `hit` calls between sweeps of keys whose hits have all aged out. */
const SWEEP_EVERY = 1000

/**
 * Generic in-memory sliding-window counter (single process; a restart clears it).
 * Callers check `isLimited(key)` (or `check`/`enforce`, which throw the 429) **before** doing any
 * expensive work, and `hit(key)` to record whatever event is being limited (a failure, a success, an
 * attempt). An outcome that is only known after an await (a failed password check) is `reserve`d before
 * the await and `release`d after it, so a parallel burst cannot pass the check before any of its hits
 * has been recorded.
 */
export class RateLimiter {
  readonly limit: number
  readonly windowMs: number
  private readonly now: Clock
  private readonly hits = new Map<string, number[]>()
  /** Reservations per key: attempts in flight whose outcome may still become a hit. */
  private readonly reserved = new Map<string, number>()
  private hitsSinceSweep = 0

  constructor({ limit, windowMs, now = Date.now }: RateLimiterOptions) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
  }

  /** Timestamps of `key`'s hits still inside the window (pruning the rest). */
  private live(key: string, now: number): number[] {
    const list = this.hits.get(key)
    if (!list) return []
    const cutoff = now - this.windowMs
    let drop = 0
    while (drop < list.length && (list[drop] ?? 0) <= cutoff) drop++
    if (drop > 0) list.splice(0, drop)
    if (list.length === 0) this.hits.delete(key)
    return list
  }

  /** Number of hits recorded for `key` inside the current window. */
  count(key: string): number {
    return this.live(key, this.now()).length
  }

  /**
   * True when `key`'s hits inside the window plus its outstanding reservations reach `limit`, so the next
   * action must be refused.
   */
  isLimited(key: string): boolean {
    return this.count(key) + (this.reserved.get(key) ?? 0) >= this.limit
  }

  /** Throws 429 `message` (with Retry-After) when `key` is limited. */
  check(key: string, message: string): void {
    if (this.isLimited(key)) throw tooManyRequests(message, this.retryAfterMs(key))
  }

  /** `check`, then records the attempt as a hit. */
  enforce(key: string, message: string): void {
    this.check(key, message)
    this.hit(key)
  }

  /** Counts one in-flight attempt of `key` as a hit-to-be until `release`. */
  reserve(key: string): void {
    this.reserved.set(key, (this.reserved.get(key) ?? 0) + 1)
  }

  /** Drops one reservation of `key` (call it in a `finally`, then `hit` if the outcome counts). */
  release(key: string): void {
    const left = (this.reserved.get(key) ?? 0) - 1
    if (left > 0) this.reserved.set(key, left)
    else this.reserved.delete(key)
  }

  /** Milliseconds until `key` is no longer limited (0 when it is not limited). */
  retryAfterMs(key: string): number {
    const now = this.now()
    const list = this.live(key, now)
    if (list.length < this.limit) return 0
    // the oldest hit that still counts towards the limit has to age out
    const oldest = list[list.length - this.limit] ?? now
    return Math.max(0, oldest + this.windowMs - now)
  }

  /** Records one hit for `key`. */
  hit(key: string): void {
    const now = this.now()
    const list = this.live(key, now)
    list.push(now)
    // only the newest `limit` hits can ever matter
    if (list.length > this.limit) list.splice(0, list.length - this.limit)
    this.hits.set(key, list)
    if (++this.hitsSinceSweep >= SWEEP_EVERY) this.sweep(now)
  }

  /** Drops keys whose hits have all left the window, bounding memory. */
  private sweep(now: number): void {
    this.hitsSinceSweep = 0
    for (const key of [...this.hits.keys()]) this.live(key, now)
  }
}
