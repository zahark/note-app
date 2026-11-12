import type { Clock } from './ratelimit.js'

/** Failures allowed before any delay applies. */
export const GATE_FREE_FAILURES = 5
export const GATE_BASE_DELAY_MS = 250
export const GATE_MAX_DELAY_MS = 5000
/** An account with no attempt for this long is forgotten (bounds memory; idle means nobody is guessing). */
const GATE_IDLE_FORGET_MS = 24 * 60 * 60 * 1000
const SWEEP_EVERY = 1000

/** Delay opened by an attempt made after `failures` consecutive failures. */
export function gateDelayMs(failures: number): number {
  if (failures < GATE_FREE_FAILURES) return 0
  return Math.min(2 ** (failures - GATE_FREE_FAILURES) * GATE_BASE_DELAY_MS, GATE_MAX_DELAY_MS)
}

export type GateResult = { ok: true } | { ok: false; retryAfterMs: number }

interface GateState {
  failures: number
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
    const s = this.state.get(key) ?? { failures: 0, nextAllowedAt: 0, lastSeenAt: now }
    s.lastSeenAt = now
    if (now < s.nextAllowedAt) {
      this.state.set(key, s)
      return { ok: false, retryAfterMs: s.nextAllowedAt - now }
    }
    s.nextAllowedAt = now + gateDelayMs(s.failures)
    this.state.set(key, s)
    return { ok: true }
  }

  recordFailure(key: string): void {
    const now = this.now()
    const s = this.state.get(key) ?? { failures: 0, nextAllowedAt: 0, lastSeenAt: now }
    s.failures++
    s.lastSeenAt = now
    this.state.set(key, s)
  }

  /** A successful login resets the account's failures and delay. */
  recordSuccess(key: string): void {
    this.state.delete(key)
  }

  failures(key: string): number {
    return this.state.get(key)?.failures ?? 0
  }

  private sweep(now: number): void {
    this.opsSinceSweep = 0
    for (const [key, s] of this.state) {
      if (now - s.lastSeenAt > GATE_IDLE_FORGET_MS && now >= s.nextAllowedAt) this.state.delete(key)
    }
  }
}
