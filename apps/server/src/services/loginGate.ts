import { DAY_MS } from '../units.js'
import type { Clock } from './rateLimiter.js'

/** Failures allowed before any delay applies. */
export const GATE_FREE_FAILURES = 5
export const GATE_BASE_DELAY_MS = 250
export const GATE_MAX_DELAY_MS = 5000
/** An account with no attempt for this long is forgotten (bounds memory; idle means nobody is guessing). */
const GATE_IDLE_FORGET_MS = DAY_MS
const SWEEP_EVERY = 1000

/** Delay opened by an attempt made after `failures` consecutive failures. */
export function gateDelayMs(failures: number): number {
  if (failures < GATE_FREE_FAILURES) return 0
  return Math.min(2 ** (failures - GATE_FREE_FAILURES) * GATE_BASE_DELAY_MS, GATE_MAX_DELAY_MS)
}

export type GateResult = { ok: true } | { ok: false; retryAfterMs: number }

interface GateState {
  failures: number
  /** Attempts let through by `tryEnter` that have not finished yet (each may still become a failure). */
  pending: number
  nextAllowedAt: number
  lastSeenAt: number
}

/**
 * Per-account login delay gate, keyed by the normalized email string (unknown emails behave identically).
 *
 * `tryEnter` is fully synchronous: it checks `now < nextAllowedAt` and, if the attempt may proceed,
 * immediately sets `nextAllowedAt = now + delay` before returning. The caller must call it before its
 * first `await`; because Node runs it without yielding, at most one attempt per account gets through per
 * window no matter how many arrive in parallel. Rejected attempts are refused, never queued.
 *
 * Attempts still verifying count as failures-to-be when the delay is computed, so a parallel burst sent
 * before any failure has been recorded still meets the delay after the 5th attempt. Every attempt let
 * through must be finished with exactly one of `recordFailure`, `recordSuccess` or `release`.
 */
export class LoginGate {
  private readonly now: Clock
  private readonly state = new Map<string, GateState>()
  private opsSinceSweep = 0

  constructor({ now = Date.now }: { now?: Clock } = {}) {
    this.now = now
  }

  tryEnter(key: string): GateResult {
    const now = this.now()
    if (++this.opsSinceSweep >= SWEEP_EVERY) this.sweep(now)
    const s = this.entry(key, now)
    if (now < s.nextAllowedAt) return { ok: false, retryAfterMs: s.nextAllowedAt - now }
    s.nextAllowedAt = now + gateDelayMs(s.failures + s.pending)
    s.pending++
    return { ok: true }
  }

  /** Finishes an attempt as a wrong password. */
  recordFailure(key: string): void {
    const s = this.entry(key, this.now())
    s.pending = Math.max(0, s.pending - 1)
    s.failures++
  }

  /** Finishes an attempt as a successful login: resets the account's failures and delay. */
  recordSuccess(key: string): void {
    const s = this.entry(key, this.now())
    s.pending = Math.max(0, s.pending - 1)
    s.failures = 0
    s.nextAllowedAt = 0
    if (s.pending === 0) this.state.delete(key)
  }

  /** Finishes an attempt that never got a verdict (e.g. the hash limiter answered 503): not a failure. */
  release(key: string): void {
    const s = this.state.get(key)
    if (!s) return
    s.pending = Math.max(0, s.pending - 1)
  }

  private entry(key: string, now: number): GateState {
    let s = this.state.get(key)
    if (!s) {
      s = { failures: 0, pending: 0, nextAllowedAt: 0, lastSeenAt: now }
      this.state.set(key, s)
    }
    s.lastSeenAt = now
    return s
  }

  private sweep(now: number): void {
    this.opsSinceSweep = 0
    for (const [key, s] of this.state) {
      if (s.pending === 0 && now - s.lastSeenAt > GATE_IDLE_FORGET_MS && now >= s.nextAllowedAt) {
        this.state.delete(key)
      }
    }
  }
}
