import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { ConfigError, loadConfig, type Config } from '../src/config.js'
import { openDb } from '../src/db/index.js'

const SECRET = 'a'.repeat(32)
const KEY = 'b'.repeat(32)

const baseEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  SESSION_SECRET: SECRET,
  SHARE_HMAC_KEY: KEY,
  PUBLIC_ORIGIN: 'https://notes.example.com',
  ...overrides,
})

const withoutKey = (key: string): NodeJS.ProcessEnv => {
  const env = baseEnv()
  delete env[key]
  return env
}

describe('loadConfig: secrets', () => {
  it.each(['SESSION_SECRET', 'SHARE_HMAC_KEY'])('rejects missing %s', (key) => {
    expect(() => loadConfig(withoutKey(key))).toThrow(ConfigError)
    expect(() => loadConfig(withoutKey(key))).toThrow(key)
  })

  it.each(['SESSION_SECRET', 'SHARE_HMAC_KEY'])('rejects empty %s', (key) => {
    expect(() => loadConfig(baseEnv({ [key]: '' }))).toThrow(key)
  })

  it.each(['SESSION_SECRET', 'SHARE_HMAC_KEY'])('rejects short %s (31 chars)', (key) => {
    expect(() => loadConfig(baseEnv({ [key]: 'x'.repeat(31) }))).toThrow(/at least 32/)
  })

  it('accepts 32-char secrets', () => {
    const config = loadConfig(baseEnv())
    expect(config.sessionSecret).toBe(SECRET)
    expect(config.shareHmacKey).toBe(KEY)
  })

  it('reports every problem at once', () => {
    let message = ''
    try {
      loadConfig({})
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('SESSION_SECRET')
    expect(message).toContain('SHARE_HMAC_KEY')
    expect(message).toContain('PUBLIC_ORIGIN')
  })
})

describe('loadConfig: PUBLIC_ORIGIN', () => {
  it('rejects a missing PUBLIC_ORIGIN', () => {
    expect(() => loadConfig(withoutKey('PUBLIC_ORIGIN'))).toThrow('PUBLIC_ORIGIN')
  })

  it.each([
    ['not a url', 'notes.example.com'],
    ['relative', '/notes'],
    ['non-http scheme', 'ftp://notes.example.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['with a path', 'https://notes.example.com/app'],
    ['with a query', 'https://notes.example.com?x=1'],
    ['with a fragment', 'https://notes.example.com#x'],
    ['with credentials', 'https://user:pw@notes.example.com'],
    ['empty', ''],
  ])('rejects a malformed origin (%s)', (_label, value) => {
    expect(() => loadConfig(baseEnv({ PUBLIC_ORIGIN: value }))).toThrow(ConfigError)
  })

  it.each([
    ['https://notes.example.com', 'https://notes.example.com', true],
    ['https://notes.example.com/', 'https://notes.example.com', true],
    ['http://localhost:5173', 'http://localhost:5173', false],
  ])('accepts %s', (value, origin, secure) => {
    const config = loadConfig(baseEnv({ PUBLIC_ORIGIN: value }))
    expect(config.publicOrigin).toBe(origin)
    expect(config.secureCookies).toBe(secure)
  })
})

describe('loadConfig: defaults', () => {
  it('defaults ALLOW_SIGNUP, HOST, PORT, DATA_DIR and TRUST_PROXY', () => {
    const config = loadConfig(baseEnv())
    expect(config.signupMode).toBe('first-user')
    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(3000)
    expect(config.dataDir).toBe(path.resolve('./data'))
    expect(config.trustProxy).toBe(false)
  })

  it('treats empty values as unset', () => {
    const config = loadConfig(
      baseEnv({ ALLOW_SIGNUP: '', HOST: '', PORT: '', DATA_DIR: '', TRUST_PROXY: '' }),
    )
    expect(config.signupMode).toBe('first-user')
    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(3000)
    expect(config.trustProxy).toBe(false)
  })

  it('reads explicit values', () => {
    const config = loadConfig(
      baseEnv({ ALLOW_SIGNUP: 'false', HOST: '127.0.0.1', PORT: '8080', DATA_DIR: '/data' }),
    )
    expect(config.signupMode).toBe('closed')
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(8080)
    expect(config.dataDir).toBe('/data')
  })

  it.each([
    ['true', 'open'],
    ['1', 'open'],
    ['false', 'closed'],
    ['0', 'closed'],
  ] as const)('ALLOW_SIGNUP=%s → signup %s', (value, mode) => {
    expect(loadConfig(baseEnv({ ALLOW_SIGNUP: value })).signupMode).toBe(mode)
  })

  it.each(['yes', 'TRUE!', 'off', 'first-user'])('rejects ALLOW_SIGNUP=%s', (value) => {
    expect(() => loadConfig(baseEnv({ ALLOW_SIGNUP: value }))).toThrow('ALLOW_SIGNUP')
  })

  it.each(['abc', '0', '70000', '-1', '3.5'])('rejects PORT=%s', (value) => {
    expect(() => loadConfig(baseEnv({ PORT: value }))).toThrow('PORT')
  })

  it('defaults LOG_LEVEL to info and accepts the pino levels', () => {
    expect(loadConfig(baseEnv()).logLevel).toBe('info')
    expect(loadConfig(baseEnv({ LOG_LEVEL: '' })).logLevel).toBe('info')
    expect(loadConfig(baseEnv({ LOG_LEVEL: 'debug' })).logLevel).toBe('debug')
  })

  it.each(['verbose', 'DEBUG', '1'])('rejects LOG_LEVEL=%s', (value) => {
    expect(() => loadConfig(baseEnv({ LOG_LEVEL: value }))).toThrow('LOG_LEVEL')
  })

  it('defaults UPLOAD_QUOTA_MB to 1024 and accepts 0 (no limit) and other integers', () => {
    expect(loadConfig(baseEnv()).uploadQuotaMb).toBe(1024)
    expect(loadConfig(baseEnv({ UPLOAD_QUOTA_MB: '' })).uploadQuotaMb).toBe(1024)
    expect(loadConfig(baseEnv({ UPLOAD_QUOTA_MB: '0' })).uploadQuotaMb).toBe(0)
    expect(loadConfig(baseEnv({ UPLOAD_QUOTA_MB: '5000' })).uploadQuotaMb).toBe(5000)
  })

  it.each(['-1', '1.5', '1GB', 'unlimited'])('rejects UPLOAD_QUOTA_MB=%s', (value) => {
    expect(() => loadConfig(baseEnv({ UPLOAD_QUOTA_MB: value }))).toThrow('UPLOAD_QUOTA_MB')
  })
})

describe('loadConfig: TRUST_PROXY', () => {
  it('unset trusts no proxy', () => {
    expect(loadConfig(baseEnv()).trustProxy).toBe(false)
  })

  it('a number is a hop count', () => {
    expect(loadConfig(baseEnv({ TRUST_PROXY: '1' })).trustProxy).toBe(1)
    expect(loadConfig(baseEnv({ TRUST_PROXY: '2' })).trustProxy).toBe(2)
  })

  it('a comma-separated list is an address list', () => {
    expect(loadConfig(baseEnv({ TRUST_PROXY: '10.0.0.0/8,127.0.0.1' })).trustProxy).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ])
    expect(loadConfig(baseEnv({ TRUST_PROXY: ' ::1 , fd00::/8' })).trustProxy).toEqual([
      '::1',
      'fd00::/8',
    ])
  })

  it.each(['true', 'TRUE', 'false', 'yes', 'loopback', '10.0.0.0/33', '1.2.3', '10.0.0.0/8,,'])(
    'rejects TRUST_PROXY=%s at boot',
    (value) => {
      expect(() => loadConfig(baseEnv({ TRUST_PROXY: value }))).toThrow('TRUST_PROXY')
    },
  )
})

