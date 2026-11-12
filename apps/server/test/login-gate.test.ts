import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gateDelayMs, GATE_MAX_DELAY_MS, LoginGate } from '../src/services/loginGate.js'
import {
  closeApp,
  cookie,
  cookieValue,
  errorCode,
  FakeClock,
  login,
  makeApp,
  seedUser,
  type TestApp,
} from './helpers/auth.js'

describe('gateDelayMs', () => {
  it('is free for the first 5 failures, then doubles from 250 ms and caps at 5 s', () => {
    expect([0, 1, 2, 3, 4].map(gateDelayMs)).toEqual([0, 0, 0, 0, 0])
    expect([5, 6, 7, 8, 9].map(gateDelayMs)).toEqual([250, 500, 1000, 2000, 4000])
    expect(gateDelayMs(10)).toBe(GATE_MAX_DELAY_MS)
    expect(gateDelayMs(50)).toBe(5000)
  })
})

describe('LoginGate', () => {
  it('opens a window on entry and rejects attempts inside it with the remaining time', () => {
    const clock = new FakeClock()
    const gate = new LoginGate({ now: clock.now })
    for (let i = 0; i < 5; i++) {
      expect(gate.tryEnter('a')).toEqual({ ok: true })
      gate.recordFailure('a')
    }
    expect(gate.tryEnter('a')).toEqual({ ok: true })
    expect(gate.tryEnter('a')).toEqual({ ok: false, retryAfterMs: 250 })
    clock.advance(100)
    expect(gate.tryEnter('a')).toEqual({ ok: false, retryAfterMs: 150 })
    clock.advance(150)
    expect(gate.tryEnter('a')).toEqual({ ok: true })
  })

  it('doubles the window per failure and caps it at 5 s', () => {
    const clock = new FakeClock()
    const gate = new LoginGate({ now: clock.now })
    const windows: number[] = []
    for (let i = 0; i < 12; i++) {
      expect(gate.tryEnter('a').ok).toBe(true)
      const blocked = gate.tryEnter('a')
      windows.push(blocked.ok ? 0 : blocked.retryAfterMs)
      gate.recordFailure('a')
      clock.advance(10_000)
    }
    expect(windows).toEqual([0, 0, 0, 0, 0, 250, 500, 1000, 2000, 4000, 5000, 5000])
  })

  it('a success resets failures and the delay', () => {
    const clock = new FakeClock()
    const gate = new LoginGate({ now: clock.now })
    for (let i = 0; i < 8; i++) {
      gate.tryEnter('a')
      gate.recordFailure('a')
      clock.advance(10_000)
    }
    gate.recordSuccess('a')
    expect(gate.failures('a')).toBe(0)
    expect(gate.tryEnter('a')).toEqual({ ok: true })
    expect(gate.tryEnter('a')).toEqual({ ok: true })
  })

  it('keys are independent', () => {
    const clock = new FakeClock()
    const gate = new LoginGate({ now: clock.now })
    for (let i = 0; i < 6; i++) {
      gate.tryEnter('a')
      gate.recordFailure('a')
    }
    expect(gate.tryEnter('a').ok).toBe(false)
    expect(gate.tryEnter('b').ok).toBe(true)
  })
})

describe('login delay gate (HTTP)', () => {
  let t: TestApp
  beforeEach(async () => {
    t = await makeApp()
    seedUser(t.db, 'owner@example.com')
  })
  afterEach(async () => {
    await closeApp(t)
  })

  /** `n` wrong-password attempts from distinct IPs, spaced far enough apart that the gate never blocks. */
  async function fail(email: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const res = await login(t.app, { email, password: 'wrong password', ip: `198.51.100.${i + 1}` })
      expect(res.statusCode).toBe(401)
      t.clock.advance(10_000)
    }
  }

  it.each(['owner@example.com', 'nobody@example.com'])(
    'after 5 failures, an attempt inside the delay window gets 429 + Retry-After with no argon2 call (%s)',
    async (email) => {
      await fail(email, 5)
      // this attempt passes the gate and opens a 250 ms window
      expect((await login(t.app, { email, password: 'wrong password', ip: '192.0.2.1' })).statusCode).toBe(401)
      const calls = t.hasher.calls
      const res = await login(t.app, { email, ip: '192.0.2.2' })
      expect(res.statusCode).toBe(429)
      expect(errorCode(res)).toBe('RATE_LIMITED')
      expect(res.headers['retry-after']).toBe('1')
      expect(t.hasher.calls).toBe(calls)
    },
  )

  it.each(['owner@example.com', 'nobody@example.com'])(
    '50 parallel attempts from 50 IP keys inside one window let exactly one through (%s)',
    async (email) => {
      await fail(email, 5)
      const verifies = t.hasher.verifyCalls
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          login(t.app, { email, password: 'wrong password', ip: `10.1.${i}.1` }),
        ),
      )
      const statuses = results.map((r) => r.statusCode)
      expect(statuses.filter((s) => s === 401)).toHaveLength(1)
      expect(statuses.filter((s) => s === 429)).toHaveLength(49)
      expect(t.hasher.verifyCalls - verifies).toBe(1)
    },
  )

  it('a successful login resets the gate', async () => {
    await fail('owner@example.com', 8)
    expect((await login(t.app, { email: 'owner@example.com', ip: '192.0.2.1' })).statusCode).toBe(200)
    // failures are back to 0: two immediate attempts both reach verification
    expect(
      (await login(t.app, { email: 'owner@example.com', password: 'wrong password', ip: '192.0.2.2' })).statusCode,
    ).toBe(401)
    expect(
      (await login(t.app, { email: 'owner@example.com', password: 'wrong password', ip: '192.0.2.3' })).statusCode,
    ).toBe(401)
  })

  it('unknown and existing emails get identical status sequences', async () => {
    const run = async (email: string) => {
      const statuses: number[] = []
      for (let i = 0; i < 8; i++) {
        statuses.push((await login(t.app, { email, password: 'wrong password', ip: `172.16.0.${i}` })).statusCode)
      }
      return statuses
    }
    const known = await run('owner@example.com')
    t.clock.advance(60 * 60 * 1000)
    const unknown = await run('nobody@example.com')
    expect(unknown).toEqual(known)
    expect(known).toContain(429)
  })
})

