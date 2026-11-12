import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetPassword, ResetPasswordError } from '../src/cli/reset-password.js'
import { openDb, type Db } from '../src/db/index.js'
import { createKnownDevice } from '../src/repos/knownDevices.js'
import { createSession } from '../src/repos/sessions.js'
import {
  changePassword,
  closeApp,
  cookie,
  cookieValue,
  errorCode,
  FakeHasher,
  login,
  makeApp,
  me,
  PASSWORD,
  seedUser,
  type TestApp,
} from './helpers/auth.js'

const NEW_PASSWORD = 'a brand new passphrase'
const count = (db: Db, sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number
const storedHash = (db: Db, userId: string) =>
  db.prepare('SELECT password_hash FROM users WHERE id = ?').pluck().get(userId)

describe('POST /api/auth/change-password', () => {
  let t: TestApp
  let userId: string
  let sid: string
  let did: string

  beforeEach(async () => {
    t = await makeApp()
    userId = seedUser(t.db, 'alice@example.com')
    const res = await login(t.app, { email: 'alice@example.com' })
    sid = cookieValue(res, 'sid')
    did = cookieValue(res, 'did')
  })
  afterEach(async () => {
    await closeApp(t)
  })

  it('requires a session', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { origin: t.config.publicOrigin },
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    })
    expect(res.statusCode).toBe(401)
    expect(t.hasher.calls).toBe(1) // only the login in beforeEach
  })

  it('requires the exact Origin like every mutating request', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      cookies: { sid },
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    })
    expect(res.statusCode).toBe(403)
    expect(errorCode(res)).toBe('BAD_ORIGIN')
  })

  it('rejects a wrong current password and changes nothing', async () => {
    const res = await changePassword(t.app, { sid, currentPassword: 'not my password', newPassword: NEW_PASSWORD })
    expect(res.statusCode).toBe(403)
    expect(errorCode(res)).toBe('WRONG_PASSWORD')
    expect(storedHash(t.db, userId)).toBe(`fake$${PASSWORD}`)
    expect(count(t.db, 'SELECT COUNT(*) FROM known_devices WHERE user_id = ?', userId)).toBe(1)
    expect((await me(t.app, sid)).statusCode).toBe(200)
  })

  it('stores the new password, keeps the current session, drops other sessions and all known devices', async () => {
    const other = await login(t.app, { email: 'alice@example.com', ip: '198.51.100.1' })
    const otherSid = cookieValue(other, 'sid')
    const otherDid = cookieValue(other, 'did')
    expect(count(t.db, 'SELECT COUNT(*) FROM sessions WHERE user_id = ?', userId)).toBe(2)
    expect(count(t.db, 'SELECT COUNT(*) FROM known_devices WHERE user_id = ?', userId)).toBe(2)

    const res = await changePassword(t.app, { sid, newPassword: NEW_PASSWORD, cookies: { did } })
    expect(res.statusCode).toBe(204)

    // the current session survives, the other one is gone
    expect((await me(t.app, sid)).statusCode).toBe(200)
    expect((await me(t.app, otherSid)).statusCode).toBe(401)
    expect(count(t.db, 'SELECT COUNT(*) FROM sessions WHERE user_id = ?', userId)).toBe(1)

    // a fresh device cookie replaces every old known device
    const fresh = cookie(res, 'did')
    expect(fresh?.value).toBeTruthy()
    expect(fresh?.value).not.toBe(did)
    expect(fresh?.httpOnly).toBe(true)
    expect(fresh?.sameSite).toBe('Lax')
    expect(count(t.db, 'SELECT COUNT(*) FROM known_devices WHERE user_id = ?', userId)).toBe(1)

    // the old password no longer works, the new one does
    expect((await login(t.app, { email: 'alice@example.com', ip: '198.51.100.2' })).statusCode).toBe(401)
    const relogin = await login(t.app, {
      email: 'alice@example.com',
      password: NEW_PASSWORD,
      ip: '198.51.100.3',
      cookies: { did: otherDid },
    })
    expect(relogin.statusCode).toBe(200)
    // the revoked device cookie is not known any more: login registered a new device instead of reusing it
    expect(cookieValue(relogin, 'did')).not.toBe(otherDid)
    expect(count(t.db, 'SELECT COUNT(*) FROM known_devices WHERE user_id = ?', userId)).toBe(2)
  })

  it('the fresh device cookie is a known device for the gate', async () => {
    const res = await changePassword(t.app, { sid, newPassword: NEW_PASSWORD })
    const fresh = cookieValue(res, 'did')
    const relogin = await login(t.app, { email: 'alice@example.com', password: NEW_PASSWORD, cookies: { did: fresh } })
    expect(relogin.statusCode).toBe(200)
    // reused, not replaced
    expect(cookieValue(relogin, 'did')).toBe(fresh)
    expect(count(t.db, 'SELECT COUNT(*) FROM known_devices WHERE user_id = ?', userId)).toBe(1)
  })

  it('does not touch other users’ sessions or devices', async () => {
    const bobId = seedUser(t.db, 'bob@example.com')
    const bob = await login(t.app, { email: 'bob@example.com' })
    expect((await changePassword(t.app, { sid, newPassword: NEW_PASSWORD })).statusCode).toBe(204)
    expect((await me(t.app, cookieValue(bob, 'sid'))).statusCode).toBe(200)
    expect(count(t.db, 'SELECT COUNT(*) FROM known_devices WHERE user_id = ?', bobId)).toBe(1)
  })

  it('rejects a weak new password via validatePassword, with no argon2 call', async () => {
    const calls = t.hasher.calls
    for (const weak of ['short', 'x'.repeat(257)]) {
      const res = await changePassword(t.app, { sid, newPassword: weak })
      expect(res.statusCode).toBe(400)
      expect(errorCode(res)).toBe('WEAK_PASSWORD')
    }
    expect(t.hasher.calls).toBe(calls)
    expect(storedHash(t.db, userId)).toBe(`fake$${PASSWORD}`)
  })

  it('the 6th change-password from one user within 15 min → 429 with no argon2 call', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await changePassword(t.app, { sid, currentPassword: 'wrong password!', newPassword: NEW_PASSWORD })
      expect(res.statusCode).toBe(403)
    }
    const calls = t.hasher.calls
    // even the correct current password is refused once the limit is reached
    const res = await changePassword(t.app, { sid, newPassword: NEW_PASSWORD })
    expect(res.statusCode).toBe(429)
    expect(errorCode(res)).toBe('RATE_LIMITED')
    expect(res.headers['retry-after']).toBeDefined()
    expect(t.hasher.calls).toBe(calls)
    expect(storedHash(t.db, userId)).toBe(`fake$${PASSWORD}`)

    // the limit is per user: another account is unaffected
    seedUser(t.db, 'bob@example.com')
    const bobSid = cookieValue(await login(t.app, { email: 'bob@example.com' }), 'sid')
    expect((await changePassword(t.app, { sid: bobSid, newPassword: NEW_PASSWORD })).statusCode).toBe(204)

    // after the window the user may try again
    t.clock.advance(15 * 60 * 1000 + 1)
    expect((await changePassword(t.app, { sid, newPassword: NEW_PASSWORD })).statusCode).toBe(204)
  })
})

