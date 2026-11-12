// The client address the per-IP limits see, per deployment (Task 19), and its debug log line.
// Stands in for the Docker tunnel check: cloudflared sits at the fixed 172.30.0.10 and TRUST_PROXY names
// only that address, so its X-Forwarded-For is honoured while anything else (e.g. the bridge gateway
// 172.30.0.1, or a direct client) cannot forge one.
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db/index.js'
import { testConfig } from './helpers/auth.js'

let db: Db | undefined
afterEach(() => {
  db?.close()
  db = undefined
})

/** Sends `GET /api/health` from `remoteAddress` and returns the debug "client address" log entry. */
async function clientAddress(
  env: Record<string, string>,
  remoteAddress: string,
  headers: Record<string, string> = {},
  level = 'debug',
): Promise<{ ip: string; ipKey: string } | undefined> {
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
  const entry = lines.map((l) => JSON.parse(l) as { msg: string; ip: string; ipKey: string })
    .find((e) => e.msg === 'client address')
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
