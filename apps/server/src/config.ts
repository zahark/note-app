import { isIP } from 'node:net'
import path from 'node:path'
import { z } from 'zod'

/** Minimum length for SESSION_SECRET and SHARE_HMAC_KEY. */
export const MIN_SECRET_LENGTH = 32

/**
 * Parsed TRUST_PROXY value, passed straight to Fastify's `trustProxy`:
 * `false` trusts nothing, a number trusts that many hops, a list trusts those proxy addresses/CIDRs.
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
  allowSignup: boolean
  /** Absolute path to the directory holding the SQLite database and uploads. */
  dataDir: string
  host: string
  port: number
}

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

const allowSignup = optional(
  z
    .enum(['true', 'false', '1', '0'], { error: 'ALLOW_SIGNUP must be true or false' })
    .default('true'),
).transform((v) => v === 'true' || v === '1')

const port = optional(
  z
    .string()
    .regex(/^\d+$/, 'PORT must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(1, 'PORT must be 1-65535').max(65535, 'PORT must be 1-65535'))
    .default(3000),
)

const envSchema = z.object({
  SESSION_SECRET: secret('SESSION_SECRET'),
  SHARE_HMAC_KEY: secret('SHARE_HMAC_KEY'),
  PUBLIC_ORIGIN: publicOrigin,
  TRUST_PROXY: trustProxy,
  ALLOW_SIGNUP: allowSignup,
  DATA_DIR: optional(z.string().default('./data')),
  HOST: optional(z.string().default('0.0.0.0')),
  PORT: port,
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
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
  }
  const e = result.data
  return {
    sessionSecret: e.SESSION_SECRET,
    shareHmacKey: e.SHARE_HMAC_KEY,
    publicOrigin: e.PUBLIC_ORIGIN,
    secureCookies: e.PUBLIC_ORIGIN.startsWith('https:'),
    trustProxy: e.TRUST_PROXY,
    allowSignup: e.ALLOW_SIGNUP,
    dataDir: path.resolve(e.DATA_DIR),
    host: e.HOST,
    port: e.PORT,
  }
}
