// Consistent snapshots of DATA_DIR (`runBackup`) and the uploads tarball format they use: a gzipped
// ustar archive whose entries are `uploads/<storage_name>`, written by `writeUploadsArchive` and read back
// (for a restore) by `readUploadsArchive`, which refuses anything that is not a plain upload file.
//
// The database is copied with SQLite's online backup API (safe against concurrent writers, WAL included),
// then the uploads referenced by an `attachments` row **in that copy** are packed into the tarball.
// Taking the database first and the files second is what keeps the pair consistent: every attachment row
// in the copy had its file fully written before the row was inserted, and the only files that can vanish
// afterwards are ones the sweep deletes, which by then have no references. Needs only DATA_DIR.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import Database from 'better-sqlite3'
import { BUSY_TIMEOUT_MS, DB_FILE_NAME } from '../db/index.js'
import { uploadsDir } from './attachments.js'

/** File name of the uploads tarball inside a backup directory; its entries are `uploads/<storage_name>`. */
export const UPLOADS_ARCHIVE_NAME = 'uploads.tar.gz'

/** An expected backup/restore failure (missing database, unsafe or corrupt archive, ...). */
export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

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
  /** Sum of the packed files' sizes (what a restore needs on disk for the uploads). */
  uploadBytes: number
  /** Storage names with an attachment row whose file was missing (they are not in the tarball). */
  missing: string[]
}

/** `2026-11-12T08:05:09.123Z` → `20261112-080509`. */
function stamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
}

/** Storage names are server-generated hex; anything else is never treated as a path. */
const SAFE_STORAGE_NAME = /^[A-Za-z0-9._-]{1,90}$/

/** A storage name that is safe to use as a single path component under `uploads/`. */
function isSafeStorageName(name: string): boolean {
  return SAFE_STORAGE_NAME.test(name) && name !== '.' && name !== '..'
}

const BLOCK = 512
const ARCHIVE_DIR = 'uploads/'

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
  field(`${octal(headerSum(header), 7)}\u0000 `, 148, 8)
  return header
}

/** The ustar header checksum: the byte sum with the checksum field itself counted as spaces. */
function headerSum(header: Buffer): number {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header.readUInt8(i)
  return sum
}

export interface UploadsArchiveSource {
  /** Storage name; becomes the entry `uploads/<storageName>`. */
  storageName: string
  /** Absolute path of the file to pack. */
  file: string
}

/**
 * Streams a tar archive of `entries`, one file in memory at a time (read asynchronously, so a scheduled
 * backup in the server never blocks requests while it reads attachments); counts the packed bytes.
 */
async function* tarStream(
  entries: UploadsArchiveSource[],
  mtime: number,
  counter: { bytes: number },
): AsyncGenerator<Buffer> {
  for (const { storageName, file } of entries) {
    const data = await readFile(file)
    counter.bytes += data.length
    yield tarHeader(`${ARCHIVE_DIR}${storageName}`, data.length, mtime)
    yield data
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad > 0) yield Buffer.alloc(pad)
  }
  yield Buffer.alloc(BLOCK * 2) // end-of-archive marker
}

/**
 * Writes the gzipped uploads tarball of `entries` to `archivePath` (which must not exist yet) and returns
 * the number of file bytes packed. Every storage name must be safe (`SAFE_STORAGE_NAME`).
 */
export async function writeUploadsArchive(
  entries: UploadsArchiveSource[],
  archivePath: string,
  mtime: number,
): Promise<{ bytes: number }> {
  for (const { storageName } of entries) {
    if (!isSafeStorageName(storageName)) throw new BackupError(`Unsafe storage name ${JSON.stringify(storageName)}`)
  }
  const counter = { bytes: 0 }
  await pipeline(Readable.from(tarStream(entries, mtime, counter)), createGzip(), createWriteStream(archivePath, { flags: 'wx' }))
  return { bytes: counter.bytes }
}

export interface ArchiveEntry {
  /** Storage name (the entry's path without `uploads/`), already checked to be a safe file name. */
  name: string
  /** Size in bytes. */
  size: number
}

/**
 * Called once per file, in archive order; `data` yields the file's bytes. Whatever the callback does not
 * read is skipped. The next entry is read only after the returned promise settles.
 */