describe('loadConfig: CLIENT_IP_HEADER', () => {
  it('unset or empty → null', () => {
    expect(loadConfig(baseEnv()).clientIpHeader).toBeNull()
    expect(loadConfig(baseEnv({ CLIENT_IP_HEADER: '' })).clientIpHeader).toBeNull()
    expect(loadConfig(baseEnv({ CLIENT_IP_HEADER: '  ' })).clientIpHeader).toBeNull()
  })

  it('accepts a header name and stores it lowercase', () => {
    expect(loadConfig(baseEnv({ CLIENT_IP_HEADER: 'Fly-Client-IP' })).clientIpHeader).toBe('fly-client-ip')
    expect(loadConfig(baseEnv({ CLIENT_IP_HEADER: ' X-Real-IP ' })).clientIpHeader).toBe('x-real-ip')
    expect(loadConfig(baseEnv({ CLIENT_IP_HEADER: 'a'.repeat(64) })).clientIpHeader).toBe('a'.repeat(64))
  })

  it.each(['Fly_Client_IP', 'Fly-Client-IP:', 'x real ip', 'cf-connecting-ip,fly-client-ip', 'é', 'a'.repeat(65)])(
    'rejects CLIENT_IP_HEADER=%s',
    (value) => {
      expect(() => loadConfig(baseEnv({ CLIENT_IP_HEADER: value }))).toThrow(ConfigError)
      expect(() => loadConfig(baseEnv({ CLIENT_IP_HEADER: value }))).toThrow('CLIENT_IP_HEADER')
    },
  )

  it.each(['1', '10.0.0.0/8'])('rejects it together with TRUST_PROXY=%s', (trust) => {
    const env = baseEnv({ CLIENT_IP_HEADER: 'Fly-Client-IP', TRUST_PROXY: trust })
    expect(() => loadConfig(env)).toThrow(ConfigError)
    expect(() => loadConfig(env)).toThrow(/CLIENT_IP_HEADER and TRUST_PROXY/)
  })

  it.each(['', '0'])('allows it with TRUST_PROXY=%j (trusts nothing)', (trust) => {
    const config = loadConfig(baseEnv({ CLIENT_IP_HEADER: 'Fly-Client-IP', TRUST_PROXY: trust }))
    expect(config.clientIpHeader).toBe('fly-client-ip')
    expect(config.trustProxy).toBe(false)
  })
})

