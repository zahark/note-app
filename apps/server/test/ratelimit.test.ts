import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/services/ratelimit.js'
import { FakeClock } from './helpers/auth.js'

const WINDOW = 15 * 60 * 1000

function make(limit = 3) {
  const clock = new FakeClock()
  const limiter = new RateLimiter({ limit, windowMs: WINDOW, now: clock.now })
  return { clock, limiter }
}

/** Number of keys the limiter still holds in memory. */
const heldKeys = (limiter: RateLimiter) => (limiter as unknown as { hits: Map<string, number[]> }).hits.size

describe('RateLimiter', () => {
  it('limits a key once it has `limit` hits inside the window', () => {
    const { limiter } = make(3)
    for (let i = 0; i < 2; i++) limiter.hit('k')
    expect(limiter.isLimited('k')).toBe(false)
    expect(limiter.retryAfterMs('k')).toBe(0)
    limiter.hit('k')
    expect(limiter.isLimited('k')).toBe(true)
    expect(limiter.isLimited('other')).toBe(false)
  })

  it('slides: each hit ages out a full window after it was made, and Retry-After says when', () => {
    const { clock, limiter } = make(3)
    limiter.hit('k')
    clock.advance(60_000)
    limiter.hit('k')
    limiter.hit('k')
    expect(limiter.retryAfterMs('k')).toBe(WINDOW - 60_000)
    clock.advance(WINDOW - 60_000 - 1)
    expect(limiter.isLimited('k')).toBe(true)
    clock.advance(1)
    expect(limiter.isLimited('k')).toBe(false)
    expect(limiter.count('k')).toBe(2)
    clock.advance(60_000)
    expect(limiter.count('k')).toBe(0)
  })

  it('hits beyond the limit keep the key limited until the newest `limit` hits age out', () => {
    const { clock, limiter } = make(2)
    limiter.hit('k')
    clock.advance(1000)
    limiter.hit('k')
    clock.advance(1000)
    limiter.hit('k')
    expect(limiter.count('k')).toBe(2)
    expect(limiter.retryAfterMs('k')).toBe(WINDOW - 1000)
  })

  it('reset forgets a key', () => {
    const { limiter } = make(1)
    limiter.hit('k')
    expect(limiter.isLimited('k')).toBe(true)
    limiter.reset('k')
    expect(limiter.isLimited('k')).toBe(false)
  })

  it('periodically drops keys whose hits all aged out, but never a key that is still limited', () => {
    const { clock, limiter } = make(3)
    for (let i = 0; i < 500; i++) limiter.hit(`old-${i}`)
    clock.advance(WINDOW)
    for (let i = 0; i < 3; i++) limiter.hit('attacker')
    expect(heldKeys(limiter)).toBe(501)
    // the 1000th hit triggers a sweep
    for (let i = 0; i < 497; i++) limiter.hit(`new-${i}`)
    expect(heldKeys(limiter)).toBe(1 + 497)
    expect(limiter.isLimited('attacker')).toBe(true)
  })
})
