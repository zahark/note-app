// PIN unlock limits (used by the public unlock endpoint in Task 11): 5 failures / 15 min per requested
// note id (id-agnostic: missing and private ids count the same), 30 attempts / 15 min per IP key, both
// checked before any database lookup or argon2 verify.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../src/errors.js'
import { UNLOCK_LIMITS } from '../src/services/share.js'
import { closeApp, makeApp, type TestApp } from './helpers/auth.js'
import { api, loginAs, type TestUser } from './helpers/api.js'

const WRONG = 'ZZZZZZZZ'
const WINDOW_MS = 15 * 60 * 1000

let t: TestApp
let alice: TestUser

beforeEach(async () => {
  t = await makeApp()
  alice = await loginAs(t, 'alice@example.com')
})

afterEach(async () => {
  await closeApp(t)
})

async function newNote(): Promise<string> {
  const res = await api(t.app, alice, 'POST', '/api/notes', { title: 'n' })
  return res.json().note.id
}

async function pinShared(): Promise<{ id: string; pin: string }> {
  const id = await newNote()
  const res = await api(t.app, alice, 'POST', `/api/notes/${id}/share`, { type: 'password_protected' })
  return { id, pin: res.json().share.pin }
}

type Outcome = { ok: true; token: string } | { ok: false; status: number; code: string; body: string; retryAfter?: string }

/** Runs one unlock and reports its outcome (the error rendered as the API would send it). */
async function attempt(noteId: string, pin: string, ip = '203.0.113.7'): Promise<Outcome> {
  try {
    const { token } = await t.app.share.unlock({ noteId, pin, ip })
    return { ok: true, token }
  } catch (err) {
    if (!(err instanceof AppError)) throw err
    return {
      ok: false,
      status: err.statusCode,
      code: err.code,
      body: JSON.stringify({ error: { code: err.code, message: err.message } }),
      retryAfter: err.headers['retry-after'],
    }
  }
}

const status = (o: Outcome) => (o.ok ? 200 : o.status)

