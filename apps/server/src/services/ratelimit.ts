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
 * Callers check `isLimited(key)` **before** doing any expensive work, and `hit(key)` to record
 * whatever event is being limited (a failure, a success, an attempt).
 */
export class RateLimiter {
  readonly limit: number
  readonly windowMs: number
  private readonly now: Clock
  private readonly hits = new Map<string, number[]>()
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

  /** True when `key` already has `limit` hits inside the window, so the next action must be refused. */
  isLimited(key: string): boolean {
    return this.count(key) >= this.limit
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

  /** Forgets every hit for `key`. */
  reset(key: string): void {
    this.hits.delete(key)
  }

  /** Drops keys whose hits have all left the window, bounding memory. */
  private sweep(now: number): void {
    this.hitsSinceSweep = 0
    for (const key of [...this.hits.keys()]) this.live(key, now)
  }
}