describe('resetPassword (reset CLI core)', () => {
  let db: Db
  let hasher: FakeHasher
  let userId: string

  beforeEach(() => {
    db = openDb(':memory:')
    hasher = new FakeHasher()
    userId = seedUser(db, 'alice@example.com')
    for (let i = 0; i < 2; i++) {
      createSession(db, userId, `session-${i}`, 2_000_000_000)
      createKnownDevice(db, userId, `device-${i}`, 1_800_000_000)
    }
  })
  afterEach(() => {
    db.close()
  })

  it('sets the new hash and deletes all of the user’s sessions and known devices', async () => {
    const bobId = seedUser(db, 'bob@example.com')
    createSession(db, bobId, 'bob-session', 2_000_000_000)
    createKnownDevice(db, bobId, 'bob-device', 1_800_000_000)

    await resetPassword(db, '  Alice@Example.com ', NEW_PASSWORD, hasher)

    expect(storedHash(db, userId)).toBe(`fake$${NEW_PASSWORD}`)
    expect(count(db, 'SELECT COUNT(*) FROM sessions WHERE user_id = ?', userId)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) FROM known_devices WHERE user_id = ?', userId)).toBe(0)
    // other accounts are untouched
    expect(count(db, 'SELECT COUNT(*) FROM sessions WHERE user_id = ?', bobId)).toBe(1)
    expect(count(db, 'SELECT COUNT(*) FROM known_devices WHERE user_id = ?', bobId)).toBe(1)
  })

  it('errors on an unknown email and changes nothing', async () => {
    await expect(resetPassword(db, 'nobody@example.com', NEW_PASSWORD, hasher)).rejects.toThrow(ResetPasswordError)
    expect(hasher.calls).toBe(0)
    expect(count(db, 'SELECT COUNT(*) FROM sessions')).toBe(2)
    expect(count(db, 'SELECT COUNT(*) FROM known_devices')).toBe(2)
  })

  it('rejects a weak password via validatePassword and changes nothing', async () => {
    await expect(resetPassword(db, 'alice@example.com', 'short', hasher)).rejects.toThrow(
      'Password must be at least 10 characters',
    )
    await expect(resetPassword(db, 'alice@example.com', 'x'.repeat(257), hasher)).rejects.toThrow(
      'Password must be at most 256 characters',
    )
    expect(hasher.calls).toBe(0)
    expect(storedHash(db, userId)).toBe(`fake$${PASSWORD}`)
    expect(count(db, 'SELECT COUNT(*) FROM sessions')).toBe(2)
    expect(count(db, 'SELECT COUNT(*) FROM known_devices')).toBe(2)
  })

  it('revokes live app sessions and lets the user log in with the new password', async () => {
    const t = await makeApp()
    try {
      seedUser(t.db, 'carol@example.com')
      const before = cookieValue(await login(t.app, { email: 'carol@example.com' }), 'sid')
      await resetPassword(t.db, 'carol@example.com', NEW_PASSWORD, t.hasher)
      expect((await me(t.app, before)).statusCode).toBe(401)
      expect((await login(t.app, { email: 'carol@example.com', ip: '198.51.100.9' })).statusCode).toBe(401)
      expect((await login(t.app, { email: 'carol@example.com', password: NEW_PASSWORD })).statusCode).toBe(200)
    } finally {
      await closeApp(t)
    }
  })
})
