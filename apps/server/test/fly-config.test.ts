import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the security and sizing invariants of the repo's fly.toml (Fly.io deployment). The file is
 * read as text with a minimal TOML reader (`[table]`, `[[table]]`, `key = value`) - enough for the
 * flat file we keep, and no TOML dependency just for one test.
 */

const FLY_TOML = path.resolve(import.meta.dirname, '../../../fly.toml')

interface Entry {
  /** table the key belongs to: '' for the top level, `env`, `http_service.checks`, … */
  table: string
  key: string
  /** raw value text, comment stripped */
  raw: string
}

interface ParsedToml {
  /** every table header's name, in file order (`[[vm]]` twice gives `vm` twice) */
  tables: { name: string }[]
  entries: Entry[]
}

/** Strips a trailing `# comment` that is not inside a quoted string. */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

function parseToml(text: string): ParsedToml {
  const tables: ParsedToml['tables'] = []
  const entries: Entry[] = []
  let table = ''
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = stripComment(rawLine).trim()
    if (line === '') return
    const header = /^\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?$/.exec(line)
    if (header) {
      table = header[1] ?? ''
      tables.push({ name: table })
      return
    }
    const kv = /^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.+)$/.exec(line)
    if (!kv) throw new Error(`fly.toml:${index + 1}: unsupported line: ${rawLine}`)
    const key = (kv[1] ?? '').replace(/^"|"$/g, '')
    entries.push({ table, key, raw: (kv[2] ?? '').trim() })
  })
  return { tables, entries }
}

/** Value of a TOML scalar: a quoted string, an integer or a boolean. */
function scalar(raw: string): string | number | boolean {
  const str = /^"((?:[^"\\]|\\.)*)"$/.exec(raw) ?? /^'([^']*)'$/.exec(raw)
  if (str) return str[1] ?? ''
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`unsupported TOML value: ${raw}`)
}

function values(toml: ParsedToml, table: string, key: string): (string | number | boolean)[] {
  return toml.entries.filter((e) => e.table === table && e.key === key).map((e) => scalar(e.raw))
}

/** The single value of `key` in `table`; fails when it is missing or set more than once. */
function value(toml: ParsedToml, table: string, key: string): string | number | boolean {
  const found = values(toml, table, key)
  expect(found, `[${table}] ${key}`).toHaveLength(1)
  return found[0] ?? ''
}

/** A Fly size such as "1gb" or "512mb" in MiB. */
function sizeMb(size: string): number {
  const m = /^(\d+)\s*(mb|gb)$/i.exec(size)
  if (!m) throw new Error(`unsupported size: ${size}`)
  return Number(m[1]) * (m[2]?.toLowerCase() === 'gb' ? 1024 : 1)
}

describe('stripComment / parseToml', () => {
  it('keeps a # inside a quoted value and drops a trailing comment', () => {
    const toml = parseToml('[env]\n  A = "x#y" # comment\n# whole line\n[[vm]]\n  memory = "512mb"\n')
    expect(value(toml, 'env', 'A')).toBe('x#y')
  })

  it('refuses lines it does not understand instead of silently skipping them', () => {
    expect(() => parseToml('ports = [\n  80,\n]')).toThrow(/unsupported line/)
  })
})

describe('fly.toml', () => {
  it('exists at the repo root', () => {
    expect(existsSync(FLY_TOML)).toBe(true)
  })

  const toml = existsSync(FLY_TOML) ? parseToml(readFileSync(FLY_TOML, 'utf8')) : { tables: [], entries: [] }

  it('serves only through Fly’s HTTP proxy on the app port, HTTPS only', () => {
    expect(toml.tables.filter((t) => t.name === 'http_service')).toHaveLength(1)
    expect(value(toml, 'http_service', 'internal_port')).toBe(3000)
    expect(value(toml, 'http_service', 'force_https')).toBe(true)
  })

  it('has no [[services]] port mapping and no ports entries (the proxy is the only client)', () => {
    expect(toml.tables.filter((t) => t.name === 'services' || t.name.startsWith('services.'))).toEqual([])
    expect(toml.entries.filter((e) => e.key === 'ports' || e.table.endsWith('.ports'))).toEqual([])
  })

  it('takes the client address from Fly-Client-IP and never trusts X-Forwarded-For hops', () => {
    expect(value(toml, 'env', 'CLIENT_IP_HEADER')).toBe('Fly-Client-IP')
    expect(toml.entries.filter((e) => e.key === 'TRUST_PROXY')).toEqual([])
  })

  it('mounts the volume at /data', () => {
    expect(value(toml, 'mounts', 'destination')).toBe('/data')
  })

  it('runs one always-on machine with 512 MB (argon2id needs it)', () => {
    const vms = toml.tables.filter((t) => t.name === 'vm')
    expect(vms).toHaveLength(1)
    expect(value(toml, 'vm', 'memory')).toBe('512mb')
    expect(value(toml, 'http_service', 'auto_stop_machines')).toBe('off')
    expect(value(toml, 'http_service', 'min_machines_running')).toBe(1)
  })

  it('health-checks /api/health', () => {
    expect(values(toml, 'http_service.checks', 'path')).toContain('/api/health')
  })

  it('keeps the upload quota at most 40% of the volume, so a restore fits next to the live data', () => {
    const volumeMb = sizeMb(String(value(toml, 'mounts', 'initial_size')))
    const quota = Number(value(toml, 'env', 'UPLOAD_QUOTA_MB'))
    expect(Number.isInteger(quota)).toBe(true)
    expect(quota).toBeGreaterThan(0)
    expect(quota).toBeLessThanOrEqual(Math.floor(volumeMb * 0.4))
  })

  it('holds no secrets or app-specific values (they go in with `fly secrets set`)', () => {
    const secretLike = toml.entries.filter(
      (e) =>
        ['SESSION_SECRET', 'SHARE_HMAC_KEY', 'PUBLIC_ORIGIN', 'RESTORE_ABORT'].includes(e.key) ||
        e.key.startsWith('BACKUP_S3_'),
    )
    expect(secretLike).toEqual([])
  })
})