export type ArchiveEntryHandler = (entry: ArchiveEntry, data: AsyncIterable<Buffer>) => Promise<void> | void

/** Pulls exact byte counts out of a chunked stream. */
class ChunkReader {
  private buf: Buffer = Buffer.alloc(0)

  constructor(private readonly chunks: AsyncIterator<Buffer>) {}

  /** The next chunk from the source, or `null` at its end. */
  private async pull(): Promise<Buffer | null> {
    const next = await this.chunks.next()
    return next.done ? null : next.value
  }

  /** Exactly `n` bytes, or `null` when the source ends before them. */
  async read(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      const chunk = await this.pull()
      if (chunk === null) return null
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    }
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  /** Between 1 and `max` bytes, or `null` at the end of the source. */
  async take(max: number): Promise<Buffer | null> {
    if (this.buf.length === 0) {
      const chunk = await this.pull()
      if (chunk === null) return null
      this.buf = chunk
    }
    const out = this.buf.subarray(0, Math.min(max, this.buf.length))
    this.buf = this.buf.subarray(out.length)
    return out
  }

  /** Reads and discards everything left (so a gzip trailer, and its CRC check, is reached). */
  async drain(): Promise<void> {
    this.buf = Buffer.alloc(0)
    while ((await this.pull()) !== null) {
      // discard
    }
  }
}

const truncated = () => new BackupError('Uploads archive is truncated')

/** A NUL-terminated header string field. */
function headerString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? length : end).toString('utf8')
}

/** A NUL/space-terminated octal header number. */
function headerOctal(header: Buffer, offset: number, length: number, what: string): number {
  const text = header.subarray(offset, offset + length).toString('ascii').replace(/[\0 ]+$/, '').replace(/^ +/, '')
  if (!/^[0-7]{1,12}$/.test(text)) throw new BackupError(`Uploads archive has a corrupt ${what} field`)
  return Number.parseInt(text, 8)
}

/** Parses and checks one (non-zero) header; returns the storage name and size of a plain upload file. */
function parseHeader(header: Buffer, seen: Set<string>): ArchiveEntry {
  if (header.toString('ascii', 257, 262) !== 'ustar') throw new BackupError('Uploads archive entry is not a ustar header')
  if (headerOctal(header, 148, 8, 'checksum') !== headerSum(header)) {
    throw new BackupError('Uploads archive header checksum mismatch')
  }
  const name = headerString(header, 0, 100)
  const prefix = headerString(header, 345, 155)
  const fullName = prefix ? `${prefix}/${name}` : name
  const type = header.toString('latin1', 156, 157)
  if (type !== '0' && type !== '\0') {
    throw new BackupError(`Uploads archive entry ${JSON.stringify(fullName)} is not a regular file`)
  }
  if (!fullName.startsWith(ARCHIVE_DIR)) {
    throw new BackupError(`Uploads archive entry ${JSON.stringify(fullName)} is outside uploads/`)
  }
  const storageName = fullName.slice(ARCHIVE_DIR.length)
  if (!isSafeStorageName(storageName)) {
    throw new BackupError(`Uploads archive entry ${JSON.stringify(fullName)} has an unsafe name`)
  }
  if (seen.has(storageName)) throw new BackupError(`Uploads archive has a duplicate entry ${JSON.stringify(fullName)}`)
  seen.add(storageName)
  return { name: storageName, size: headerOctal(header, 124, 12, 'size') }
}

/** The tar entries of a gunzipped stream, each handed to `onEntry`; returns the file count and bytes. */
async function readTar(reader: ChunkReader, onEntry: ArchiveEntryHandler): Promise<{ count: number; bytes: number }> {
  const seen = new Set<string>()
  let bytes = 0
  for (;;) {
    const header = await reader.read(BLOCK)
    if (header === null) throw truncated()
    if (header.every((byte) => byte === 0)) {
      // end-of-archive marker: two zero blocks
      const second = await reader.read(BLOCK)
      if (second === null) throw truncated()
      if (!second.every((byte) => byte === 0)) throw new BackupError('Uploads archive has a corrupt end marker')
      await reader.drain()
      return { count: seen.size, bytes }
    }
    const entry = parseHeader(header, seen)
    let remaining = entry.size
    async function* content(): AsyncGenerator<Buffer> {
      while (remaining > 0) {
        const chunk = await reader.take(remaining)
        if (chunk === null) throw truncated()
        remaining -= chunk.length
        yield chunk
      }
    }
    await onEntry(entry, content())
    while (remaining > 0) {
      const chunk = await reader.take(remaining)
      if (chunk === null) throw truncated()
      remaining -= chunk.length
    }
    const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK
    if (pad > 0 && (await reader.read(pad)) === null) throw truncated()
    bytes += entry.size
  }
}

