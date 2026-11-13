import { isIP } from 'node:net'
import path from 'node:path'
import { z } from 'zod'

/** DATA_DIR when unset, resolved against the working directory. */
export const DEFAULT_DATA_DIR = './data'

/** Minimum length for SESSION_SECRET and SHARE_HMAC_KEY. */
export const MIN_SECRET_LENGTH = 32

/**
 * Parsed TRUST_PROXY value: `false` trusts nothing, a number trusts that many hops, a list trusts those
 * proxy addresses/CIDRs. `fastifyTrustProxy` (app.ts) converts it into Fastify's `trustProxy` option
 * (a hop count becomes a function, since Fastify 5 treats a bare number as "trust nothing").
 */
export type TrustProxy = false | number | string[]

export interface Config {
  sessionSecret: string
  shareHmacKey: string
  /** Exact origin (scheme://host[:port]) the app is served from; mutating requests must send it as `Origin`. */
  publicOrigin: string
  /** True when PUBLIC_ORIGIN is https, so cookies get the Secure flag. */
  secureCookies: boolean
  trustProxy: TrustProxy
  /**
   * Lowercased name of a header set by the platform's proxy on every request (e.g. Fly.io's
   * `fly-client-ip`); when set, the per-IP limits take the client address from it (see `clientIpOf` in
   * app.ts). `null` (unset) uses the socket address, or X-Forwarded-For per TRUST_PROXY.
   */
  clientIpHeader: string | null
  /** Who may create an account through `POST /api/auth/signup` (see `SignupMode`). */
  signupMode: SignupMode
  /** Absolute path to the directory holding the SQLite database and uploads. */
  dataDir: string
  host: string
  port: number
  /** Fastify log level; `debug` also logs each request's client address and IP key. */
  logLevel: LogLevel
  /** Per-account limit on the total size of stored images, in MiB; 0 means no limit. */
  uploadQuotaMb: number
}

/**
 * ALLOW_SIGNUP, parsed: `first-user` (unset, the default) allows signup only while no account exists, so
 * the owner can create theirs on first run; `open` (`true`/`1`) allows anyone to sign up; `closed`
 * (`false`/`0`) refuses every signup, even on an empty database.
 */
export type SignupMode = 'first-user' | 'open' | 'closed'

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Unset or empty env values count as missing, so `.env` lines like `TRUST_PROXY=` behave as unset. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema)

const secret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(MIN_SECRET_LENGTH, `${name} must be at least ${MIN_SECRET_LENGTH} characters`)

const publicOrigin = z
  .string({ error: 'PUBLIC_ORIGIN is required' })
  .transform((value, ctx) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'PUBLIC_ORIGIN must be an absolute URL' })
      return z.NEVER
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'PUBLIC_ORIGIN must use http or https' })
      return z.NEVER
    }
    // a single trailing slash is tolerated; anything else beyond the origin (path, query, credentials) is not
    const trimmed = value.endsWith('/') ? value.slice(0, -1) : value
    if (trimmed !== url.origin) {
      ctx.addIssue({
        code: 'custom',
        message: `PUBLIC_ORIGIN must be an origin only (scheme://host[:port], no path), e.g. ${url.origin}`,
      })
      return z.NEVER
    }
    return url.origin
  })

/** Validates one TRUST_PROXY list entry: an IPv4/IPv6 address, optionally with a CIDR prefix. */
function isAddressOrCidr(entry: string): boolean {
  const [addr = '', prefix, ...rest] = entry.split('/')
  if (rest.length > 0) return false
  const family = isIP(addr)
  if (family === 0) return false
  if (prefix === undefined) return true
  if (!/^\d{1,3}$/.test(prefix)) return false
  return Number(prefix) <= (family === 4 ? 32 : 128)
}

