import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../src/errors.js'
import {
  argon2Hasher,
  assertValidPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from '../src/services/password.js'
import { closeApp, errorCode, makeApp, signup, type TestApp } from './helpers/auth.js'

describe('validatePassword', () => {
  it('rejects passwords shorter than 10 characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10)
    expect(validatePassword('')).toMatch(/at least 10/)
    expect(validatePassword('a'.repeat(9))).toMatch(/at least 10/)
  })

  it('rejects passwords longer than 256 characters', () => {
    expect(PASSWORD_MAX_LENGTH).toBe(256)
    expect(validatePassword('a'.repeat(257))).toMatch(/at most 256/)
  })

  it('accepts 10 and 256 characters', () => {
    expect(validatePassword('a'.repeat(10))).toBeNull()
    expect(validatePassword('a'.repeat(256))).toBeNull()
  })

  it('counts code points, not UTF-16 units', () => {
    // 10 emoji = 20 UTF-16 units but 10 characters
    expect(validatePassword('😀'.repeat(10))).toBeNull()
    expect(validatePassword('😀'.repeat(9))).toMatch(/at least 10/)
  })

  it('assertValidPassword throws a 400 WEAK_PASSWORD', () => {
    expect(() => assertValidPassword('short')).toThrow(AppError)
    try {
      assertValidPassword('short')
    } catch (err) {
      expect((err as AppError).statusCode).toBe(400)
      expect((err as AppError).code).toBe('WEAK_PASSWORD')
    }
    expect(() => assertValidPassword('long enough pw')).not.toThrow()
  })
})

describe('argon2Hasher', () => {
  it('produces argon2id hashes that verify', async () => {
    const hash = await argon2Hasher.hash('correct horse battery')
    expect(hash.startsWith('$argon2id$')).toBe(true)
    expect(await argon2Hasher.verify(hash, 'correct horse battery')).toBe(true)
    expect(await argon2Hasher.verify(hash, 'wrong password!')).toBe(false)
  })

  it('treats a malformed stored hash as a failed verification', async () => {
    expect(await argon2Hasher.verify('not-a-hash', 'whatever123')).toBe(false)
  })
})

describe('signup password policy and rate limit', () => {
  let t: TestApp
  beforeEach(async () => {
    t = await makeApp({ env: { ALLOW_SIGNUP: 'true' } })
  })
  afterEach(async () => {
    await closeApp(t)
  })

  it('rejects a weak password with 400 and no hashing', async () => {
    const res = await signup(t.app, { email: 'a@example.com', password: 'short' })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('WEAK_PASSWORD')
    expect(t.hasher.calls).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0)
  })

  it('the 6th signup from one IP key within an hour → 429 with no argon2 call', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await signup(t.app, { email: `u${i}@example.com`, ip: '203.0.113.7' })
      expect(res.statusCode).toBe(201)
    }
    const callsBefore = t.hasher.calls
    // same client seen as an IPv4-mapped address shares the key
    const res = await signup(t.app, { email: 'u5@example.com', ip: '::ffff:203.0.113.7' })
    expect(res.statusCode).toBe(429)
    expect(errorCode(res)).toBe('RATE_LIMITED')
    expect(res.headers['retry-after']).toBeDefined()
    expect(t.hasher.calls).toBe(callsBefore)

    // another IP key is unaffected
    expect((await signup(t.app, { email: 'other@example.com', ip: '203.0.113.8' })).statusCode).toBe(201)

    // an hour later the first IP key may sign up again
    t.clock.advance(60 * 60 * 1000 + 1)
    expect((await signup(t.app, { email: 'u5@example.com', ip: '203.0.113.7' })).statusCode).toBe(201)
  })
})
