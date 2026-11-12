import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_TTL_SEC, SESSION_TTL_SEC } from '../src/services/auth.js'
import {
  closeApp,
  cookie,
  cookieValue,
  errorCode,
  login,
  makeApp,
  me,
  ORIGIN,
  PASSWORD,
  seedUser,
  signup,
  type TestApp,
} from './helpers/auth.js'

let t: TestApp
beforeEach(async () => {
  // most tests sign up several accounts; the default first-user-only mode is covered on its own below
  t = await makeApp({ env: { ALLOW_SIGNUP: 'true' } })
})
afterEach(async () => {
  await closeApp(t)
})

const count = (sql: string, ...params: unknown[]) => t.db.prepare(sql).pluck().get(...params) as number

describe('signup', () => {
  it('creates the user, logs them in and normalizes the email', async () => {
    const res = await signup(t.app, { email: '  Alice@Example.COM ' })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { user: { id: string; email: string } }
    expect(body.user.email).toBe('alice@example.com')
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/)

    const meRes = await me(t.app, cookieValue(res, 'sid'))
    expect(meRes.statusCode).toBe(200)
    expect(meRes.json()).toEqual({ user: { id: body.user.id, email: 'alice@example.com', isOwner: true } })
    // the password is stored hashed
    expect(t.db.prepare('SELECT password_hash FROM users').pluck().get()).toBe(`fake$${PASSWORD}`)
  })

  it('rejects a duplicate email (case-insensitive) with 409 and no hashing', async () => {
    expect((await signup(t.app, { email: 'alice@example.com' })).statusCode).toBe(201)
    const calls = t.hasher.calls
    const res = await signup(t.app, { email: 'ALICE@example.com' })
    expect(res.statusCode).toBe(409)
    expect(errorCode(res)).toBe('EMAIL_TAKEN')
    expect(t.hasher.calls).toBe(calls)
    expect(count('SELECT COUNT(*) FROM users')).toBe(1)
  })

  it('two concurrent signups for one email: one succeeds, the other gets 409 EMAIL_TAKEN', async () => {
    // hold both inside argon2, so both have passed the pre-check; the unique index decides
    t.hasher.blocked.add(PASSWORD)
    const pending = Promise.all([
      signup(t.app, { email: 'race@example.com', ip: '10.0.0.1' }),
      signup(t.app, { email: 'RACE@example.com', ip: '10.0.0.2' }),
    ])
    await vi.waitFor(() => expect(t.hasher.active).toBe(2))
    t.hasher.release()
    const results = await pending
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect(errorCode(results.find((r) => r.statusCode === 409)!)).toBe('EMAIL_TAKEN')
    expect(count('SELECT COUNT(*) FROM users')).toBe(1)
  })

  it('rejects an invalid email', async () => {
    const res = await signup(t.app, { email: 'not-an-email' })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_ERROR')
  })
})

const signupStatus = async (app: TestApp['app']) => {
  // public and a GET: no session cookie and no Origin header
  const res = await app.inject({ method: 'GET', url: '/api/auth/signup-status' })
  expect(res.statusCode).toBe(200)
  return (res.json() as { open: boolean }).open
}

