// The client address the per-IP limits see, per deployment (Task 19), and its debug log line.
// Stands in for the Docker tunnel check: cloudflared sits at the fixed 172.30.0.10 and TRUST_PROXY names
// only that address, so its X-Forwarded-For is honoured while anything else (e.g. the bridge gateway
// 172.30.0.1, or a direct client) cannot forge one. On Fly.io CLIENT_IP_HEADER=Fly-Client-IP takes the
// address from the header Fly's proxy sets instead (FLY_PROXY stands in for the proxy's address).
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db/index.js'
import { closeApp, makeApp, ORIGIN, PASSWORD, seedUser, testConfig, type TestApp } from './helpers/auth.js'

let db: Db | undefined
afterEach(() => {
  db?.close()
  db = undefined
})

interface LogEntry {
  level: number
  msg: string
  ip?: string
  ipKey?: string
  header?: string
  req?: { remoteAddress?: string }
}

type Headers = Record<string, string | string[]>

/** Sends `GET /api/health` from `remoteAddress` and returns every log entry it produced. */
async function healthLog(
  env: Record<string, string>,
  remoteAddress: string,
  headers: Headers = {},
  level = 'debug',
): Promise<LogEntry[]> {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString())
      done()
    },
  })
  db = openDb(':memory:')
  const app = buildApp({ config: testConfig(env), db, logger: { level, stream } })
  try {
    const res = await app.inject({ method: 'GET', url: '/api/health', remoteAddress, headers })
    expect(res.statusCode).toBe(200)
  } finally {
    await app.close()
  }
  return lines.map((l) => JSON.parse(l) as LogEntry)
}

/** Sends `GET /api/health` from `remoteAddress` and returns the debug "client address" log entry. */
async function clientAddress(
  env: Record<string, string>,
  remoteAddress: string,
  headers: Headers = {},
  level = 'debug',
): Promise<{ ip: string | undefined; ipKey: string | undefined } | undefined> {
  const entry = (await healthLog(env, remoteAddress, headers, level)).find((e) => e.msg === 'client address')
  return entry && { ip: entry.ip, ipKey: entry.ipKey }
}

describe('client address', () => {
  it('tunnel: X-Forwarded-For from the cloudflared address is the client, not 172.30.0.10', async () => {
    const seen = await clientAddress({ TRUST_PROXY: '172.30.0.10' }, '172.30.0.10', {
      'x-forwarded-for': '198.51.100.1, 203.0.113.7',
    })
    expect(seen).toEqual({ ip: '203.0.113.7', ipKey: '203.0.113.7' })
  })

  it('tunnel: a forged X-Forwarded-For from any other address (the bridge gateway) is ignored', async () => {
    const seen = await clientAddress({ TRUST_PROXY: '172.30.0.10' }, '172.30.0.1', {
      'x-forwarded-for': '203.0.113.7',
    })
    expect(seen).toEqual({ ip: '172.30.0.1', ipKey: '172.30.0.1' })
  })

  it('nginx: TRUST_PROXY=1 takes the hop nginx appended', async () => {
    const seen = await clientAddress({ TRUST_PROXY: '1' }, '127.0.0.1', {
      'x-forwarded-for': '198.51.100.1, 2001:db8:1:2:3::4',
    })
    expect(seen).toEqual({ ip: '2001:db8:1:2:3::4', ipKey: '2001:db8:1:2::/64' })
  })

  it('direct: no TRUST_PROXY ignores X-Forwarded-For', async () => {
    const seen = await clientAddress({}, '::ffff:192.0.2.5', { 'x-forwarded-for': '203.0.113.7' })
    expect(seen).toEqual({ ip: '::ffff:192.0.2.5', ipKey: '192.0.2.5' })
  })

  it('is not logged above debug level', async () => {
    expect(await clientAddress({}, '192.0.2.5', {}, 'info')).toBeUndefined()
  })
})

const FLY = { CLIENT_IP_HEADER: 'Fly-Client-IP' }
const FLY_PROXY = '172.16.0.2'
const FALLBACK = 'client IP header missing or invalid, using the socket address'
const WARN = 40