/**
 * Reads a gzipped uploads tarball from `source`, handing every entry to `onEntry` in order. Only regular
 * files named `uploads/<SAFE_STORAGE_NAME>` are accepted, each name once; anything else, a truncated
 * archive or corrupt gzip throws a `BackupError` before the offending entry is handed out. The whole
 * source is consumed on success. An error of `source` itself is passed through unchanged.
 */
export async function readUploadsArchive(
  source: Readable,
  onEntry: ArchiveEntryHandler,
): Promise<{ count: number; bytes: number }> {
  const gunzip = createGunzip()
  let sourceError: unknown
  const onSourceError = (err: unknown) => {
    sourceError = err
    gunzip.destroy(err as Error)
  }
  source.on('error', onSourceError)
  source.pipe(gunzip)
  try {
    return await readTar(new ChunkReader(gunzip[Symbol.asyncIterator]()), onEntry)
  } catch (err) {
    if (err !== sourceError && isZlibError(err)) {
      throw new BackupError(`Uploads archive is not valid gzip: ${(err as Error).message}`)
    }
    throw err
  } finally {
    source.off('error', onSourceError)
    source.unpipe(gunzip)
    gunzip.destroy()
  }
}

function isZlibError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.startsWith('Z_')
}

/**
 * Writes `<outDir>/notes-backup-<timestamp>/{notes.db,uploads.tar.gz}`. The directory is assembled under
 * a `.partial` name and renamed at the end, so an interrupted run never looks like a finished backup.
 */
export async function runBackup({ dataDir, outDir, now = new Date() }: BackupOptions): Promise<BackupResult> {
  const sourcePath = path.join(dataDir, DB_FILE_NAME)
  if (!existsSync(sourcePath)) throw new BackupError(`No database at ${sourcePath} (check DATA_DIR)`)

  const parent = path.resolve(outDir ?? path.join(dataDir, 'backups'))
  const name = `notes-backup-${stamp(now)}`
  const dir = path.join(parent, name)
  if (existsSync(dir)) throw new BackupError(`${dir} already exists`)
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
      // a single self-contained file: no -wal/-shm next to the copy. The integrity check is synchronous:
      // in the server's scheduled backup it pauses requests for about as long as reading the database once
      copy.pragma('journal_mode = DELETE')
      const check = copy.pragma('integrity_check', { simple: true })
      if (check !== 'ok') throw new BackupError(`Backup copy failed its integrity check: ${String(check)}`)
      storageNames = copy.prepare('SELECT storage_name FROM attachments ORDER BY storage_name').pluck().all() as string[]
    } finally {
      copy.close()
    }

    const uploads = uploadsDir(dataDir)
    const entries: UploadsArchiveSource[] = []
    const missing: string[] = []
    for (const storageName of storageNames) {
      const file = path.join(uploads, storageName)
      if (!isSafeStorageName(storageName) || !existsSync(file)) missing.push(storageName)
      else entries.push({ storageName, file })
    }
    const { bytes } = await writeUploadsArchive(
      entries,
      path.join(work, UPLOADS_ARCHIVE_NAME),
      Math.floor(now.getTime() / 1000),
    )

    renameSync(work, dir)
    return {
      dir,
      dbPath: path.join(dir, DB_FILE_NAME),
      archivePath: path.join(dir, UPLOADS_ARCHIVE_NAME),
      files: entries.length,
      uploadBytes: bytes,
      missing,
    }
  } catch (err) {
    rmSync(work, { recursive: true, force: true })
    throw err
  }
}