describe('per-note-id unlock limit', () => {
  it('locks an id after 5 failures in 15 minutes, with Retry-After', async () => {
    const { id } = await pinShared()
    for (let i = 0; i < UNLOCK_LIMITS.failuresPerNote.limit; i++) {
      expect(status(await attempt(id, WRONG))).toBe(404)
    }
    const locked = await attempt(id, WRONG)
    expect(locked).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED' })
    expect(Number((locked as { retryAfter: string }).retryAfter)).toBeGreaterThan(0)
  })

  it('the correct PIN during lockout gets 429 and no token, without any argon2 verify', async () => {
    const { id, pin } = await pinShared()
    for (let i = 0; i < 5; i++) await attempt(id, WRONG)
    const verifies = t.hasher.verifyCalls

    const locked = await attempt(id, pin)
    expect(locked.ok).toBe(false)
    expect(status(locked)).toBe(429)
    expect(t.hasher.verifyCalls).toBe(verifies)

    // the window slides: once the failures age out the correct PIN works again
    t.clock.advance(WINDOW_MS)
    expect((await attempt(id, pin)).ok).toBe(true)
  })

  it('changing IP does not reset the counter', async () => {
    const { id, pin } = await pinShared()
    for (let i = 0; i < 5; i++) await attempt(id, WRONG, `198.51.100.${i + 1}`)
    expect(status(await attempt(id, pin, '192.0.2.200'))).toBe(429)
    expect(status(await attempt(id, pin, '2001:db8:1234::1'))).toBe(429)
  })

  it('counts nonexistent and private ids and locks them the same way (dummy verify on each failure)', async () => {
    const privateId = await newNote()
    for (const id of [randomUUID(), privateId, 'not-even-a-uuid']) {
      const verifies = t.hasher.verifyCalls
      for (let i = 0; i < 5; i++) {
        const o = await attempt(id, WRONG)
        expect(status(o)).toBe(404)
      }
      expect(t.hasher.verifyCalls).toBe(verifies + 5)
      expect(status(await attempt(id, WRONG))).toBe(429)
      expect(t.hasher.verifyCalls).toBe(verifies + 5)
    }
  })

  it('every non-429 failure is the identical "unavailable" error', async () => {
    const { id: pinId } = await pinShared()
    const privateId = await newNote()
    const signedId = await newNote()
    await api(t.app, alice, 'POST', `/api/notes/${signedId}/share`, { type: 'signed_url', expires_in: '1d' })
    const revoked = await pinShared()
    await api(t.app, alice, 'DELETE', `/api/notes/${revoked.id}/share`)

    const outcomes = [
      await attempt(pinId, WRONG),
      await attempt(randomUUID(), WRONG),
      await attempt(privateId, WRONG),
      await attempt(signedId, WRONG),
      await attempt(revoked.id, revoked.pin),
    ]
    for (const o of outcomes) expect(o).toEqual(outcomes[0])
    expect(outcomes[0]).toMatchObject({ ok: false, status: 404, code: 'UNAVAILABLE' })
  })

  it('successful unlocks do not count towards the lockout', async () => {
    const { id, pin } = await pinShared()
    for (let i = 0; i < 10; i++) expect((await attempt(id, pin, `198.51.100.${i + 1}`)).ok).toBe(true)
  })

  it('a burst of parallel guesses cannot get more than 5 verifications through', async () => {
    const { id, pin } = await pinShared()
    const verifies = t.hasher.verifyCalls
    // all twelve pass the limiter check before any of them has finished (or even started) verifying
    const burst = Array.from({ length: 12 }, (_, i) => attempt(id, WRONG, `198.51.100.${i + 1}`))
    const outcomes = await Promise.all(burst)
    expect(outcomes.filter((o) => status(o) === 429)).toHaveLength(7)
    expect(outcomes.filter((o) => status(o) === 404)).toHaveLength(5)
    expect(t.hasher.verifyCalls).toBe(verifies + 5)
    expect(status(await attempt(id, pin))).toBe(429)
  })
})

describe('per-IP-key unlock limit', () => {
  it('trips after 30 attempts across many ids, even for a correct PIN on a fresh id', async () => {
    const { id, pin } = await pinShared()
    for (let i = 0; i < UNLOCK_LIMITS.attemptsPerIp.limit; i++) {
      expect(status(await attempt(randomUUID(), WRONG, '203.0.113.9'))).toBe(404)
    }
    const verifies = t.hasher.verifyCalls
    expect(status(await attempt(id, pin, '203.0.113.9'))).toBe(429)
    expect(t.hasher.verifyCalls).toBe(verifies)
    // another client is unaffected
    expect((await attempt(id, pin, '203.0.113.10')).ok).toBe(true)
  })

  it('keys IPv4-mapped addresses by their IPv4 address: two mapped clients do not share the limit', async () => {
    const { id, pin } = await pinShared()
    for (let i = 0; i < 30; i++) await attempt(randomUUID(), WRONG, '::ffff:1.2.3.4')
    expect(status(await attempt(id, pin, '::ffff:1.2.3.4'))).toBe(429)
    expect(status(await attempt(id, pin, '1.2.3.4'))).toBe(429) // same client, unwrapped
    expect((await attempt(id, pin, '::ffff:1.2.3.5')).ok).toBe(true)
  })

  it('keys native IPv6 by /64', async () => {
    const { id, pin } = await pinShared()
    for (let i = 0; i < 30; i++) await attempt(randomUUID(), WRONG, `2001:db8:1:2::${i + 1}`)
    expect(status(await attempt(id, pin, '2001:db8:1:2::ffff'))).toBe(429)
    expect((await attempt(id, pin, '2001:db8:1:3::1')).ok).toBe(true)
  })
})