describe('client address from CLIENT_IP_HEADER (Fly.io)', () => {
  it.each([
    ['IPv4', '203.0.113.7', '203.0.113.7'],
    ['IPv6 (keyed on its /64)', '2001:db8:1:2:3::4', '2001:db8:1:2::/64'],
    ['IPv4-mapped IPv6 (unwrapped)', '::ffff:192.0.2.5', '192.0.2.5'],
    ['padded with spaces', ' 203.0.113.7 ', '203.0.113.7'],
  ])('takes the header value: %s', async (_label, value, key) => {
    const seen = await clientAddress(FLY, FLY_PROXY, { 'fly-client-ip': value })
    expect(seen).toEqual({ ip: value.trim(), ipKey: key })
  })

  it('matches the header name case-insensitively', async () => {
    const seen = await clientAddress({ CLIENT_IP_HEADER: 'fly-client-ip' }, FLY_PROXY, { 'FLY-CLIENT-IP': '203.0.113.7' })
    expect(seen).toEqual({ ip: '203.0.113.7', ipKey: '203.0.113.7' })
  })

  it('ignores a spoofed X-Forwarded-For', async () => {
    const seen = await clientAddress(FLY, FLY_PROXY, {
      'fly-client-ip': '203.0.113.7',
      'x-forwarded-for': '6.6.6.6',
    })
    expect(seen).toEqual({ ip: '203.0.113.7', ipKey: '203.0.113.7' })
  })

  it.each<[string, Headers]>([
    ['missing', {}],
    ['not an IP', { 'fly-client-ip': 'not-an-ip' }],
    ['an address list', { 'fly-client-ip': '203.0.113.7, 198.51.100.1' }],
    ['repeated', { 'fly-client-ip': ['203.0.113.7', '198.51.100.1'] }],
    ['empty', { 'fly-client-ip': '' }],
  ])('a header that is %s falls back to the socket address, with a debug line', async (_label, headers) => {
    const entries = await healthLog(FLY, FLY_PROXY, { 'x-forwarded-for': '6.6.6.6', ...headers })
    const address = entries.find((e) => e.msg === 'client address')
    expect(address).toMatchObject({ ip: FLY_PROXY, ipKey: FLY_PROXY })
    const fallback = entries.filter((e) => e.msg === FALLBACK)
    expect(fallback).toHaveLength(1)
    expect(fallback[0]).toMatchObject({ level: 20, header: 'fly-client-ip', ip: FLY_PROXY })
  })

  it('the fallback is silent at LOG_LEVEL=info (Fly health checks carry no header)', async () => {
    const entries = await healthLog(FLY, FLY_PROXY, {}, 'info')
    expect(entries.filter((e) => e.msg === FALLBACK || e.msg === 'client address')).toEqual([])
    expect(entries.filter((e) => e.level >= WARN)).toEqual([])
  })

  it('the info-level request log shows the header address, not the proxy', async () => {
    const incoming = (entries: LogEntry[]) => entries.find((e) => e.msg === 'incoming request')?.req?.remoteAddress
    expect(incoming(await healthLog(FLY, FLY_PROXY, { 'fly-client-ip': '203.0.113.7' }, 'info'))).toBe('203.0.113.7')
    expect(incoming(await healthLog(FLY, FLY_PROXY, { 'fly-client-ip': 'bogus' }, 'info'))).toBe(FLY_PROXY)
    expect(incoming(await healthLog({}, '192.0.2.5', { 'fly-client-ip': '203.0.113.7' }, 'info'))).toBe('192.0.2.5')
  })

  it('without CLIENT_IP_HEADER a Fly-Client-IP header is ignored', async () => {
    const seen = await clientAddress({}, '192.0.2.5', { 'fly-client-ip': '203.0.113.7' })
    expect(seen).toEqual({ ip: '192.0.2.5', ipKey: '192.0.2.5' })
  })
})

describe('login limits keyed on CLIENT_IP_HEADER', () => {
  let t: TestApp | undefined
  afterEach(async () => {
    if (t) await closeApp(t)
    t = undefined
  })

  const loginFrom = (app: TestApp['app'], flyClientIp: string, email: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      // every request reaches the app from the same proxy address; only the header differs
      remoteAddress: FLY_PROXY,
      headers: { origin: ORIGIN, 'fly-client-ip': flyClientIp },
      payload: { email, password: 'wrong password' },
    })

  it('two header values get separate per-IP failure limits; the same value shares one', async () => {
    t = await makeApp({ env: FLY })
    seedUser(t.db, 'alice@example.com', PASSWORD)
    for (let i = 0; i < 30; i++) {
      expect((await loginFrom(t.app, '203.0.113.7', `user${i}@example.com`)).statusCode).toBe(401)
    }
    // the same client (also as an IPv4-mapped address) is now limited
    expect((await loginFrom(t.app, '203.0.113.7', 'fresh@example.com')).statusCode).toBe(429)
    expect((await loginFrom(t.app, '::ffff:203.0.113.7', 'fresh@example.com')).statusCode).toBe(429)
    // another client behind the same proxy address is not
    expect((await loginFrom(t.app, '203.0.113.8', 'fresh@example.com')).statusCode).toBe(401)
  })
})

describe('signup and PIN unlock limits keyed on CLIENT_IP_HEADER', () => {
  let t: TestApp | undefined
  afterEach(async () => {
    if (t) await closeApp(t)
    t = undefined
  })

  const from = (flyClientIp: string) => ({ remoteAddress: FLY_PROXY, headers: { origin: ORIGIN, 'fly-client-ip': flyClientIp } })

  it('signups: two header values get separate per-IP limits', async () => {
    t = await makeApp({ env: { ...FLY, ALLOW_SIGNUP: 'true' } })
    const signupFrom = (ip: string, email: string) =>
      t!.app.inject({ method: 'POST', url: '/api/auth/signup', ...from(ip), payload: { email, password: PASSWORD } })
    for (let i = 0; i < 5; i++) expect((await signupFrom('203.0.113.7', `user${i}@example.com`)).statusCode).toBe(201)
    expect((await signupFrom('203.0.113.7', 'fresh@example.com')).statusCode).toBe(429)
    expect((await signupFrom('203.0.113.8', 'fresh@example.com')).statusCode).toBe(201)
  })

  it('PIN unlocks: two header values get separate per-IP limits', async () => {
    t = await makeApp({ env: FLY })
    const unlockFrom = (ip: string, noteId: string) =>
      t!.app.inject({ method: 'POST', url: `/api/shared/${noteId}/unlock`, ...from(ip), payload: { pin: '1234' } })
    for (let i = 0; i < 30; i++) expect((await unlockFrom('203.0.113.7', `note-${i}`)).statusCode).not.toBe(429)
    expect((await unlockFrom('203.0.113.7', 'note-x')).statusCode).toBe(429)
    expect((await unlockFrom('203.0.113.8', 'note-y')).statusCode).not.toBe(429)
  })
})