describe('signup modes (ALLOW_SIGNUP)', () => {
  let other: TestApp | undefined
  afterEach(async () => {
    if (other) await closeApp(other)
    other = undefined
  })

  it('default (unset): only the first account can sign up, and it becomes the owner', async () => {
    other = await makeApp()
    expect(await signupStatus(other.app)).toBe(true)
    const first = await signup(other.app, { email: 'owner@example.com' })
    expect(first.statusCode).toBe(201)
    expect((first.json() as { user: { isOwner: boolean } }).user.isOwner).toBe(true)
    expect(await signupStatus(other.app)).toBe(false)

    const calls = other.hasher.calls
    const second = await signup(other.app, { email: 'stranger@example.com', ip: '10.0.0.9' })
    expect(second.statusCode).toBe(403)
    expect(errorCode(second)).toBe('SIGNUP_DISABLED')
    expect(cookie(second, 'sid')).toBeUndefined()
    expect(other.hasher.calls).toBe(calls)
    expect(other.db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(1)
  })

  it('default: an account restored or created another way closes signup', async () => {
    other = await makeApp()
    seedUser(other.db, 'owner@example.com')
    expect(await signupStatus(other.app)).toBe(false)
    expect(errorCode(await signup(other.app, { email: 'new@example.com' }))).toBe('SIGNUP_DISABLED')
  })

  it('default: of two concurrent first signups exactly one succeeds; the other gets 403 SIGNUP_DISABLED', async () => {
    other = await makeApp()
    // hold both inside argon2, so both have passed the pre-check; the insert's transaction decides
    other.hasher.blocked.add(PASSWORD)
    const pending = Promise.all([
      signup(other.app, { email: 'a@example.com', ip: '10.0.0.1' }),
      signup(other.app, { email: 'b@example.com', ip: '10.0.0.2' }),
    ])
    await vi.waitFor(() => expect(other!.hasher.active).toBe(2))
    other.hasher.release()
    const results = await pending
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403])
    expect(errorCode(results.find((r) => r.statusCode === 403)!)).toBe('SIGNUP_DISABLED')
    expect(cookie(results.find((r) => r.statusCode === 403)!, 'sid')).toBeUndefined()
    const rows = other.db.prepare('SELECT is_owner FROM users').pluck().all()
    expect(rows).toEqual([1])
  })

  it('ALLOW_SIGNUP=true keeps signup open after the owner exists', async () => {
    expect(await signupStatus(t.app)).toBe(true)
    expect((await signup(t.app, { email: 'owner@example.com' })).statusCode).toBe(201)
    expect(await signupStatus(t.app)).toBe(true)
    expect((await signup(t.app, { email: 'second@example.com' })).statusCode).toBe(201)
  })

  it('ALLOW_SIGNUP=false refuses signup with 403 even on an empty database, without hashing', async () => {
    other = await makeApp({ env: { ALLOW_SIGNUP: 'false' } })
    expect(await signupStatus(other.app)).toBe(false)
    const res = await signup(other.app, { email: 'alice@example.com' })
    expect(res.statusCode).toBe(403)
    expect(errorCode(res)).toBe('SIGNUP_DISABLED')
    expect(other.hasher.calls).toBe(0)
    expect(other.db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0)
  })
})

describe('owner assignment', () => {
  it('the first signup becomes owner, later signups do not', async () => {
    await signup(t.app, { email: 'first@example.com' })
    const second = await signup(t.app, { email: 'second@example.com' })
    expect((second.json() as { user: { isOwner: boolean } }).user.isOwner).toBe(false)
    const rows = t.db.prepare('SELECT email, is_owner FROM users ORDER BY email').all()
    expect(rows).toEqual([
      { email: 'first@example.com', is_owner: 1 },
      { email: 'second@example.com', is_owner: 0 },
    ])
  })

  it('two concurrent first signups produce exactly one owner', async () => {
    const results = await Promise.all([
      signup(t.app, { email: 'a@example.com', ip: '10.0.0.1' }),
      signup(t.app, { email: 'b@example.com', ip: '10.0.0.2' }),
    ])
    expect(results.map((r) => r.statusCode)).toEqual([201, 201])
    expect(count('SELECT COUNT(*) FROM users')).toBe(2)
    expect(count('SELECT COUNT(*) FROM users WHERE is_owner = 1')).toBe(1)
  })
})

