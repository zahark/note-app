import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'

/** Directory holding the numbered `NNN_name.sql` migrations (copied next to the compiled JS on build). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url))

const MIGRATION_FILE = /^(\d+)_[\w-]+\.sql$/

export interface Migration {
  version: number
  name: string
  sql: string
}

/** Reads `NNN_name.sql` files from `dir`, sorted by version. Rejects duplicate version numbers. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter((m): m is { file: string; match: RegExpExecArray } => m.match !== null)
    .map(({ file, match }) => ({
      version: Number(match[1]),
      name: file,
      sql: readFileSync(path.join(dir, file), 'utf8'),
    }))
    .sort((a, b) => a.version - b.version)

  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1]
    const cur = migrations[i]
    if (prev && cur && prev.version === cur.version) {
      throw new Error(`Duplicate migration version ${cur.version}: ${prev.name}, ${cur.name}`)
    }
  }
  return migrations
}

/**
 * Applies every migration in `dir` not yet recorded in `schema_migrations`, in version order.
 * Each migration runs in its own transaction together with its bookkeeping row, so a failing
 * migration leaves no partial schema behind. Safe to call on every boot. Returns the versions applied.
 */
export function migrate(db: Database, dir: string = MIGRATIONS_DIR): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`)

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .pluck()
      .all()
      .map((v) => Number(v)),
  )
  const record = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')

  const done: number[] = []
  for (const m of loadMigrations(dir)) {
    if (applied.has(m.version)) continue
    db.transaction(() => {
      db.exec(m.sql)
      record.run(m.version, m.name)
    })()
    done.push(m.version)
  }
  return done
}
