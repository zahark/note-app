// `npm run backup -- [outDir]`: writes a consistent snapshot of DATA_DIR while the server keeps running.
//
// The database is copied with SQLite's online backup API (safe against concurrent writers, WAL included),
// then the uploads referenced by an `attachments` row **in that copy** are packed into a gzipped tarball.
// Taking the database first and the files second is what keeps the pair consistent: every attachment row
// in the copy had its file fully written before the row was inserted, and the only files that can vanish
// afterwards are ones the sweep deletes, which by then have no references. Needs only DATA_DIR.
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import Database from 'better-sqlite3'
import { BUSY_TIMEOUT_MS, DB_FILE_NAME } from '../db/index.js'
import { uploadsDir } from '../services/attachments.js'
import { CliError, cliDataDir, runIfInvokedDirectly } from './common.js'

/** File name of the uploads tarball inside a backup directory; its entries are `uploads/<storage_name>`. */
export const UPLOADS_ARCHIVE_NAME = 'uploads.tar.gz'

export interface BackupOptions {
  /** DATA_DIR holding `notes.db` and `uploads/`. */
  dataDir: string
  /** Directory the timestamped backup directory is created in (default `DATA_DIR/backups`). */
  outDir?: string
  /** Clock for the directory name (tests). */
  now?: Date
}

export interface BackupResult {
  /** The backup directory: `<outDir>/notes-backup-<UTC timestamp>`. */
  dir: string
  /** `<dir>/notes.db`, a standalone (rollback-journal) SQLite file. */
  dbPath: string
  /** `<dir>/uploads.tar.gz`. */
  archivePath: string
  /** Number of files packed into the tarball. */
  files: number
  /** Storage names with an attachment row whose file was missing (they are not in the tarball). */
  missing: string[]
}

/** `2026-11-12T08:05:09.123Z` → `20261112-080509`. */
function stamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
}

/** Storage names are server-generated hex; anything else is never treated as a path. */
const SAFE_STORAGE_NAME = /^[A-Za-z0-9._-]{1,90}$/

const BLOCK = 512

/** One ustar header for a regular file `name` (≤ 100 bytes) of `size` bytes. */
function tarHeader(name: string, size: number, mtime: number): Buffer {
  const header = Buffer.alloc(BLOCK)
  const field = (value: string, offset: number, length: number) => header.write(value, offset, length, 'ascii')
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0')
  field(name, 0, 100)
  field(octal(0o600, 8), 100, 8) // mode
  field(octal(0, 8), 108, 8) // uid
  field(octal(0, 8), 116, 8) // gid
  field(octal(size, 12), 124, 12)
  field(octal(mtime, 12), 136, 12)
  field('        ', 148, 8) // checksum is computed with this field as spaces
  field('0', 156, 1) // regular file
  field('ustar\u0000', 257, 6)
  field('00', 263, 2)
  let sum = 0
  for (const byte of header) sum += byte
  field(`${octal(sum, 7)}\u0000 `, 148, 8)
  return header
}

/** Streams a tar archive of `entries` (archive name + absolute path), one file in memory at a time. */
async function* tarStream(entries: { name: string; file: string }[], mtime: number): AsyncGenerator<Buffer> {
  for (const { name, file } of entries) {
    const data = readFileSync(file)
    yield tarHeader(name, data.length, mtime)
    yield data
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad > 0) yield Buffer.alloc(pad)
  }
  yield Buffer.alloc(BLOCK * 2) // end-of-archive marker
}

/**
 * Writes `<outDir>/notes-backup-<timestamp>/{notes.db,uploads.tar.gz}`. The directory is assembled under
 * a `.partial` name and renamed at the end, so an interrupted run never looks like a finished backup.
 */
export async function runBackup({ dataDir, outDir, now = new Date() }: BackupOptions): Promise<BackupResult> {
  const sourcePath = path.join(dataDir, DB_FILE_NAME)
  if (!existsSync(sourcePath)) throw new CliError(`No database at ${sourcePath} (check DATA_DIR)`)

  const parent = path.resolve(outDir ?? path.join(dataDir, 'backups'))
  const name = `notes-backup-${stamp(now)}`
  const dir = path.join(parent, name)
  if (existsSync(dir)) throw new CliError(`${dir} already exists`)
  const work = path.join(parent, `.${name}.partial`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  try {
    const dbPath = path.join(work, DB_FILE_NAME)
    // opened without running migrations: a backup must copy the database exactly as it is
    const source = new Database(sourcePath, { fileMustExist: true })
    try {
      source.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
      await source.backup(dbPath)
    } finally {
      source.close()
    }

    let storageNames: string[]
    const copy = new Database(dbPath)
    try {
      // a single self-contained file: no -wal/-shm next to the copy
      copy.pragma('journal_mode = DELETE')
      const check = copy.pragma('integrity_check', { simple: true })
      if (check !== 'ok') throw new CliError(`Backup copy failed its integrity check: ${String(check)}`)
      storageNames = copy.prepare('SELECT storage_name FROM attachments ORDER BY storage_name').pluck().all() as string[]
    } finally {
      copy.close()
    }

    const uploads = uploadsDir(dataDir)
    const entries: { name: string; file: string }[] = []
    const missing: string[] = []
    for (const storageName of storageNames) {
      const file = path.join(uploads, storageName)
      if (!SAFE_STORAGE_NAME.test(storageName) || !existsSync(file)) missing.push(storageName)
      else entries.push({ name: `uploads/${storageName}`, file })
    }
    const archivePath = path.join(work, UPLOADS_ARCHIVE_NAME)
    await pipeline(
      Readable.from(tarStream(entries, Math.floor(now.getTime() / 1000))),
      createGzip(),
      createWriteStream(archivePath, { flags: 'wx' }),
    )

    renameSync(work, dir)
    return {
      dir,
      dbPath: path.join(dir, DB_FILE_NAME),
      archivePath: path.join(dir, UPLOADS_ARCHIVE_NAME),
      files: entries.length,
      missing,
    }
  } catch (err) {
    rmSync(work, { recursive: true, force: true })
    throw err
  }
}

async function main(args: string[]): Promise<void> {
  if (args.length > 1) throw new CliError('Usage: npm run backup -- [outDir]')
  const dataDir = cliDataDir()
  // npm runs scripts from apps/server; a relative outDir means relative to where the operator typed it
  const outDir = args[0] === undefined ? undefined : path.resolve(process.env.INIT_CWD ?? process.cwd(), args[0])
  const result = await runBackup({ dataDir, outDir })
  for (const name of result.missing) console.warn(`warning: attachment file ${name} is missing; not in the archive`)
  console.log(`Backup written to ${result.dir} (${DB_FILE_NAME} + ${UPLOADS_ARCHIVE_NAME}, ${result.files} files)`)
}

runIfInvokedDirectly(import.meta.url, main)