describe('login', () => {
  beforeEach(() => {
    seedUser(t.db, 'alice@example.com')
  })

  it('succeeds with the correct password (email matched case-insensitively)', async () => {
    const res = await login(t.app, { email: ' ALICE@example.com' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { user: { email: string } }).user.email).toBe('alice@example.com')
    expect((await me(t.app, cookieValue(res, 'sid'))).statusCode).toBe(200)
  })

  it('rejects a wrong password with 401 INVALID_CREDENTIALS and no session', async () => {
    const res = await login(t.app, { email: 'alice@example.com', password: 'wrong password' })
    expect(res.statusCode).toBe(401)
    expect(errorCode(res)).toBe('INVALID_CREDENTIALS')
    expect(cookie(res, 'sid')).toBeUndefined()
    expect(count('SELECT COUNT(*) FROM sessions')).toBe(0)
  })

  it('an unknown email gets the same response as a wrong password, after a dummy verify', async () => {
    const wrong = await login(t.app, { email: 'alice@example.com', password: 'wrong password' })
    const verifies = t.hasher.verifyCalls
    const unknown = await login(t.app, { email: 'nobody@example.com', password: 'wrong password' })
    expect(unknown.statusCode).toBe(wrong.statusCode)
    expect(unknown.body).toBe(wrong.body)
    expect(t.hasher.verifyCalls).toBe(verifies + 1)
  })
})

describe('sessions', () => {
  beforeEach(() => {
    seedUser(t.db, 'alice@example.com')
  })

  it('stores only a hash of the session token', async () => {
    const sid = cookieValue(await login(t.app, { email: 'alice@example.com' }), 'sid')
    expect(count('SELECT COUNT(*) FROM sessions')).toBe(1)
    expect(count('SELECT COUNT(*) FROM sessions WHERE token_hash = ?', sid)).toBe(0)
  })

  it('/me without a cookie, or with an unknown token → 401', async () => {
    expect((await me(t.app, undefined)).statusCode).toBe(401)
    const res = await me(t.app, 'made-up-token')
    expect(res.statusCode).toBe(401)
    expect(errorCode(res)).toBe('UNAUTHORIZED')
  })

  it('expires after the session TTL without use', async () => {
    const sid = cookieValue(await login(t.app, { email: 'alice@example.com' }), 'sid')
    t.clock.advance(SESSION_TTL_SEC * 1000)
    expect((await me(t.app, sid)).statusCode).toBe(401)
    // expired rows are purged on the next login
    await login(t.app, { email: 'alice@example.com' })
    expect(count('SELECT COUNT(*) FROM sessions')).toBe(1)
  })

  it('sliding expiry: a request with under 15 days left extends the session to 30 days and re-sets the cookie', async () => {
    const sid = cookieValue(await login(t.app, { email: 'alice@example.com' }), 'sid')
    const expiresAt = () => count('SELECT expires_at FROM sessions')
    const loginExpiry = expiresAt()

    // more than half the lifetime left: nothing changes, no cookie is sent
    t.clock.advance((SESSION_TTL_SEC / 2 - 60) * 1000)
    const early = await me(t.app, sid)
    expect(early.statusCode).toBe(200)
    expect(cookie(early, 'sid')).toBeUndefined()
    expect(expiresAt()).toBe(loginExpiry)

    // under half left: extended to a full TTL from now, with a fresh cookie lifetime (same token)
    t.clock.advance(120 * 1000)
    const late = await me(t.app, sid)
    expect(late.statusCode).toBe(200)
    expect(cookie(late, 'sid')?.value).toBe(sid)
    expect(cookie(late, 'sid')?.maxAge).toBe(SESSION_TTL_SEC)
    expect(expiresAt()).toBe(Math.floor(t.clock.t / 1000) + SESSION_TTL_SEC)

    // still valid past the original expiry
    t.clock.advance((SESSION_TTL_SEC - 60) * 1000)
    expect((await me(t.app, sid)).statusCode).toBe(200)
  })

  it('logout invalidates the session and clears the cookie', async () => {
    const sid = cookieValue(await login(t.app, { email: 'alice@example.com' }), 'sid')
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: ORIGIN },
      cookies: { sid },
    })
    expect(res.statusCode).toBe(204)
    const cleared = cookie(res, 'sid')
    expect(cleared?.value).toBe('')
    expect(cleared?.maxAge).toBe(0)
    expect((await me(t.app, sid)).statusCode).toBe(401)
    expect(count('SELECT COUNT(*) FROM sessions')).toBe(0)
  })

  it('logout without a session is a harmless 204', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: ORIGIN } })
    expect(res.statusCode).toBe(204)
  })
})

