import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_TTL_SEC } from '../src/services/auth.js'
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
  t = await makeApp()
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

  it('rejects an invalid email', async () => {
    const res = await signup(t.app, { email: 'not-an-email' })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_ERROR')
  })

  it('is refused with 403 when ALLOW_SIGNUP=false, without hashing', async () => {
    const closed = await makeApp({ env: { ALLOW_SIGNUP: 'false' } })
    try {
      const res = await signup(closed.app, { email: 'alice@example.com' })
      expect(res.statusCode).toBe(403)
      expect(errorCode(res)).toBe('SIGNUP_DISABLED')
      expect(closed.hasher.calls).toBe(0)
      expect(closed.db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0)
    } finally {
      await closeApp(closed)
    }
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

  it('expires after the session TTL', async () => {
    const sid = cookieValue(await login(t.app, { email: 'alice@example.com' }), 'sid')
    t.clock.advance((SESSION_TTL_SEC - 60) * 1000)
    expect((await me(t.app, sid)).statusCode).toBe(200)
    t.clock.advance(61 * 1000)
    expect((await me(t.app, sid)).statusCode).toBe(401)
    // expired rows are purged on the next login
    await login(t.app, { email: 'alice@example.com' })
    expect(count('SELECT COUNT(*) FROM sessions')).toBe(1)
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