const trustProxy = optional(
  z.string().optional().transform((raw, ctx): TrustProxy => {
    if (raw === undefined) return false
    const value = raw.trim()
    if (/^\d+$/.test(value)) {
      const hops = Number(value)
      return hops === 0 ? false : hops
    }
    const entries = value.split(',').map((e) => e.trim())
    const invalid = entries.filter((e) => !isAddressOrCidr(e))
    if (invalid.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          `TRUST_PROXY must be a hop count or a comma-separated list of proxy IPs/CIDRs ` +
          `(never "true"); invalid: ${invalid.map((e) => JSON.stringify(e)).join(', ')}`,
      })
      return z.NEVER
    }
    return entries
  }),
)

const clientIpHeader = optional(
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/, 'CLIENT_IP_HEADER must be a header name (letters, digits and -, at most 64)')
    .transform((name) => name.toLowerCase())
    .optional(),
).transform((v) => v ?? null)

const allowSignup = optional(
  z.enum(['true', 'false', '1', '0'], { error: 'ALLOW_SIGNUP must be true or false (or unset)' }).optional(),
).transform((v): SignupMode => (v === undefined ? 'first-user' : v === 'true' || v === '1' ? 'open' : 'closed'))

const port = optional(
  z
    .string()
    .regex(/^\d+$/, 'PORT must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(1, 'PORT must be 1-65535').max(65535, 'PORT must be 1-65535'))
    .default(3000),
)

/** UPLOAD_QUOTA_MB when unset: 1 GiB of attachments (images, PDF, GPX) per account. */
export const DEFAULT_UPLOAD_QUOTA_MB = 1024

const uploadQuotaMb = optional(
  z
    .string()
    .regex(/^\d+$/, 'UPLOAD_QUOTA_MB must be a non-negative integer (MB; 0 = no limit)')
    .transform(Number)
    .default(DEFAULT_UPLOAD_QUOTA_MB),
)

const logLevel = optional(
  z.enum(LOG_LEVELS, { error: `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}` }).default('info'),
)

const envSchema = z.object({
  SESSION_SECRET: secret('SESSION_SECRET'),
  SHARE_HMAC_KEY: secret('SHARE_HMAC_KEY'),
  PUBLIC_ORIGIN: publicOrigin,
  TRUST_PROXY: trustProxy,
  CLIENT_IP_HEADER: clientIpHeader,
  ALLOW_SIGNUP: allowSignup,
  DATA_DIR: optional(z.string().default(DEFAULT_DATA_DIR)),
  HOST: optional(z.string().default('0.0.0.0')),
  PORT: port,
  LOG_LEVEL: logLevel,
  UPLOAD_QUOTA_MB: uploadQuotaMb,
})

/**
 * Parses and validates the server configuration from environment variables.
 * Throws ConfigError listing every problem, so the server refuses to boot on bad config.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env)
  if (!result.success) {
    const problems = result.error.issues.map((i) => {
      const key = i.path.join('.')
      return i.message.startsWith(key) ? i.message : `${key}: ${i.message}`
    })
    throw configError(problems)
  }
  const e = result.data
  // both name a source of the client address; trusting two would let either one be forged
  if (e.CLIENT_IP_HEADER !== null && e.TRUST_PROXY !== false) {
    throw configError([
      'CLIENT_IP_HEADER and TRUST_PROXY cannot both be set: use CLIENT_IP_HEADER when the platform proxy ' +
        'sets that header on every request (e.g. Fly.io), TRUST_PROXY otherwise',
    ])
  }
  return {
    sessionSecret: e.SESSION_SECRET,
    shareHmacKey: e.SHARE_HMAC_KEY,
    publicOrigin: e.PUBLIC_ORIGIN,
    secureCookies: e.PUBLIC_ORIGIN.startsWith('https:'),
    trustProxy: e.TRUST_PROXY,
    clientIpHeader: e.CLIENT_IP_HEADER,
    signupMode: e.ALLOW_SIGNUP,
    dataDir: path.resolve(e.DATA_DIR),
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    uploadQuotaMb: e.UPLOAD_QUOTA_MB,
  }
}

function configError(problems: string[]): ConfigError {
  return new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
}