describe('cookie flags', () => {
  it('http PUBLIC_ORIGIN: HttpOnly, SameSite=Lax, no Secure', async () => {
    seedUser(t.db, 'alice@example.com')
    const res = await login(t.app, { email: 'alice@example.com' })
    for (const name of ['sid', 'did']) {
      const c = cookie(res, name)
      expect(c?.httpOnly).toBe(true)
      expect(c?.sameSite).toBe('Lax')
      expect(c?.secure).toBeFalsy()
      expect(c?.path).toBe('/')
    }
    expect(cookie(res, 'sid')?.maxAge).toBe(SESSION_TTL_SEC)
  })

  it('https PUBLIC_ORIGIN: Secure as well', async () => {
    const https = await makeApp({ env: { PUBLIC_ORIGIN: 'https://notes.example.com' } })
    try {
      seedUser(https.db, 'alice@example.com')
      const res = await login(https.app, { email: 'alice@example.com', origin: 'https://notes.example.com' })
      expect(res.statusCode).toBe(200)
      for (const name of ['sid', 'did']) {
        const c = cookie(res, name)
        expect(c?.secure).toBe(true)
        expect(c?.httpOnly).toBe(true)
        expect(c?.sameSite).toBe('Lax')
      }
    } finally {
      await closeApp(https)
    }
  })
})

describe('Origin check on mutating requests', () => {
  beforeEach(() => {
    seedUser(t.db, 'alice@example.com')
  })

  it('a wrong Origin → 403 before any work', async () => {
    const res = await login(t.app, { email: 'alice@example.com', origin: 'https://evil.example.com' })
    expect(res.statusCode).toBe(403)
    expect(errorCode(res)).toBe('BAD_ORIGIN')
    expect(t.hasher.calls).toBe(0)
  })

  it('an Origin that only differs by port or scheme → 403', async () => {
    expect((await login(t.app, { email: 'alice@example.com', origin: 'http://localhost:3001' })).statusCode).toBe(403)
    expect((await login(t.app, { email: 'alice@example.com', origin: 'https://localhost:3000' })).statusCode).toBe(403)
  })

  it('no Origin → 403', async () => {
    const res = await login(t.app, { email: 'alice@example.com', origin: null })
    expect(res.statusCode).toBe(403)
    const logout = await t.app.inject({ method: 'POST', url: '/api/auth/logout' })
    expect(logout.statusCode).toBe(403)
  })

  it('the exact PUBLIC_ORIGIN → allowed', async () => {
    expect((await login(t.app, { email: 'alice@example.com', origin: ORIGIN })).statusCode).toBe(200)
  })

  it('safe methods need no Origin', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
  })
})

describe('login failure limits (checked before argon2)', () => {
  it('30 failures per IP key → 429 with no argon2 call', async () => {
    for (let i = 0; i < 30; i++) {
      const res = await login(t.app, { email: `user${i}@example.com`, password: 'wrong password', ip: '192.0.2.1' })
      expect(res.statusCode).toBe(401)
    }
    const calls = t.hasher.calls
    const res = await login(t.app, { email: 'fresh@example.com', password: 'wrong password', ip: '::ffff:192.0.2.1' })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
    expect(t.hasher.calls).toBe(calls)
    // a different IP key is unaffected
    expect((await login(t.app, { email: 'fresh@example.com', password: 'wrong password', ip: '192.0.2.2' })).statusCode).toBe(401)
  })

  it('10 failures per (account, IP key) → 429 even for the right password; another IP is not blocked', async () => {
    seedUser(t.db, 'alice@example.com')
    for (let i = 0; i < 10; i++) {
      const res = await login(t.app, { email: 'alice@example.com', password: 'wrong password', ip: '192.0.2.1' })
      expect(res.statusCode).toBe(401)
      t.clock.advance(10_000) // stay clear of the delay gate
    }
    const calls = t.hasher.calls
    const blocked = await login(t.app, { email: 'alice@example.com', ip: '192.0.2.1' })
    expect(blocked.statusCode).toBe(429)
    expect(t.hasher.calls).toBe(calls)

    const other = await login(t.app, { email: 'alice@example.com', ip: '192.0.2.2' })
    expect(other.statusCode).toBe(200)
  })
})

