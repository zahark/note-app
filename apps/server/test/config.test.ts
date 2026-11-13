import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { ConfigError, loadConfig, parseOffsiteBackupConfig, type Config } from '../src/config.js'
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

const BACKUP_SECRET = 'r2-secret-DO-NOT-LEAK-0123456789abcdef'

/** The four variables that switch off-site backups on (all or none). */
const backupRequired = (): Record<string, string> => ({
  BACKUP_S3_ENDPOINT: 'https://0123abcd.r2.cloudflarestorage.com',
  BACKUP_S3_BUCKET: 'notes-backups',
  BACKUP_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  BACKUP_S3_SECRET_ACCESS_KEY: BACKUP_SECRET,
})

/** Message of the ConfigError `fn` throws (fails the test when it throws nothing else). */
const configErrorOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError)
    return (err as Error).message
  }
  throw new Error('expected a ConfigError')
}

describe('parseOffsiteBackupConfig', () => {
  it('none set → null (backups off)', () => {
    expect(parseOffsiteBackupConfig({})).toBeNull()
    expect(loadConfig(baseEnv()).offsiteBackup).toBeNull()
  })

  it('blank values count as unset', () => {
    const blank = {
      BACKUP_S3_ENDPOINT: '',
      BACKUP_S3_BUCKET: ' ',
      BACKUP_S3_ACCESS_KEY_ID: '',
      BACKUP_S3_SECRET_ACCESS_KEY: '',
      BACKUP_S3_REGION: '',
      BACKUP_S3_PREFIX: '',
      BACKUP_INTERVAL_HOURS: '',
      BACKUP_KEEP_DAYS: '',
    }
    expect(parseOffsiteBackupConfig(blank)).toBeNull()
    expect(parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_S3_REGION: '', BACKUP_S3_PREFIX: ' ' })).toMatchObject({
      region: 'auto',
      prefix: 'notes-backups/',
    })
  })

  it('all four required set → parsed object with defaults', () => {
    const cfg = parseOffsiteBackupConfig(backupRequired())
    expect(cfg).not.toBeNull()
    expect(cfg?.endpoint).toBeInstanceOf(URL)
    expect(cfg?.endpoint.href).toBe('https://0123abcd.r2.cloudflarestorage.com/')
    expect(cfg).toMatchObject({
      bucket: 'notes-backups',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: BACKUP_SECRET,
      region: 'auto',
      prefix: 'notes-backups/',
      intervalMs: 24 * 60 * 60 * 1000,
      keepDays: 30,
    })
  })

  it('works without the server secrets (for the operator CLIs)', () => {
    const env = backupRequired()
    expect(env.SESSION_SECRET).toBeUndefined()
    expect(parseOffsiteBackupConfig(env)?.bucket).toBe('notes-backups')
  })

  it('reads explicit optional values', () => {
    const cfg = parseOffsiteBackupConfig({
      ...backupRequired(),
      BACKUP_S3_REGION: 'us-east-1',
      BACKUP_S3_PREFIX: 'home/notes',
      BACKUP_INTERVAL_HOURS: '6',
      BACKUP_KEEP_DAYS: '90',
    })
    expect(cfg).toMatchObject({ region: 'us-east-1', prefix: 'home/notes/', intervalMs: 6 * 60 * 60 * 1000, keepDays: 90 })
  })

  it('loadConfig exposes the same object', () => {
    const config = loadConfig(baseEnv({ ...backupRequired(), BACKUP_KEEP_DAYS: '7' }))
    expect(config.offsiteBackup).toEqual(parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_KEEP_DAYS: '7' }))
  })

  it.each([
    ['BACKUP_S3_ENDPOINT'],
    ['BACKUP_S3_BUCKET'],
    ['BACKUP_S3_ACCESS_KEY_ID'],
    ['BACKUP_S3_SECRET_ACCESS_KEY'],
  ])('some but not all set → ConfigError naming the missing %s', (missing) => {
    const env: NodeJS.ProcessEnv = backupRequired()
    delete env[missing]
    const message = configErrorOf(() => parseOffsiteBackupConfig(env))
    expect(message).toContain(`missing: ${missing}`)
    expect(configErrorOf(() => loadConfig(baseEnv(env)))).toContain(`missing: ${missing}`)
  })

  it('names every missing variable, and a blank one counts as missing', () => {
    const message = configErrorOf(() =>
      parseOffsiteBackupConfig({ BACKUP_S3_BUCKET: 'notes-backups', BACKUP_S3_ENDPOINT: '  ' }),
    )
    expect(message).toContain('missing: BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY')
  })

  it('only optional settings set → backups stay off', () => {
    expect(parseOffsiteBackupConfig({ BACKUP_S3_REGION: 'auto', BACKUP_KEEP_DAYS: '10' })).toBeNull()
  })

  it('loadConfig reports a partial backup config together with other problems', () => {
    const message = configErrorOf(() => loadConfig({ BACKUP_S3_BUCKET: 'notes-backups' }))
    expect(message).toContain('SESSION_SECRET')
    expect(message).toContain('missing: BACKUP_S3_ENDPOINT')
  })

  it.each([
    ['https://0123abcd.r2.cloudflarestorage.com', 'https://0123abcd.r2.cloudflarestorage.com/'],
    ['https://0123abcd.r2.cloudflarestorage.com/', 'https://0123abcd.r2.cloudflarestorage.com/'],
    ['https://s3.example.com:9000', 'https://s3.example.com:9000/'],
  ])('accepts endpoint %s', (value, href) => {
    expect(parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_S3_ENDPOINT: value })?.endpoint.href).toBe(href)
  })

  it.each([
    ['plain http', 'http://0123abcd.r2.cloudflarestorage.com'],
    ['not a url', '0123abcd.r2.cloudflarestorage.com'],
    ['other scheme', 'ftp://0123abcd.r2.cloudflarestorage.com'],
    ['with a path', 'https://0123abcd.r2.cloudflarestorage.com/notes-backups'],
    ['with a query', 'https://0123abcd.r2.cloudflarestorage.com/?x=1'],
    ['with a fragment', 'https://0123abcd.r2.cloudflarestorage.com#x'],
    ['with credentials', 'https://user:pw@0123abcd.r2.cloudflarestorage.com'],
  ])('rejects an endpoint %s', (_label, value) => {
    const message = configErrorOf(() => parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_S3_ENDPOINT: value }))
    expect(message).toContain('BACKUP_S3_ENDPOINT')
    expect(message).not.toContain('pw@')
  })

  it.each(['abc', 'notes-backups', 'notes.backups.2026', 'a'.repeat(63)])('accepts bucket %s', (bucket) => {
    expect(parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_S3_BUCKET: bucket })?.bucket).toBe(bucket)
  })

  it.each(['ab', 'a'.repeat(64), 'Notes', 'notes_backups', 'notes/backups', '-notes', 'notes-', 'notes backups'])(
    'rejects bucket %s',
    (bucket) => {
      expect(configErrorOf(() => parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_S3_BUCKET: bucket }))).toContain(
        'BACKUP_S3_BUCKET',
      )
    },
  )

  it.each([
    ['notes-backups', 'notes-backups/'],
    ['notes-backups/', 'notes-backups/'],
    ['home/notes', 'home/notes/'],
    ['v1.notes_x', 'v1.notes_x/'],
  ])('normalises prefix %s → %s', (value, prefix) => {
    expect(parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_S3_PREFIX: value })?.prefix).toBe(prefix)
  })

  it.each(['/notes', '/', '../notes', 'notes/../x', 'notes..x', 'a//b', 'notes backups', 'notes?x', 'notes%2f'])(
    'rejects prefix %s',
    (value) => {
      expect(configErrorOf(() => parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_S3_PREFIX: value }))).toContain(
        'BACKUP_S3_PREFIX',
      )
    },
  )

  it.each(['UPPER', 'us east', 'a'.repeat(33)])('rejects region %s', (value) => {
    expect(configErrorOf(() => parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_S3_REGION: value }))).toContain(
      'BACKUP_S3_REGION',
    )
  })

  it.each([
    ['1', 1],
    ['168', 168],
  ])('accepts BACKUP_INTERVAL_HOURS=%s', (value, hours) => {
    expect(parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_INTERVAL_HOURS: value })?.intervalMs).toBe(
      hours * 60 * 60 * 1000,
    )
  })

  it.each(['0', '169', '-1', '1.5', '24h', 'daily'])('rejects BACKUP_INTERVAL_HOURS=%s', (value) => {
    expect(configErrorOf(() => parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_INTERVAL_HOURS: value }))).toContain(
      'BACKUP_INTERVAL_HOURS',
    )
  })

  it.each([
    ['1', 1],
    ['3650', 3650],
  ])('accepts BACKUP_KEEP_DAYS=%s', (value, days) => {
    expect(parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_KEEP_DAYS: value })?.keepDays).toBe(days)
  })

  it.each(['0', '3651', '-5', '2.5', '30d'])('rejects BACKUP_KEEP_DAYS=%s', (value) => {
    expect(configErrorOf(() => parseOffsiteBackupConfig({ ...backupRequired(), BACKUP_KEEP_DAYS: value }))).toContain(
      'BACKUP_KEEP_DAYS',
    )
  })

  it('validates optional settings even while backups are off', () => {
    expect(configErrorOf(() => parseOffsiteBackupConfig({ BACKUP_KEEP_DAYS: 'forever' }))).toContain('BACKUP_KEEP_DAYS')
  })

  it.each([
    ['partial config', { BACKUP_S3_SECRET_ACCESS_KEY: BACKUP_SECRET }],
    ['bad endpoint', { ...backupRequired(), BACKUP_S3_ENDPOINT: 'http://x.example.com/path' }],
    ['bad bucket', { ...backupRequired(), BACKUP_S3_BUCKET: 'Bad_Bucket' }],
    ['bad prefix', { ...backupRequired(), BACKUP_S3_PREFIX: '/abs' }],
    ['bad interval', { ...backupRequired(), BACKUP_INTERVAL_HOURS: 'x' }],
    ['secret with spaces', { ...backupRequired(), BACKUP_S3_ACCESS_KEY_ID: '', BACKUP_S3_SECRET_ACCESS_KEY: ` ${BACKUP_SECRET} ` }],
  ])('never puts the secret access key in an error message (%s)', (_label, env) => {
    expect(configErrorOf(() => parseOffsiteBackupConfig(env))).not.toContain(BACKUP_SECRET)
    expect(configErrorOf(() => loadConfig(baseEnv(env)))).not.toContain(BACKUP_SECRET)
    expect(configErrorOf(() => loadConfig(env))).not.toContain(BACKUP_SECRET)
  })
})

describe('loadConfig: RESTORE_ABORT', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['1', true],
    ['true', true],
  ])('RESTORE_ABORT=%j → %s', (value, abort) => {
    expect(loadConfig(baseEnv({ RESTORE_ABORT: value })).restoreAbort).toBe(abort)
  })

  it.each(['yes', 'TRUE', '2', 'abort'])('rejects RESTORE_ABORT=%s', (value) => {
    expect(configErrorOf(() => loadConfig(baseEnv({ RESTORE_ABORT: value })))).toContain('RESTORE_ABORT')
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