describe('device cookie', () => {
  let t: TestApp
  beforeEach(async () => {
    t = await makeApp()
    seedUser(t.db, 'owner@example.com')
    seedUser(t.db, 'second@example.com')
  })
  afterEach(async () => {
    await closeApp(t)
  })

  /** Saturates owner@example.com's gate from other IPs, leaving an open delay window. */
  async function saturateGate(): Promise<void> {
    for (let i = 0; i < 7; i++) {
      await login(t.app, { email: 'owner@example.com', password: 'wrong password', ip: `198.51.100.${i + 1}` })
      t.clock.advance(10_000)
    }
    // opens a fresh window and confirms that a plain correct login is now refused
    await login(t.app, { email: 'owner@example.com', password: 'wrong password', ip: '198.51.100.99' })
    expect((await login(t.app, { email: 'owner@example.com', ip: '192.0.2.50' })).statusCode).toBe(429)
  }

  it('a successful login sets a long-lived HttpOnly SameSite=Lax device cookie', async () => {
    const res = await login(t.app, { email: 'owner@example.com' })
    expect(res.statusCode).toBe(200)
    const did = cookie(res, 'did')
    expect(did?.value).toMatch(/^[\w-]{40,}$/)
    expect(did?.httpOnly).toBe(true)
    expect(did?.sameSite).toBe('Lax')
    expect(did?.maxAge).toBe(365 * 24 * 60 * 60)
    expect(t.db.prepare('SELECT COUNT(*) FROM known_devices').pluck().get()).toBe(1)
    // only a hash of the value is stored
    expect(t.db.prepare('SELECT COUNT(*) FROM known_devices WHERE token_hash = ?').pluck().get(did?.value)).toBe(0)
  })

  it('with the gate saturated, a valid device cookie for the account bypasses it', async () => {
    const did = cookieValue(await login(t.app, { email: 'owner@example.com' }), 'did')
    t.clock.advance(10_000)
    await saturateGate()
    const res = await login(t.app, { email: 'owner@example.com', ip: '192.0.2.51', cookies: { did } })
    expect(res.statusCode).toBe(200)
  })

  it('a device cookie for a different account does not bypass the gate', async () => {
    const did = cookieValue(await login(t.app, { email: 'second@example.com' }), 'did')
    await saturateGate()
    const res = await login(t.app, { email: 'owner@example.com', ip: '192.0.2.51', cookies: { did } })
    expect(res.statusCode).toBe(429)
  })

  it('a forged device cookie does not bypass the gate', async () => {
    await saturateGate()
    const res = await login(t.app, {
      email: 'owner@example.com',
      ip: '192.0.2.51',
      cookies: { did: 'forged-device-token-forged-device-token-xx' },
    })
    expect(res.statusCode).toBe(429)
  })

  it('a revoked device cookie does not bypass the gate', async () => {
    const did = cookieValue(await login(t.app, { email: 'owner@example.com' }), 'did')
    t.db.prepare('DELETE FROM known_devices').run()
    t.clock.advance(10_000)
    await saturateGate()
    const res = await login(t.app, { email: 'owner@example.com', ip: '192.0.2.51', cookies: { did } })
    expect(res.statusCode).toBe(429)
  })

  it('a device cookie still counts towards the per-(account, IP key) failure limit', async () => {
    const did = cookieValue(await login(t.app, { email: 'owner@example.com' }), 'did')
    for (let i = 0; i < 10; i++) {
      await login(t.app, { email: 'owner@example.com', password: 'wrong password', ip: '192.0.2.9', cookies: { did } })
    }
    const res = await login(t.app, { email: 'owner@example.com', ip: '192.0.2.9', cookies: { did } })
    expect(res.statusCode).toBe(429)
  })
})