describe('login failure limits under a parallel burst (attempts still verifying count)', () => {
  const BLOCK = 'blocked wrong password'

  it('a burst across 50 emails from one IP key before any failure is recorded: 30 verify, 20 get 429', async () => {
    t = await reopenWithWideHashLimiter(t)
    t.hasher.blocked.add(BLOCK)
    const burst = Array.from({ length: 50 }, (_, i) =>
      login(t.app, { email: `spray${i}@example.com`, password: BLOCK, ip: '192.0.2.1' }),
    )
    await vi.waitFor(() => expect(t.hasher.active).toBe(30))
    t.hasher.release()
    const statuses = (await Promise.all(burst)).map((r) => r.statusCode)
    expect(statuses.filter((s) => s === 401)).toHaveLength(30)
    expect(statuses.filter((s) => s === 429)).toHaveLength(20)
    expect(t.hasher.verifyCalls).toBe(30)
  })

  it('a burst on one account with a valid device cookie (gate-exempt) stops at 10 per (account, IP key)', async () => {
    seedUser(t.db, 'alice@example.com')
    const did = cookieValue(await login(t.app, { email: 'alice@example.com' }), 'did')
    t = await reopenWithWideHashLimiter(t)
    t.hasher.blocked.add(BLOCK)
    const verifies = t.hasher.verifyCalls
    const burst = Array.from({ length: 15 }, () =>
      login(t.app, { email: 'alice@example.com', password: BLOCK, ip: '192.0.2.1', cookies: { did } }),
    )
    await vi.waitFor(() => expect(t.hasher.active).toBe(10))
    t.hasher.release()
    const statuses = (await Promise.all(burst)).map((r) => r.statusCode)
    expect(statuses.filter((s) => s === 401)).toHaveLength(10)
    expect(statuses.filter((s) => s === 429)).toHaveLength(5)
    expect(t.hasher.verifyCalls - verifies).toBe(10)
  })

  it('a burst on one account without a device cookie, before any failure: the gate lets 6 through', async () => {
    seedUser(t.db, 'alice@example.com')
    t = await reopenWithWideHashLimiter(t)
    t.hasher.blocked.add(BLOCK)
    const burst = Array.from({ length: 20 }, (_, i) =>
      login(t.app, { email: 'alice@example.com', password: BLOCK, ip: `10.9.${i}.1` }),
    )
    await vi.waitFor(() => expect(t.hasher.active).toBe(6))
    t.hasher.release()
    const statuses = (await Promise.all(burst)).map((r) => r.statusCode)
    expect(statuses.filter((s) => s === 401)).toHaveLength(6)
    expect(statuses.filter((s) => s === 429)).toHaveLength(14)
  })

  it('attempts refused with 503 BUSY by the hash limiter are not failures and release their reservation', async () => {
    // a short wait so queued verifies give up quickly; occupy all 4 general slots with blocked signups
    await closeApp(t)
    t = await makeApp({ hashWaitMs: 20 })
    t.hasher.blocked.add(BLOCK)
    const held = Array.from({ length: 4 }, (_, i) =>
      signup(t.app, { email: `held${i}@example.com`, password: `${BLOCK} ${i}`, ip: `203.0.113.${i + 1}` }),
    )
    for (let i = 0; i < 4; i++) t.hasher.blocked.add(`${BLOCK} ${i}`)
    await vi.waitFor(() => expect(t.hasher.active).toBe(4))
    const busy = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        login(t.app, { email: `busy${i}@example.com`, password: 'wrong password', ip: '192.0.2.1' }),
      ),
    )
    for (const res of busy) expect(res.statusCode).toBe(503)
    t.hasher.release()
    await Promise.all(held)
    // none of the 30 counted: the IP key still has its full allowance of 30 failures
    for (let i = 0; i < 30; i++) {
      const res = await login(t.app, { email: `later${i}@example.com`, password: 'wrong password', ip: '192.0.2.1' })
      expect(res.statusCode).toBe(401)
    }
    expect((await login(t.app, { email: 'x@example.com', password: 'wrong password', ip: '192.0.2.1' })).statusCode).toBe(429)
  })
})

