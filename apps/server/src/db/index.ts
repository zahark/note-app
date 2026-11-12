import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './migrate.js'

export type Db = Database.Database

/** File name of the SQLite database inside DATA_DIR. */
export const DB_FILE_NAME = 'notes.db'

/** How long a connection waits for another connection's lock before failing with SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000

/**
 * Opens a SQLite database (a file path, or `':memory:'` for tests), applies the connection
 * pragmas (WAL, foreign keys ON) and runs pending migrations.
 */
export function openDb(filename: string): Db {
  const db = new Database(filename)
  try {
    // WAL is a no-op for in-memory databases (they report 'memory'), which is fine for tests.
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.pragma('synchronous = NORMAL')
    migrate(db)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

/** Opens (creating if needed) `DATA_DIR/notes.db`. */
export function openDataDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true })
  return openDb(path.join(dataDir, DB_FILE_NAME))
}