describe('trustProxy wiring into request.ip', () => {
  const ipApp = (trustProxy: Config['trustProxy']) => {
    const db = openDb(':memory:')
    const app = buildApp({ config: { ...loadConfig(baseEnv()), trustProxy }, db })
    app.addHook('onClose', async () => {
      db.close()
    })
    app.get('/test/ip', async (request) => ({ ip: request.ip }))
    return app
  }
  const ipOf = async (
    trustProxy: Config['trustProxy'],
    remoteAddress: string,
    xff?: string,
  ): Promise<string> => {
    const app = ipApp(trustProxy)
    const res = await app.inject({
      method: 'GET',
      url: '/test/ip',
      remoteAddress,
      headers: xff ? { 'x-forwarded-for': xff } : {},
    })
    await app.close()
    return (res.json() as { ip: string }).ip
  }

  it('with no proxy trusted, ignores X-Forwarded-For', async () => {
    expect(await ipOf(false, '198.51.100.9', '6.6.6.6')).toBe('198.51.100.9')
  })

  it('with hop count 1, uses the last X-Forwarded-For entry, not a spoofed leftmost one', async () => {
    expect(await ipOf(1, '10.0.0.2', '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7')
  })

  it('with hop count 2, skips exactly two proxies', async () => {
    expect(await ipOf(2, '10.0.0.2', '6.6.6.6, 203.0.113.7, 10.0.0.3')).toBe('203.0.113.7')
  })

  it('with an address list, trusts only listed proxies', async () => {
    const list = ['10.0.0.0/8', '127.0.0.1']
    expect(await ipOf(list, '127.0.0.1', '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7')
    expect(await ipOf(list, '192.0.2.1', '6.6.6.6')).toBe('192.0.2.1')
  })
})