/**
 * Re-creates the app's hash limiter with enough general slots for a 50-wide burst, keeping the database.
 * (The default 4 slots would make most of a burst wait; these tests are about the rate limits.)
 */
async function reopenWithWideHashLimiter(old: TestApp): Promise<TestApp> {
  const next = await makeApp({ db: old.db, hashSlots: 64 })
  next.clock.t = old.clock.t
  old.hasher.release()
  await old.app.close()
  return next
}

describe('known devices', () => {
  it('a login prunes the user’s devices unused for over a year', async () => {
    seedUser(t.db, 'alice@example.com')
    await login(t.app, { email: 'alice@example.com' })
    t.clock.advance((DEVICE_TTL_SEC + 1) * 1000)
    await login(t.app, { email: 'alice@example.com' })
    // only the fresh device from the second login is left
    expect(count('SELECT COUNT(*) FROM known_devices')).toBe(1)
    expect(count('SELECT last_used_at FROM known_devices')).toBe(Math.floor(t.clock.t / 1000))
  })
})

describe('successful-login limits', () => {
  it('the 21st successful login within 15 min for one account → 429 with no argon2 call', async () => {
    seedUser(t.db, 'alice@example.com')
    for (let i = 0; i < 20; i++) {
      expect((await login(t.app, { email: 'alice@example.com', ip: `10.0.${i}.1` })).statusCode).toBe(200)
    }
    const calls = t.hasher.calls
    const res = await login(t.app, { email: 'alice@example.com', ip: '10.0.99.1' })
    expect(res.statusCode).toBe(429)
    expect(t.hasher.calls).toBe(calls)

    t.clock.advance(15 * 60 * 1000 + 1)
    expect((await login(t.app, { email: 'alice@example.com', ip: '10.0.99.1' })).statusCode).toBe(200)
  })

  it('the 21st successful login within 15 min from one IP key → 429 with no argon2 call', async () => {
    for (let i = 0; i < 21; i++) seedUser(t.db, `user${i}@example.com`)
    for (let i = 0; i < 20; i++) {
      expect((await login(t.app, { email: `user${i}@example.com`, ip: '2001:db8:1:2::1' })).statusCode).toBe(200)
    }
    const calls = t.hasher.calls
    // another address in the same /64 is the same IP key
    const res = await login(t.app, { email: 'user20@example.com', ip: '2001:db8:1:2::99' })
    expect(res.statusCode).toBe(429)
    expect(t.hasher.calls).toBe(calls)
  })

  it('repeated logins with the same device cookie create no new known_devices rows', async () => {
    seedUser(t.db, 'alice@example.com')
    const did = cookieValue(await login(t.app, { email: 'alice@example.com' }), 'did')
    for (let i = 0; i < 5; i++) {
      const res = await login(t.app, { email: 'alice@example.com', cookies: { did } })
      expect(res.statusCode).toBe(200)
      expect(cookieValue(res, 'did')).toBe(did)
    }
    expect(count('SELECT COUNT(*) FROM known_devices')).toBe(1)
  })
})
